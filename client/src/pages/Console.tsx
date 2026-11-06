import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BatonSim, fmtClock, fmtTtl, type Entity, type Service, type SimState, type TreeNode } from "../features/console/sim";
import { EnsTree } from "../features/console/EnsTree";
import { Terminal } from "../features/console/Terminal";

function useSim() {
  const ref = useRef<BatonSim | null>(null);
  if (!ref.current) ref.current = new BatonSim();
  const sim = ref.current;
  useSyncExternalStore(sim.subscribe, sim.getVersion);
  useEffect(() => () => sim.reset(), [sim]);
  return sim;
}

const PHASE_LABEL: Record<SimState["phase"], string> = {
  setup: "Not started", running: "Running", takeover: "Takeover in progress", halted: "Paused · no standby", complete: "Complete",
};

export function BrowserDemo() {
  const sim = useSim();
  const s = sim.state;
  const selected = s.selected ? s.nodes.find((n) => n.id === s.selected) : undefined;

  return (
    <div className="console">
      <header className="console-intro">
        <div>
          <p className="eyebrow"><span className="hero-signal" aria-hidden="true" />Interactive demo</p>
          <h1>Handoff simulation</h1>
          <p>Configure a job, stop its worker, and follow the successor through checkpoint recovery. This browser demo makes no chain, Arkiv, or x402 calls.</p>
        </div>
        <span className="console-intro-mark mono">LOCAL MODEL<br />NO EXTERNAL WRITES</span>
      </header>
      <div className="console-bar">
        <div className="cb-left">
          <span className={`phase-pill p-${s.phase}`}><i />{PHASE_LABEL[s.phase]}</span>
          <span className="cb-job mono">{s.config.job}</span>
          <span className="cb-stat"><b>epoch</b> {s.epoch || "–"}</span>
          <span className="cb-stat"><b>head</b> m{s.head}/3</span>
          <span className="cb-stat mono"><b>t</b> {fmtClock(s.clock)}</span>
        </div>
        <div className="cb-right">
          <span className="sim-badge" title="Runs entirely in the browser. No chain, Arkiv or x402 calls are made.">Browser simulation</span>
          <div className="speed" role="group" aria-label="Simulation speed">
            {[1, 2, 4].map((v) => <button key={v} type="button" className={s.speed === v ? "on" : ""} aria-pressed={s.speed === v} onClick={() => sim.setSpeed(v)}>{v}×</button>)}
          </div>
          {s.phase !== "setup" && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => sim.togglePause()}>{s.paused ? "Resume" : "Pause"}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => sim.reset()}>Reset</button>
            </>
          )}
        </div>
      </div>

      <div className="console-grid">
        <aside className="col-left">
          {s.phase === "setup" ? <SetupPanel sim={sim} /> : <JobPanel s={s} sim={sim} />}
        </aside>

        <section className="col-tree">
          <div className="tree-head">
            <div>
              <h3>ENS job tree</h3>
              <p className="muted small">Select a worker to inspect or manage its branch.</p>
            </div>
            <ServicePulse touches={s.touches} />
          </div>
          <div className="tree-canvas">
            <AnimatePresence>
              {s.notices.filter((n) => !n.closed).map((n) => (
                <motion.div key={n.id} className={`notice n-${n.tone}`} initial={{ opacity: 0, y: -12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10 }}>
                  <div className="notice-head">
                    <span className="notice-icon">{n.tone === "done" ? "✓" : n.tone === "warn" ? "!" : "↻"}</span>
                    <div>
                      <b>{n.title}</b>
                      {n.subtitle && <p>{n.subtitle}</p>}
                    </div>
                    <button className="notice-x" aria-label={`Dismiss ${n.title} notice`} onClick={() => { n.closed = true; sim.select(s.selected); }}>×</button>
                  </div>
                  {n.steps.length > 0 && (
                    <ol className="notice-steps">
                      {n.steps.map((st) => <li key={st.label} className={`st-${st.state}`}><i />{st.label}</li>)}
                    </ol>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
            <div className="tree-viewport" role="region" aria-label="Scrollable ENS job tree" tabIndex={0}>
              <EnsTree nodes={s.nodes} workers={s.workers} selected={s.selected} onSelect={(id) => sim.select(id)} />
            </div>
            <div className="tree-legend">
              <span><i className="lg live" />idle</span>
              <span><i className="lg working" />working</span>
              <span><i className="lg recovering" />recovering</span>
              <span><i className="lg dead" />dead / revoked</span>
            </div>
          </div>
          <AnimatePresence>
            {selected && <Inspector key={selected.id} node={selected} s={s} sim={sim} />}
          </AnimatePresence>
        </section>

        <aside className="col-right">
          <EntityPanel entities={s.entities} clock={s.clock} />
          <Terminal logs={s.logs} />
        </aside>
      </div>
    </div>
  );
}

function ServicePulse({ touches }: { touches: Record<Service, number> }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => { const t = setInterval(() => setNow(performance.now()), 120); return () => clearInterval(t); }, []);
  const items: [Service, string][] = [["arkiv", "Arkiv"], ["ens", "ENS"], ["chain", "Sepolia"], ["x402", "Hedera x402"]];
  return (
    <div className="svc-pulse" role="group" aria-label="Simulated service activity">
      {items.map(([k, l]) => <span key={k} className={`svc ${now - touches[k] < 700 ? "hot" : ""}`}><i />{l}</span>)}
    </div>
  );
}

function SetupPanel({ sim }: { sim: BatonSim }) {
  const c = sim.state.config;
  const workers = sim.state.workers;
  const valid = /^[a-z0-9-]+\.eth$/.test(c.job) && c.standby.every((id) => id !== c.primary);
  return (
    <div className="panel setup">
      <p className="eyebrow">New job</p>
      <h3>Configure job</h3>
      <label className="field">
        <span>Job ENS name</span>
        <input autoCapitalize="none" autoCorrect="off" aria-invalid={!/^[a-z0-9-]+\.eth$/.test(c.job)} aria-describedby={!/^[a-z0-9-]+\.eth$/.test(c.job) ? "job-name-hint" : undefined} value={c.job} spellCheck={false} onChange={(e) => sim.configure({ job: e.target.value.toLowerCase().trim() })} />
        {!/^[a-z0-9-]+\.eth$/.test(c.job) && <em id="job-name-hint" className="err" role="alert">Use a name like baton.eth</em>}
      </label>
      <div className="field">
        <span>Primary worker</span>
        <div className="worker-pick">
          {workers.map((w) => (
            <button key={w.id} type="button" className={c.primary === w.id ? "on" : ""} aria-pressed={c.primary === w.id} onClick={() => sim.configure({ primary: w.id, standby: c.standby.filter((x) => x !== w.id) })}>
              <b>{w.name}</b><span className="mono">{w.addr}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Standby order</span>
        <div className="chips">
          {workers.filter((w) => w.id !== c.primary).map((w) => {
            const on = c.standby.includes(w.id);
            const standbyIndex = c.standby.indexOf(w.id);
            return (
              <button key={w.id} type="button" className={`chip-toggle ${on ? "on" : ""}`} aria-pressed={on} onClick={() => sim.configure({ standby: on ? c.standby.filter((x) => x !== w.id) : [...c.standby, w.id] })}>
                <span className="standby-rank">{on ? String(standbyIndex + 1).padStart(2, "0") : "+"}</span>{w.name}
              </button>
            );
          })}
        </div>
      </div>
      <label className="field">
        <span>Expected milestone time</span>
        <div className="range-row">
          <input type="range" aria-label="Expected time for each milestone" min={12} max={120} step={2} value={c.expected} onChange={(e) => sim.configure({ expected: Number(e.target.value) })} />
          <b className="mono">{fmtTtl(c.expected)}</b>
        </div>
        <em className="hint">{c.expected < 20 ? "May time out before completion." : "Claim renews at each checkpoint."}</em>
      </label>
      <div className="setup-summary">
        <div><span>Rewards</span><b>10 tUSD · 3 / 3 / 4</b></div>
        <div><span>Service budget</span><b>1.5 HBAR cap</b></div>
      </div>
      <button className="btn btn-primary btn-block" disabled={!valid} onClick={() => sim.start()}>Start job</button>
    </div>
  );
}

function JobPanel({ s, sim }: { s: SimState; sim: BatonSim }) {
  const w = (id: string) => s.workers.find((x) => x.id === id)!;
  const primary = s.nodes.filter((n) => n.role === "primary" && n.status !== "dead").at(-1);
  return (
    <div className="panel-stack">
      <div className="panel">
        <div className="panel-title"><h4>Milestones</h4><span className="muted small mono">{s.head}/3 accepted</span></div>
        <ol className="milestones">
          {s.milestones.map((m) => (
            <li key={m.index} className={`ms ms-${m.status}`}>
              <span className="ms-dot">{m.status === "accepted" ? "✓" : m.index}</span>
              <div>
                <b>{m.label}</b>
                <span className="muted small">{m.status === "accepted" ? `accepted · ${w(m.by!).name}` : m.status === "running" ? "in progress" : "pending"}</span>
              </div>
              <span className="ms-reward mono">{m.reward}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="panel">
        <div className="panel-title"><h4>Credits</h4><span className="muted small">Sepolia escrow</span></div>
        {Object.keys(s.credits).length === 0 && <p className="muted small">No milestone accepted yet.</p>}
        {Object.entries(s.credits).map(([id, amt]) => (
          <div key={id} className="credit-row">
            <span>{w(id).name}</span>
            <span className="credit-bar"><i style={{ width: `${amt * 10}%` }} /></span>
            <b className="mono">{amt}{s.withdrawn[id] ? " ✓" : ""}</b>
          </div>
        ))}
        <div className="budget">
          <div className="panel-title"><span className="small">Service budget · Hedera x402</span><span className="mono small">{s.budget.spent.toFixed(2)} / {s.budget.cap} HBAR</span></div>
          <span className="credit-bar wide"><i style={{ width: `${(s.budget.spent / s.budget.cap) * 100}%` }} /></span>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title"><h4>Workers</h4><button className="link-btn" onClick={() => sim.addStandby()} disabled={!s.workers.some((x) => x.state === "idle")}>+ Add standby</button></div>
        <ul className="workers">
          {s.workers.map((x) => (
            <li key={x.id} className={`wk wk-${x.state}`}>
              <i />
              <div><b>{x.name}</b><span className="mono small muted">{x.addr} · {x.host}</span></div>
              <span className="wk-state">{x.state}</span>
            </li>
          ))}
        </ul>
        {primary && s.phase !== "complete" && (
          <div className="quick-actions">
            <button className="btn btn-danger btn-sm" onClick={() => sim.kill(primary.id)}>Kill {primary.label}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => sim.revoke(primary.id)}>Revoke now</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Inspector({ node, s, sim }: { node: TreeNode; s: SimState; sim: BatonSim }) {
  const children = s.nodes.filter((n) => n.parent === node.id);
  const alive = node.status !== "dead" && s.phase !== "complete";
  return (
    <motion.div className="inspector" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}>
      <div className="insp-head">
        <div>
          <span className={`insp-status s-${node.status}`}>{node.status}</span>
          <h4 className="mono">{node.ens}</h4>
        </div>
        <button className="notice-x" onClick={() => sim.select(undefined)} aria-label="Close inspector">×</button>
      </div>
      <div className="insp-grid">
        <div><span>Role</span><b>{node.role === "job" ? "job root" : node.role === "primary" ? "primary agent" : "subagent"}</b></div>
        <div><span>Born</span><b className="mono">{fmtClock(node.bornAt)}</b></div>
        {node.diedAt !== undefined && <div><span>Died</span><b className="mono">{fmtClock(node.diedAt)} · {node.cause}</b></div>}
        <div><span>Children</span><b>{children.length}</b></div>
      </div>
      <div className="records">
        <span className="records-title">Resolver text records</span>
        {Object.entries(node.records).map(([k, v]) => (
          <div key={k} className="record"><span className="mono">{k}</span><span className={`mono ${v === "revoked" ? "revoked" : ""}`}>{v}</span></div>
        ))}
      </div>
      {node.role !== "job" && (
        <div className="insp-actions">
          <button className="btn btn-danger btn-sm" disabled={!alive} onClick={() => sim.kill(node.id)}>Kill agent</button>
          {node.role === "primary" && <button className="btn btn-ghost btn-sm" disabled={!alive} onClick={() => sim.revoke(node.id)}>Revoke now</button>}
          <button className="btn btn-ghost btn-sm" disabled={!alive} onClick={() => sim.spawnSub(node.id)}>+ Subagent</button>
        </div>
      )}
    </motion.div>
  );
}

function EntityPanel({ entities, clock }: { entities: Entity[]; clock: number }) {
  const order = { claim: 0, checkpoint: 1, job: 2, chunk: 3 } as const;
  const list = [...entities].sort((a, b) => order[a.kind] - order[b.kind] || b.createdAt - a.createdAt).slice(0, 7);
  return (
    <div className="panel entities">
      <div className="panel-title"><h4>Arkiv entities</h4><span className="muted small mono">{entities.filter((e) => e.status === "live").length} live · {entities.length} total</span></div>
      {!entities.length && <p className="muted small">Claims, checkpoints and chunks appear here with their expiry.</p>}
      <ul>
        {list.map((e) => {
          const left = e.expiresAt - clock;
          const frac = e.status === "live" ? Math.max(0, Math.min(1, left / e.ttl)) : 0;
          const urgent = e.kind === "claim" && e.status === "live" && frac < 0.3;
          return (
            <li key={e.key} className={`ent ent-${e.kind} st-${e.status}${urgent ? " urgent" : ""}`}>
              <span className="ent-name mono">{e.name}</span>
              <span className="ent-bar"><i style={{ width: `${frac * 100}%` }} /></span>
              <span className="ent-ttl mono">{e.status === "live" ? fmtTtl(left) : e.status}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
