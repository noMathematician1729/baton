import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import type { MotionValue } from "framer-motion";
import { useRef } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CreationHero, type RailSection } from "./landing/CreationHero";
import { SiteFooter } from "../components/SiteFooter";
import { Baton } from "../components/Baton";

const sections: RailSection[] = [
  { id: "problem", label: "Problem" },
  { id: "protocol", label: "Protocol" },
  { id: "identity", label: "Identity · ENS" },
  { id: "memory", label: "Memory · Arkiv" },
  { id: "money", label: "Rewards · x402" },
  { id: "guarantees", label: "Guarantees" },
];

function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: reduceMotion ? 0 : 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: reduceMotion ? 0.22 : 0.7, delay: reduceMotion ? Math.min(delay, 0.08) : delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

function SectionHead({ index, eyebrow, title, intro }: { index: string; eyebrow: string; title: ReactNode; intro?: ReactNode }) {
  return (
    <Reveal className="section-head">
      <p className="eyebrow"><span className="eyebrow-num">{index}</span>{eyebrow}</p>
      <h2>{title}</h2>
      {intro && <p className="section-intro">{intro}</p>}
    </Reveal>
  );
}

const guarantees = [
  { t: "Old workers are fenced", d: "An epoch change invalidates stale milestone offers and takeover signatures.", layer: "Sepolia · Escrow" },
  { t: "Accepted work is canonical", d: "Only the escrow accepted head can seed the next worker's recovery.", layer: "Sepolia · Escrow" },
  { t: "Recovery fails closed", d: "Missing bytes, a digest mismatch or no key means stop. No partial-state guesses.", layer: "Worker · Recovery" },
  { t: "Checkpoints stay encrypted", d: "Arkiv stores ciphertext. Buyer-held keys remain outside public storage.", layer: "Arkiv · Buyer keys" },
  { t: "Rewards stay with producers", d: "Credits stay with the worker who earned each accepted milestone.", layer: "Sepolia · Escrow" },
  { t: "Paid calls reconcile", d: "Stable request IDs help a successor avoid paying twice after an uncertain response.", layer: "Hedera · Gateway" },
];

export function Landing() {
  return (
    <div className="landing">
      <CreationHero sections={sections} />

      <div className="landing-body">
        <section id="problem" className="l-section">
          <SectionHead
            index="01"
            eyebrow="The problem"
            title={<>Agents stall, crash and run out of budget. <em>The work shouldn&rsquo;t die with them.</em></>}
            intro="Long jobs outlive single workers. Today a failed agent takes its progress, its paid results and its context with it, and the buyer pays twice to start over."
          />
          <div className="problem-grid">
            {[
              { t: "The job stops with its worker", d: "A crash can take unaccepted work and working state with it.", kind: "state", label: "Progress" },
              { t: "Permissions outlive the handoff", d: "Without a live, revocable grant, a replaced worker can still look active.", kind: "identity", label: "Authority" },
              { t: "Paid work gets repeated", d: "A successor may pay again when there is no receipt for an earlier call.", kind: "spend", label: "Cost" },
            ].map((item, i) => (
              <Reveal key={item.t} delay={i * 0.14} className="problem-card">
                <div className="problem-meta">
                  <span className="problem-icon"><ProblemGlyph kind={item.kind} /></span>
                  <span className="problem-num">0{i + 1}</span>
                </div>
                <span className="problem-category">{item.label}</span>
                <h3>{item.t}</h3>
                <p>{item.d}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section id="protocol" className="l-section">
          <SectionHead
            index="02"
            eyebrow="The protocol"
            title={<>A checkpoint moves forward only when <em>escrow accepts it.</em></>}
            intro="Worker A proposes encrypted work. The buyer accepts one exact head. Worker B recovers that head, then takes authority through an acknowledged handoff."
          />
          <Lifecycle />
        </section>

        <section id="identity" className="l-section split">
          <div>
            <SectionHead
              index="03"
              eyebrow="Identity · ENSv2"
              title={<>Every worker is <em>a name</em> you can revoke.</>}
              intro="A job name can own its own ENSv2 namespace. Give each worker a scoped branch, then point a stable alias at whoever is active."
            />
            <Reveal className="bullets">
              <ul>
                <li><b>Natural delegation.</b> <code>baton.eth</code> can own a subregistry; a worker can manage its own child names without controlling its siblings.</li>
                <li><b>Names follow the job.</b> Repoint <code>active.baton.eth</code> to the live worker. Keep a revoked worker&rsquo;s old name in the tree for history.</li>
                <li><b>No extra name price.</b> BATON can set its registrar&rsquo;s subname price to zero. Registry setup and onchain writes still use gas.</li>
                <li><b>Authority stays scoped.</b> The contract checks the current worker grant when it accepts work; a name never transfers private credentials.</li>
              </ul>
            </Reveal>
          </div>
          <Reveal className="ens-mini" delay={0.1}>
            <EnsMini />
          </Reveal>
        </section>

        <section id="memory" className="l-section split reverse">
          <Reveal className="arkiv-mini" delay={0.1}>
            <ArkivMini />
          </Reveal>
          <div>
            <SectionHead
              index="04"
              eyebrow="Memory · Arkiv"
              title={<>Checkpoints that <em>expire on purpose.</em></>}
              intro="A worker renews a short-lived Arkiv claim while it is active. When the claim expires, a watcher notices it is absent; the successor then recovers from the last checkpoint the escrow accepted."
            />
            <Reveal className="bullets">
              <ul>
                <li><b>Expiry is polled.</b> Arkiv emits no expiry event; the job watcher checks for an expired or missing claim.</li>
                <li><b>Recovery has an anchor.</b> The successor reads the accepted head from escrow, then fetches its encrypted manifest and chunks.</li>
                <li><b>Artifacts have a TTL too.</b> An entity can live up to about 182.5 days; its owner must renew it before expiry unless permissionless extension is enabled.</li>
              </ul>
            </Reveal>
          </div>
        </section>

        <section id="money" className="l-section">
          <SectionHead
            index="05"
            eyebrow="Rewards & services"
            title={<>Two ledgers that <em>never get mixed up.</em></>}
            intro="Sepolia tracks what each worker earns. Hedera x402 pays for external services. Each has a separate budget, record and settlement path."
          />
          <div className="money-grid">
            <Reveal className="money-card">
              <div className="money-head"><span className="chip">Sepolia escrow</span><span className="money-big">3 <i>/</i> 7</span></div>
              <h3>Worker reward ledger</h3>
              <p>The buyer funds milestone rewards in advance. Accepted work credits the worker who produced it; if A earns 3 and B earns 7, takeover leaves that split intact.</p>
            </Reveal>
            <Reveal className="money-card" delay={0.08}>
              <div className="money-head"><span className="chip">Hedera x402</span><span className="money-big">≤ cap</span></div>
              <h3>External service budget</h3>
              <p>A buyer-controlled gateway caps each x402 data or compute payment and records its receipt. A successor gets fresh access; it never inherits A&rsquo;s key.</p>
            </Reveal>
          </div>
          <p className="ledger-note">Separate chains and balances. There is no shared balance or atomic settlement between these ledgers.</p>

        <aside className="status-strip" aria-labelledby="status-title">
          <div className="status-intro">
            <p className="eyebrow">Integration status</p>
            <h2 id="status-title">A clear view of what’s ready.</h2>
            <p>Live checks, in-progress integrations, and the local demo are identified separately.</p>
            <Link to="/faq" className="status-link">Read the current status <span aria-hidden="true">↗</span></Link>
          </div>
          <div className="status-grid">
            <div className="status-item">
              <span className="status-label"><i className="status-dot is-verified" />Verified</span>
              <p>Historical Sepolia lifecycle and ENS grant checks.</p>
            </div>
            <div className="status-item">
              <span className="status-label"><i className="status-dot is-progress" />In progress</span>
              <p>Live Arkiv write/readback, x402 settlement, and separate-host recovery.</p>
            </div>
            <div className="status-item">
              <span className="status-label"><i className="status-dot" />Browser demo</span>
              <p>Simulation only; it makes no chain, Arkiv, or x402 calls.</p>
            </div>
          </div>
        </aside>
        </section>

        <GuaranteeSection />

        <section className="final-cta">
          <Reveal>
            <Baton width={136} className="final-baton" />
            <h2>Kill an agent. <em>Watch the job keep going.</em></h2>
            <p className="section-intro">Start a browser simulation, stop a worker, and follow how its successor recovers the last checkpoint the buyer accepted.</p>
            <Link to="/demo" className="btn btn-primary btn-lg">Run browser demo <span aria-hidden="true">↗</span></Link>
          </Reveal>
        </section>
      </div>
      <SiteFooter />
    </div>
  );
}

function ProblemGlyph({ kind }: { kind: string }) {
  if (kind === "identity") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2 19 6v5.5c0 4.3-2.9 7.5-7 9.3-4.1-1.8-7-5-7-9.3V6l7-2.8Z" /><path d="m9 12.1 2 2 4.2-4.4" /><path d="M18.2 17.7 21 20.5" /></svg>;
  }
  if (kind === "spend") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.7h11v16.6l-2.7-1.7-2.8 1.7-2.8-1.7-2.7 1.7V3.7Z" /><path d="M9.2 8h5.6M9.2 11.4h5.6" /><circle cx="11.9" cy="15.4" r="1.6" /><path d="M11.9 14.5v1.8" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" /><path d="M14 3.7v4.1h4M9 12h7M9 15.5h5" /><path d="M3.5 6.5v12a3 3 0 0 0 3 3" /></svg>;
}

function Lifecycle() {
  return (
    <div className="protocol-wrap">
      <div className="protocol-flow" role="group" aria-label="Worker A proposes encrypted work, escrow accepts the checkpoint, and Worker B recovers it and takes over">
        <div className="protocol-party">
          <span className="protocol-orbit protocol-orbit-a" aria-hidden="true"><b>A</b></span>
          <span className="protocol-caption">Current worker</span>
          <strong>Worker A</strong>
          <span className="protocol-detail">Stages encrypted work</span>
        </div>
        <span className="protocol-link" aria-hidden="true"><i /></span>
        <div className="protocol-record">
          <span className="protocol-record-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 12h6M9 15.5h3" /><path d="m15.2 16.2 1.4 1.4 2.8-3" /></svg></span>
          <span className="protocol-caption">Canonical record</span>
          <strong>Accepted checkpoint</strong>
          <span className="protocol-detail">The escrow head recovery must follow</span>
          <span className="protocol-proof">Encrypted · verified · credited</span>
        </div>
        <span className="protocol-link" aria-hidden="true"><i /></span>
        <div className="protocol-party">
          <span className="protocol-orbit protocol-orbit-b" aria-hidden="true"><b>B</b></span>
          <span className="protocol-caption">Successor</span>
          <strong>Worker B</strong>
          <span className="protocol-detail">Recovers and takes over</span>
        </div>
      </div>
      <p className="protocol-note">A writes the manifest and chunks to Arkiv, then signs a milestone offer. The buyer checks the live ENS grant, epoch, previous head and signature before accepting it. B verifies the accepted artifacts and acknowledges the exact head; escrow increments the epoch and fences A. An unaccepted upload leaves the previous head in effect.</p>
    </div>
  );
}

function GuaranteeSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ["start 85%", "end 42%"] });
  const drawnPath = useTransform(scrollYProgress, [0, 0.92], [0, 1]);
  const stops = [84, 250, 416, 584, 750, 916];
  const curve = "M0 38 C42 38 47 50 84 50 C125 50 125 8 167 8 C209 8 209 50 250 50 C292 50 292 8 333 8 C375 8 375 50 416 50 C458 50 458 8 500 8 C542 8 542 50 584 50 C626 50 626 8 667 8 C709 8 709 50 750 50 C792 50 792 8 833 8 C875 8 875 50 916 50 C950 50 960 38 1000 38";
  return (
    <section ref={sectionRef} id="guarantees" className="l-section guarantee-section">
      <SectionHead index="06" eyebrow="Six guarantees" title={<>Each layer keeps a promise.</>} intro="Escrow controls worker authority and rewards. The recovery client, Arkiv and the payment gateway each handle their own checks." />
      <div className="guarantee-track-wrap">
        <svg className="guarantee-path" viewBox="0 0 1000 64" preserveAspectRatio="none" aria-hidden="true">
          <path className="guarantee-track-base" d={curve} />
          <motion.path className="guarantee-track-fill" d={curve} style={{ pathLength: drawnPath }} />
          {stops.map((x, i) => <GuaranteeStop key={x} x={x} index={i} total={stops.length} progress={drawnPath} />)}
        </svg>
        <div className="guarantee-grid">
          {guarantees.map((g, i) => (
            <Reveal key={g.t} delay={i * 0.055} className="guarantee">
              <span className="guarantee-number">{String(i + 1).padStart(2, "0")}</span>
              <span className="guarantee-layer">{g.layer}</span>
              <h3>{g.t}</h3>
              <p>{g.d}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function GuaranteeStop({ x, index, total, progress }: { x: number; index: number; total: number; progress: MotionValue<number> }) {
  const center = index / (total - 1);
  const start = Math.max(0, center - 0.12);
  const end = Math.min(1, Math.max(start + 0.04, center + 0.025));
  const active = useTransform(progress, [start, end], [0, 1]);
  const scale = useTransform(active, [0, 1], [0.55, 1]);
  return (
    <g>
      <circle className="guarantee-track-stop" cx={x} cy="50" r="5" />
      <motion.circle className="guarantee-track-halo" cx={x} cy="50" r="12" style={{ opacity: active, scale }} />
      <motion.circle className="guarantee-track-stop-active" cx={x} cy="50" r="4.5" style={{ opacity: active }} />
    </g>
  );
}

function EnsMini() {
  const nodes = [
    { x: 250, y: 55, w: 172, label: "baton.eth", sub: "Job namespace", state: "job" },
    { x: 145, y: 147, w: 160, label: "agent-a", sub: "Revoked · subregistry", state: "dead" },
    { x: 355, y: 147, w: 160, label: "agent-b", sub: "Active · subregistry", state: "live" },
    { x: 85, y: 238, w: 108, label: "fetch", sub: "agent-a", state: "dead" },
    { x: 205, y: 238, w: 108, label: "compute", sub: "agent-a", state: "dead" },
    { x: 295, y: 238, w: 108, label: "fetch", sub: "agent-b", state: "live" },
    { x: 415, y: 238, w: 108, label: "compute", sub: "agent-b", state: "live" },
  ];
  return (
    <div className="ens-diagram">
      <div className="ens-diagram-head"><span>ENSv2 · Job tree</span><span className="mono">baton.eth</span></div>
      <svg viewBox="0 0 500 374" className="mini-svg" role="img" aria-label="A job registry with a revoked worker branch and an active successor branch">
        <g className="mini-links" fill="none" strokeWidth="1.5">
          <path d="M250 77 V102 H145 V125" />
          <path d="M250 102 H355 V125" />
          <path className="dead" d="M145 169 V190 H85 V216 M145 190 H205 V216" />
          <path d="M355 169 V190 H295 V216 M355 190 H415 V216" />
          <path className="alias-link" d="M355 169 V278 H250 V295" />
        </g>
        {nodes.map((node) => (
          <g key={`${node.x}-${node.label}`} className={`mini-node ${node.state}`} transform={`translate(${node.x},${node.y})`}>
            <rect x={-node.w / 2} y="-22" width={node.w} height="44" rx="10" />
            <text y="-2" textAnchor="middle">{node.label}</text>
            <text className="mini-node-sub" y="13" textAnchor="middle">{node.sub}</text>
          </g>
        ))}
        <g className="mini-alias" transform="translate(250,326)">
          <rect x="-113" y="-20" width="226" height="40" rx="12" />
          <text y="-1" textAnchor="middle">active.baton.eth</text>
          <text className="mini-node-sub" y="13" textAnchor="middle">Resolves to agent-b</text>
        </g>
      </svg>
      <div className="ens-diagram-foot"><span><i className="ens-key live-key" />active name</span><span><i className="ens-key dead-key" />revoked history</span></div>
    </div>
  );
}

function ArkivMini() {
  const rows = [
    { n: "01", title: "Worker A renews its claim", key: "claim/agent-a", note: "short TTL · refreshed while active", state: "active" },
    { n: "02", title: "The claim expires", key: "claim/agent-a", note: "queries stop returning it · no expiry event", state: "expired" },
    { n: "03", title: "A watcher detects absence", key: "job watcher", note: "the timeout is observed by BATON", state: "watch" },
    { n: "04", title: "Worker B recovers accepted work", key: "escrow head → Arkiv", note: "fetch manifest + chunks, verify, then resume", state: "recover" },
  ];
  return (
    <div className="arkiv-card">
      <div className="arkiv-card-head"><span>Claim timeout → recovery</span><span className="mono muted">Arkiv · escrow</span></div>
      <div className="arkiv-flow">
        {rows.map((row) => (
          <div key={row.n} className={`arkiv-step ${row.state}`}>
            <span className="arkiv-step-no">{row.n}</span>
            <div className="arkiv-step-copy"><strong>{row.title}</strong><code>{row.key}</code><small>{row.note}</small></div>
          </div>
        ))}
      </div>
      <p className="arkiv-retention"><b>Retention:</b> each Arkiv entity can live up to ~182.5 days. The owner must extend it before expiry unless permissionless extension is enabled.</p>
    </div>
  );
}
