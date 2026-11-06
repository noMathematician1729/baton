// Client-side simulation of a BATON job. No network calls; mirrors the protocol in context.md.

export type NodeStatus = "booting" | "live" | "working" | "recovering" | "dead" | "done";
export type Role = "job" | "primary" | "sub";
export type LogKind = "query" | "response" | "write" | "ens" | "chain" | "x402" | "ttl" | "key" | "sys" | "error";
export type Service = "arkiv" | "ens" | "chain" | "x402";

export interface TreeNode {
  id: string;
  label: string;
  ens: string;
  parent: string | null;
  role: Role;
  status: NodeStatus;
  worker?: string;
  epoch?: number;
  bornAt: number;
  diedAt?: number;
  cause?: string;
  records: Record<string, string>;
}

export interface LogLine { id: number; t: number; kind: LogKind; actor: string; text: string; detail?: string }

export interface Entity {
  key: string;
  name: string;
  kind: "job" | "claim" | "checkpoint" | "chunk";
  owner: string;
  ttl: number;
  createdAt: number;
  expiresAt: number;
  status: "live" | "expired" | "released";
}

export type StepState = "todo" | "doing" | "done" | "fail";
export interface Notice { id: number; title: string; subtitle?: string; tone: "takeover" | "warn" | "done" | "info"; steps: { label: string; state: StepState }[]; closed: boolean }

export interface Worker { id: string; name: string; addr: string; host: string; state: "idle" | "standby" | "active" | "offline" }
export interface Milestone { index: number; label: string; reward: number; status: "pending" | "running" | "accepted"; by?: string }
interface ServiceOp { id: string; milestone: number; by: string; status: "settled" | "reused"; receipt: string; amount: number }

export interface SimConfig { job: string; primary: string; standby: string[]; expected: number }

export interface SimState {
  phase: "setup" | "running" | "takeover" | "halted" | "complete";
  clock: number;
  speed: number;
  paused: boolean;
  config: SimConfig;
  nodes: TreeNode[];
  logs: LogLine[];
  entities: Entity[];
  notices: Notice[];
  epoch: number;
  head: number;
  milestones: Milestone[];
  credits: Record<string, number>;
  withdrawn: Record<string, number>;
  budget: { cap: number; spent: number; price: number };
  workers: Worker[];
  activeWorker?: string;
  selected?: string;
  touches: Record<Service, number>;
}

class Killed extends Error {}

const SIM_SECONDS_PER_REAL = 2;
const LONG_TTL = 15_768_000; // ~182.5 days
const BLOCK0 = 9_412_200;

const WORKERS: Worker[] = [
  { id: "a", name: "Worker A", addr: "0xA11c…3eF1", host: "host-sfo-1", state: "idle" },
  { id: "b", name: "Worker B", addr: "0xB0b5…91c2", host: "host-fra-2", state: "idle" },
  { id: "c", name: "Worker C", addr: "0xC4a7…0d9e", host: "host-sin-1", state: "idle" },
  { id: "d", name: "Worker D", addr: "0xD3e1…77ab", host: "host-nyc-3", state: "idle" },
];

const MILESTONES: Omit<Milestone, "status">[] = [
  { index: 1, label: "Batch 1 · ingest", reward: 3 },
  { index: 2, label: "Batch 2 · transform", reward: 3 },
  { index: 3, label: "Batch 3 · verify & deliver", reward: 4 },
];

const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const short = (h: string) => `0x${h.slice(0, 4)}…${h.slice(-3)}`;

export const fmtClock = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
};
export const fmtTtl = (s: number) => {
  if (s > 86_400) return `${(s / 86_400).toFixed(1)} d`;
  if (s <= 0) return "0s";
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s` : `${Math.ceil(s)}s`;
};

function initialState(): SimState {
  return {
    phase: "setup",
    clock: 0,
    speed: 1,
    paused: false,
    config: { job: "baton.eth", primary: "a", standby: ["b", "c"], expected: 40 },
    nodes: [],
    logs: [],
    entities: [],
    notices: [],
    epoch: 0,
    head: 0,
    milestones: MILESTONES.map((m) => ({ ...m, status: "pending" })),
    credits: {},
    withdrawn: {},
    budget: { cap: 1.5, spent: 0, price: 0.25 },
    workers: WORKERS.map((w) => ({ ...w })),
    touches: { arkiv: 0, ens: 0, chain: 0, x402: 0 },
  };
}

export class BatonSim {
  state: SimState = initialState();
  private listeners = new Set<() => void>();
  private queue: { at: number; run: () => void }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private run = 0;
  private logId = 0;
  private noticeId = 0;
  private ops: ServiceOp[] = [];
  private pendingTakeover: string | null = null;
  private handled = new Set<string>();
  version = 0;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  private emit() { this.version++; this.listeners.forEach((l) => l()); }

  // ---------- public controls ----------
  configure(patch: Partial<SimConfig>) {
    this.state.config = { ...this.state.config, ...patch };
    this.emit();
  }

  setSpeed(speed: number) { this.state.speed = speed; this.emit(); }
  togglePause() { this.state.paused = !this.state.paused; this.emit(); }
  select(id?: string) { this.state.selected = id; this.emit(); }

  reset() {
    this.run++;
    this.queue = [];
    this.ops = [];
    this.handled.clear();
    this.pendingTakeover = null;
    const { config, speed } = this.state;
    this.state = { ...initialState(), config, speed };
    this.stopTimer();
    this.emit();
  }

  start() {
    this.reset();
    const s = this.state;
    const { job, primary, standby } = s.config;
    s.phase = "running";
    s.workers.forEach((w) => { w.state = w.id === primary ? "active" : standby.includes(w.id) ? "standby" : "idle"; });
    this.startTimer();
    void this.boot(job, primary);
  }

  kill(id: string) {
    const node = this.node(id);
    if (!node || node.role === "job" || node.status === "dead" || this.state.phase === "complete") return;
    this.markDead(id, "killed");
    if (node.role === "primary") {
      const w = this.worker(node.worker!);
      w.state = "offline";
      this.log("error", node.label, `stopped heartbeating — simulated crash`, `last renewal of claim/${node.label} at ${fmtClock(this.claimOf(node)?.createdAt ?? 0)}`);
      const claim = this.claimOf(node);
      const left = claim ? claim.expiresAt - this.state.clock : 0;
      this.notice({
        title: `${node.ens} went silent`,
        subtitle: `Its Arkiv claim expires in ${fmtTtl(left)}. Nobody will renew it.`,
        tone: "warn",
        steps: ["Agent offline", "Waiting for Arkiv claim timeout", "Revoke ENS grant", "Mint successor name", "Recover from Arkiv", "Take over at new epoch"],
      }, 1);
      if (!claim || claim.status !== "live") void this.takeover(node, "died before writing a claim");
    } else {
      this.log("error", node.label, `subagent crashed`, node.ens);
      void this.respawnSub(node);
    }
    this.emit();
  }

  revoke(id: string) {
    const node = this.node(id);
    if (!node || node.role !== "primary" || this.handled.has(id)) return;
    if (node.status !== "dead") {
      this.markDead(id, "revoked by buyer");
      this.worker(node.worker!).state = "offline";
    }
    const claim = this.claimOf(node);
    if (claim && claim.status === "live") {
      claim.status = "released";
      this.log("ttl", "buyer", `release claim/${node.label}`, "buyer override — no need to wait for timeout");
    }
    void this.takeover(node, "buyer revoked");
    this.emit();
  }

  spawnSub(parentId: string) {
    const parent = this.node(parentId);
    if (!parent || parent.role === "job" || parent.status === "dead" || this.state.phase === "complete") return;
    const n = this.state.nodes.filter((x) => x.parent === parentId).length + 1;
    void this.mintSub(parent, `worker-${n}`, true);
  }

  addStandby() {
    const idle = this.state.workers.find((w) => w.state === "idle");
    if (!idle) return;
    idle.state = "standby";
    this.log("sys", "buyer", `${idle.name} admitted to standby pool`, `${idle.addr} · ${idle.host}`);
    if (this.pendingTakeover) {
      const old = this.node(this.pendingTakeover)!;
      this.pendingTakeover = null;
      this.handled.delete(old.id);
      void this.takeover(old, "standby available");
    }
    this.emit();
  }

  // ---------- engine ----------
  private startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => this.tick(0.1), 100);
  }
  private stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private ticking = false;

  // Advance event-by-event so each scripted step gets its exact sim time, regardless of speed.
  private async tick(realDt: number) {
    const s = this.state;
    if (s.paused || this.ticking) return;
    this.ticking = true;
    const token = this.run;
    const target = s.clock + realDt * SIM_SECONDS_PER_REAL * s.speed;
    for (let guard = 0; guard < 500; guard++) {
      this.queue.sort((a, b) => a.at - b.at);
      const nextEvent = this.queue[0]?.at ?? Infinity;
      const nextExpiry = Math.min(...s.entities.filter((e) => e.status === "live").map((e) => e.expiresAt), Infinity);
      const next = Math.min(nextEvent, nextExpiry);
      if (next > target) break;
      s.clock = Math.max(s.clock, next);
      if (nextEvent <= nextExpiry) this.queue.shift()!.run();
      else this.expire();
      for (let i = 0; i < 6; i++) await Promise.resolve();
      if (token !== this.run) { this.ticking = false; return; }
    }
    s.clock = Math.max(s.clock, target);
    this.expire();
    this.ticking = false;
    this.emit();
  }

  private expire() {
    const s = this.state;
    for (const e of s.entities) {
      if (e.status === "live" && e.expiresAt <= s.clock) {
        e.status = "expired";
        this.touch("arkiv");
        this.log("query", "job watcher", `query claim/${e.name}`, `not returned after expiresAtBlock ${this.block(e.expiresAt)} — Arkiv emits no expiry event`);
        if (e.kind === "claim") this.onClaimExpired(e);
      }
    }
  }

  private wait(sec: number, agentId?: string) {
    const token = this.run;
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        at: this.state.clock + sec,
        run: () => {
          if (token !== this.run) return;
          if (agentId && this.node(agentId)?.status === "dead") reject(new Killed());
          else resolve();
        },
      });
    });
  }

  private block(t = this.state.clock) { return BLOCK0 + Math.floor(t / 2); }
  private node(id: string) { return this.state.nodes.find((n) => n.id === id); }
  private worker(id: string) { return this.state.workers.find((w) => w.id === id)!; }
  private claimOf(node: TreeNode) { return this.state.entities.find((e) => e.kind === "claim" && e.owner === node.id && e.status === "live") ?? this.state.entities.filter((e) => e.kind === "claim" && e.owner === node.id).at(-1); }
  private touch(svc: Service) { this.state.touches[svc] = performance.now(); }

  private log(kind: LogKind, actor: string, text: string, detail?: string) {
    const s = this.state;
    s.logs.push({ id: ++this.logId, t: s.clock, kind, actor, text, detail });
    if (s.logs.length > 600) s.logs.splice(0, s.logs.length - 600);
    if (kind === "query" || kind === "response" || kind === "write" || kind === "ttl") this.touch("arkiv");
    if (kind === "ens") this.touch("ens");
    if (kind === "chain") this.touch("chain");
    if (kind === "x402") this.touch("x402");
  }

  private notice(n: { title: string; subtitle?: string; tone: Notice["tone"]; steps: string[] }, doneCount = 0) {
    this.state.notices.forEach((x) => { x.closed = true; });
    const notice: Notice = {
      id: ++this.noticeId, title: n.title, subtitle: n.subtitle, tone: n.tone, closed: false,
      steps: n.steps.map((label, i) => ({ label, state: i < doneCount ? "done" : i === doneCount ? "doing" : "todo" })),
    };
    this.state.notices.push(notice);
    return notice;
  }
  private current() { return this.state.notices.find((n) => !n.closed); }
  private step(label: string, state: StepState = "done") {
    const n = this.current();
    if (!n) return;
    const i = n.steps.findIndex((x) => x.label === label);
    if (i < 0) return;
    n.steps[i].state = state;
    if (state === "done" && n.steps[i + 1] && n.steps[i + 1].state === "todo") n.steps[i + 1].state = "doing";
  }

  private addNode(n: Omit<TreeNode, "bornAt" | "records"> & { records?: Record<string, string> }) {
    const node: TreeNode = { ...n, bornAt: this.state.clock, records: n.records ?? {} };
    this.state.nodes.push(node);
    return node;
  }

  private markDead(id: string, cause: string) {
    const kill = (nid: string, c: string) => {
      const n = this.node(nid);
      if (!n || n.status === "dead") return;
      n.status = "dead";
      n.diedAt = this.state.clock;
      n.cause = c;
      this.state.nodes.filter((x) => x.parent === nid).forEach((x) => kill(x.id, "parent died"));
    };
    kill(id, cause);
  }

  private createEntity(name: string, kind: Entity["kind"], owner: string, ttl: number, actor: string, attrs: Record<string, string | number>, bytes: string) {
    const key = hex(64);
    const e: Entity = { key, name, kind, owner, ttl, createdAt: this.state.clock, expiresAt: this.state.clock + ttl, status: "live" };
    this.state.entities.push(e);
    const attrStr = Object.entries(attrs).map(([k, v]) => `${k}: ${typeof v === "number" ? v : `"${v}"`}`).join(", ");
    this.log("write", actor, `arkiv.createEntity({ ${attrStr} })`, `payload ${bytes} · expiresIn ${fmtTtl(ttl)}`);
    return e;
  }

  // ---------- scripted flows ----------
  private async boot(job: string, primary: string) {
    const s = this.state;
    try {
      this.log("sys", "buyer", `new job ${job}`, `3 milestones · rewards 10 tUSD · service budget ${s.budget.cap} HBAR`);
      await this.wait(1);
      this.log("chain", "buyer", `escrow.fundJob(${job}, 10 tUSD)`, `tx ${short(hex(64))} · confirmed`);
      const root = this.addNode({ id: "job", label: job, ens: job, parent: null, role: "job", status: "live", records: { owner: "buyer 0xBuy3…r001", resolver: "BatonJobResolver", "baton.milestones": "3" } });
      this.log("ens", "buyer", `ENSv2 · ${job} owned by buyer, dedicated resolver set`, `resolver ${short(hex(40))}`);
      await this.wait(1.5);
      this.createEntity(`job/${job}`, "job", root.id, LONG_TTL, "buyer", { type: "job", job, milestones: 3 }, "2.4 KiB ciphertext");
      await this.wait(1.5);
      await this.bringUpPrimary(primary, false);
    } catch (e) {
      if (!(e instanceof Killed)) throw e;
    }
  }

  private async bringUpPrimary(workerId: string, recovering: boolean, oldNode?: TreeNode) {
    const s = this.state;
    const job = s.config.job;
    const w = this.worker(workerId);
    const label = `agent-${w.id}`;
    const ens = `${label}.${job}`;
    this.log("ens", "buyer", `setSubnodeOwner(${job}, "${label}") → ${w.addr}`, `scoped grant: job=${job} · role=${recovering ? "successor" : "primary"}`);
    if (recovering) this.step("Mint successor name");
    const node = this.addNode({
      id: `n-${label}`, label, ens, parent: "job", role: "primary", status: recovering ? "recovering" : "booting", worker: w.id, epoch: s.epoch + 1,
      records: { "baton.worker": w.addr, "baton.host": w.host, "baton.grant": "active", "baton.epoch": String(s.epoch + 1) },
    });
    w.state = "active";
    s.activeWorker = w.id;
    this.emit();

    try {
      if (recovering && oldNode) {
        await this.recover(node, oldNode);
      } else {
        await this.wait(1.2, node.id);
        s.epoch = 1;
        this.log("chain", "buyer", `escrow.assignWorker(${job}, ${w.addr}, epoch 1)`, `checks live ENS grant on ${ens} · ok`);
        await this.wait(1, node.id);
        this.createEntity(`claim/${label}`, "claim", node.id, s.config.expected, label, { type: "claim", job, worker: ens, epoch: s.epoch }, "312 B");
        this.log("ttl", label, `claim deadline set to ${fmtTtl(s.config.expected)} — expected time per milestone`, "renewed at every accepted checkpoint; if it lapses the job fails over");
        node.status = "live";
      }
      await this.wait(1, node.id);
      await this.mintSub(node, "fetch", false);
      const fetch = this.state.nodes.find((n) => n.parent === node.id && n.label === "fetch");
      if (fetch) await this.mintSub(fetch, "shard-1", false);
      await this.mintSub(node, "compute", false);
      if (node.status === "dead") throw new Killed();

      for (let m = s.head; m < s.milestones.length; m++) {
        await this.milestone(node, m);
      }
      await this.complete(node);
    } catch (e) {
      if (!(e instanceof Killed)) throw e;
    }
  }

  private async mintSub(parent: TreeNode, label: string, manual: boolean) {
    if (parent.status === "dead") return;
    const ens = `${label}.${parent.ens}`;
    const id = `n-${ens}`;
    if (this.node(id) && this.node(id)!.status !== "dead") return;
    const finalId = this.node(id) ? `${id}-${hex(4)}` : id;
    this.log("ens", parent.label, `setSubnodeOwner(${parent.ens}, "${label}")`, manual ? "subagent requested from console" : "sub-registry for delegated work");
    const node = this.addNode({ id: finalId, label, ens, parent: parent.id, role: "sub", status: "booting", worker: parent.worker, records: { "baton.parent": parent.ens, "baton.scope": label } });
    this.emit();
    await this.wait(1.2);
    if (node.status === "booting") node.status = "live";
  }

  private async respawnSub(dead: TreeNode) {
    const parent = dead.parent ? this.node(dead.parent) : undefined;
    if (!parent || parent.status === "dead") return;
    try {
      await this.wait(1.5, parent.id);
      this.log("query", parent.label, `arkiv.query('type = "sub-state" && owner = "${dead.ens}"')`);
      await this.wait(1, parent.id);
      this.log("response", "arkiv", `200 · 1 entity · last write ${fmtClock(Math.max(0, this.state.clock - 9))}`, JSON.stringify({ entityKey: short(hex(64)), attributes: { type: "sub-state", owner: dead.ens, cursor: Math.floor(Math.random() * 400) } }, null, 2));
      const base = dead.label.replace(/-r\d+$/, "");
      const gen = this.state.nodes.filter((n) => n.parent === parent.id && n.label.startsWith(base)).length + 1;
      await this.mintSub(parent, `${base}-r${gen}`, false);
      this.log("sys", parent.label, `replacement ${base}-r${gen}.${parent.ens} resumed from Arkiv cursor`);
    } catch (e) {
      if (!(e instanceof Killed)) throw e;
    }
  }

  private subs(node: TreeNode) {
    const out: TreeNode[] = [];
    const walk = (id: string) => this.state.nodes.filter((n) => n.parent === id && n.status !== "dead").forEach((n) => { out.push(n); walk(n.id); });
    walk(node.id);
    return out;
  }
  private setWorking(node: TreeNode, labels: string[]) {
    this.subs(node).forEach((n) => { n.status = labels.some((l) => n.label.startsWith(l)) ? "working" : "live"; });
    if (node.status !== "dead") node.status = "working";
  }

  private async milestone(node: TreeNode, m: number) {
    const s = this.state;
    const job = s.config.job;
    const ms = s.milestones[m];
    const id = node.id;
    const label = node.label;
    ms.status = "running";
    this.log("sys", label, `starting ${ms.label}`, `reward ${ms.reward} tUSD on acceptance`);
    this.setWorking(node, ["fetch", "shard"]);
    await this.wait(2, id);

    const prior = this.ops.find((o) => o.milestone === ms.index);
    if (prior) {
      this.log("x402", label, `gateway.reconcile(op_m${ms.index})`, `operation started by ${this.worker(prior.by).name} before takeover`);
      await this.wait(1.5, id);
      this.log("response", "gateway", `SETTLED · receipt ${prior.receipt} · output stored in Arkiv`, "reusing paid output — not paying twice");
      prior.status = "reused";
      await this.wait(1, id);
    } else {
      this.log("x402", label, `GET gateway/svc/market-data?batch=${ms.index}`, `op_m${ms.index} · reserve ≤ ${s.budget.price} HBAR`);
      await this.wait(1.2, id);
      this.log("response", "provider", `402 Payment Required · scheme exact · ${s.budget.price} HBAR · network hedera-testnet`);
      await this.wait(1.2, id);
      const receipt = `rcpt_${hex(6)}`;
      s.budget.spent = +(s.budget.spent + s.budget.price).toFixed(2);
      this.ops.push({ id: `op_m${ms.index}`, milestone: ms.index, by: node.worker!, status: "settled", receipt, amount: s.budget.price });
      this.log("x402", "gateway", `settled ${s.budget.price} HBAR · ${receipt}`, `ledger: op_m${ms.index} SETTLED · budget ${s.budget.spent}/${s.budget.cap} HBAR`);
      await this.wait(1.5, id);
    }

    this.setWorking(node, ["compute"]);
    await this.wait(3, id);
    this.createEntity(`chunk/m${ms.index}/0`, "chunk", id, LONG_TTL, label, { type: "chunk", job, milestone: ms.index, seq: 0 }, "96.0 KiB AES-GCM");
    await this.wait(0.8, id);
    this.createEntity(`chunk/m${ms.index}/1`, "chunk", id, LONG_TTL, label, { type: "chunk", job, milestone: ms.index, seq: 1 }, "41.7 KiB AES-GCM");
    await this.wait(0.8, id);
    const digest = hex(64);
    this.createEntity(`checkpoint/m${ms.index}`, "checkpoint", id, LONG_TTL, label, { type: "checkpoint", job, epoch: s.epoch, milestone: ms.index }, `3.1 KiB manifest · digest ${short(digest)}`);
    await this.wait(1, id);
    this.log("key", label, `signOffer(EIP-712 MilestoneOffer)`, JSON.stringify({ job, epoch: s.epoch, milestone: ms.index, head: short(digest), worker: this.worker(node.worker!).addr }, null, 2));
    await this.wait(1.2, id);
    this.log("query", "buyer", `arkiv.getEntity(checkpoint/m${ms.index}) + 2 chunks`, "buyer reads back ciphertext before accepting");
    await this.wait(1, id);
    this.log("response", "arkiv", `200 · digests match · retention covers job deadline`);
    await this.wait(1, id);
    s.head = ms.index;
    ms.status = "accepted";
    ms.by = node.worker;
    s.credits[node.worker!] = (s.credits[node.worker!] ?? 0) + ms.reward;
    this.log("chain", "buyer", `escrow.acceptMilestone(${job}, m${ms.index}, offer)`, `head → ${short(digest)} · credited ${this.worker(node.worker!).name} +${ms.reward} tUSD`);
    const claim = this.claimOf(node);
    if (claim && claim.status === "live") {
      claim.createdAt = s.clock;
      claim.expiresAt = s.clock + s.config.expected;
      this.log("ttl", label, `arkiv.extendEntity(claim/${label}, { expiresIn: ${s.config.expected}s })`, `new expiresAtBlock ${this.block(claim.expiresAt)}`);
    }
    this.setWorking(node, []);
    node.status = "live";
    await this.wait(1.5, id);
  }

  private onClaimExpired(e: Entity) {
    const node = this.node(e.owner);
    if (!node || node.role !== "primary" || this.state.phase === "complete") return;
    if (node.status !== "dead") {
      this.markDead(node.id, "timed out");
      this.worker(node.worker!).state = "offline";
      this.log("error", "buyer", `${node.ens} exceeded its declared deadline`, "claim lapsed while still running — treated as timed out");
      this.notice({ title: `${node.ens} timed out`, subtitle: "It declared less time than the milestone needed.", tone: "warn", steps: ["Agent offline", "Waiting for Arkiv claim timeout", "Revoke ENS grant", "Mint successor name", "Recover from Arkiv", "Take over at new epoch"] }, 2);
    } else {
      this.step("Waiting for Arkiv claim timeout");
    }
    void this.takeover(node, "claim expired");
  }

  private async takeover(old: TreeNode, reason: string) {
    if (this.handled.has(old.id)) return;
    this.handled.add(old.id);
    const s = this.state;
    const job = s.config.job;
    s.phase = "takeover";
    if (!this.current() || this.current()!.tone !== "warn") {
      this.notice({ title: `Takeover · ${old.ens}`, subtitle: reason, tone: "takeover", steps: ["Agent offline", "Waiting for Arkiv claim timeout", "Revoke ENS grant", "Mint successor name", "Recover from Arkiv", "Take over at new epoch"] }, 2);
    } else {
      this.step("Agent offline");
      this.step("Waiting for Arkiv claim timeout");
    }
    const cur = this.current();
    if (cur) { cur.tone = "takeover"; cur.title = `Takeover · ${old.ens}`; cur.subtitle = reason; }

    try {
      await this.wait(1.2);
      old.records["baton.grant"] = "revoked";
      this.log("ens", "buyer", `revoke grant ${old.ens}`, "escrow and gateway will reject this name from now on");
      await this.wait(0.8);
      this.log("x402", "gateway", `admissions paused for ${job}; draining in-flight ops`, `${this.ops.filter((o) => o.status === "settled").length} settled op(s) on ledger`);
      this.step("Revoke ENS grant");
      await this.wait(1.2);

      const next = s.workers.find((w) => w.state === "standby");
      if (!next) {
        s.phase = "halted";
        this.pendingTakeover = old.id;
        this.step("Mint successor name", "fail");
        const n = this.current();
        if (n) { n.tone = "warn"; n.subtitle = "No standby worker available. Job paused — add a standby to resume before the cutoff."; }
        this.log("error", "buyer", "no eligible standby worker — job paused", "escrow.pause() · resume possible before cutoff");
        this.emit();
        return;
      }
      await this.bringUpPrimary(next.id, true, old);
    } catch (e) {
      if (!(e instanceof Killed)) throw e;
    }
  }

  private async recover(node: TreeNode, old: TreeNode) {
    const s = this.state;
    const job = s.config.job;
    const id = node.id;
    const label = node.label;
    await this.wait(1.2, id);
    const headName = s.head > 0 ? `checkpoint/m${s.head}` : `job/${job}`;
    const headEntity = s.entities.find((e) => e.name === headName);
    this.log("chain", label, `escrow.head(${job})`, "read at configured confirmation depth");
    await this.wait(1, id);
    this.log("response", "sepolia", `head = m${s.head} · epoch ${s.epoch} · worker ${this.worker(old.worker!).addr}`, JSON.stringify({ milestone: s.head, manifestDigest: short(hex(64)), epoch: s.epoch }, null, 2));
    await this.wait(1.2, id);
    this.log("query", label, s.head > 0
      ? `arkiv.query('type = "checkpoint" && job = "${job}" && milestone = ${s.head}')`
      : `arkiv.query('type = "job" && job = "${job}"')`);
    await this.wait(1.4, id);
    this.log("response", "arkiv", `200 · 1 entity`, JSON.stringify({
      entityKey: headEntity ? short(headEntity.key) : short(hex(64)),
      owner: "buyer",
      attributes: s.head > 0 ? { type: "checkpoint", job, epoch: s.epoch, milestone: s.head } : { type: "job", job },
      expiresAtBlock: headEntity ? this.block(headEntity.expiresAt) : this.block() + 7_884_000,
    }, null, 2));
    await this.wait(1, id);
    this.log("query", label, `arkiv.getEntity(${headEntity ? short(headEntity.key) : "…"})`);
    await this.wait(1, id);
    this.log("response", "arkiv", `200 · ${s.head > 0 ? "3.1" : "2.4"} KiB ciphertext`, "payload: AES-256-GCM envelope · manifest v1");
    await this.wait(1, id);
    this.log("key", label, `POST key-service/grant { worker: ${this.worker(node.worker!).addr}, head: m${s.head} }`, "buyer-host key service · TLS");
    await this.wait(1.2, id);
    this.log("response", "key-service", "200 · wrapped content key for this head only");
    await this.wait(0.8, id);
    this.log("sys", label, "decrypt manifest · auth tag ok", "objective · decisions · next actions · artifact refs · tool requirements");
    if (s.head > 0) {
      await this.wait(1, id);
      this.log("query", label, `arkiv.query('type = "chunk" && job = "${job}" && milestone <= ${s.head}')`);
      await this.wait(1.2, id);
      this.log("response", "arkiv", `200 · ${s.head * 2} entities · ${(s.head * 137.7).toFixed(1)} KiB`, `chunk digests verified against manifest (${s.head * 2}/${s.head * 2})`);
    }
    await this.wait(1, id);
    this.log("x402", label, "gateway.ledger(job) — reconcile uncertain ops");
    await this.wait(1, id);
    const unaccepted = this.ops.filter((o) => o.milestone > s.head);
    this.log("response", "gateway", unaccepted.length ? `${unaccepted.length} settled op(s) after head — output reusable` : "no uncertain operations", unaccepted.map((o) => `${o.id} SETTLED ${o.receipt} by ${this.worker(o.by).name}`).join("\n") || undefined);
    this.step("Recover from Arkiv");
    await this.wait(1.2, id);
    this.log("key", label, "signAck(EIP-712 TakeoverAck)", JSON.stringify({ job, head: `m${s.head}`, epoch: s.epoch, successor: this.worker(node.worker!).addr }, null, 2));
    await this.wait(1, id);
    s.epoch += 1;
    node.epoch = s.epoch;
    node.records["baton.epoch"] = String(s.epoch);
    this.log("chain", "buyer", `escrow.takeover(${job}, ack)`, `epoch ${s.epoch - 1} → ${s.epoch} · head unchanged · credits unchanged`);
    await this.wait(1, id);
    this.log("chain", old.label, `escrow.acceptMilestone(stale offer, epoch ${s.epoch - 1})`, "replayed by the offline worker");
    await this.wait(0.8, id);
    this.log("error", "sepolia", `revert StaleEpoch(${s.epoch - 1}, ${s.epoch})`, `${old.ens} no longer has authority`);
    this.log("x402", "gateway", `admissions resumed for ${node.ens}`, "fresh scoped access — never the previous worker's key");
    this.createEntity(`claim/${label}`, "claim", id, s.config.expected, label, { type: "claim", job, worker: node.ens, epoch: s.epoch }, "312 B");
    this.step("Take over at new epoch");
    const n = this.current();
    if (n) { n.tone = "done"; n.subtitle = `${node.ens} resumed from m${s.head} at epoch ${s.epoch}`; }
    s.phase = "running";
    node.status = "live";
    const token = this.run;
    const nid = n?.id;
    this.queue.push({ at: s.clock + 18, run: () => { if (token === this.run) { const x = this.state.notices.find((y) => y.id === nid); if (x && x.tone === "done") x.closed = true; } } });
  }

  private async complete(node: TreeNode) {
    const s = this.state;
    const job = s.config.job;
    await this.wait(1, node.id);
    s.phase = "complete";
    this.log("chain", "buyer", `escrow.close(${job})`, "all milestones accepted · unused balance refunded");
    const claim = this.claimOf(node);
    if (claim && claim.status === "live") { claim.status = "released"; this.log("ttl", node.label, `release claim/${node.label}`, "job complete"); }
    for (const [wid, amt] of Object.entries(s.credits)) {
      await this.wait(1);
      s.withdrawn[wid] = amt;
      this.log("chain", this.worker(wid).name, `escrow.claim() → ${amt} tUSD`, `${this.worker(wid).addr} withdrew earned credits`);
    }
    s.nodes.forEach((n) => { if (n.status !== "dead") n.status = "done"; });
    this.notice({ title: `${job} complete`, subtitle: Object.entries(s.credits).map(([w, a]) => `${this.worker(w).name} ${a}`).join(" · ") + " tUSD withdrawn", tone: "done", steps: [] });
    this.stopTimer();
    this.emit();
  }
}
