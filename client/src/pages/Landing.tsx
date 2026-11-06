import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import type { MotionValue } from "framer-motion";
import { Handle, Position, ReactFlow, useEdgesState, useNodesState, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { useRef } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CreationHero, type RailSection } from "./landing/CreationHero";
import { SiteFooter } from "../components/SiteFooter";
import { Baton } from "../components/Baton";
import { SignalField } from "../components/SignalField";

const sections: RailSection[] = [
  { id: "problem", label: "Problem" },
  { id: "protocol", label: "Protocol" },
  { id: "identity", label: "Identity · ENS" },
  { id: "memory", label: "Memory · Arkiv" },
  { id: "money", label: "Rewards & spend" },
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
  { t: "Paid calls reconcile", d: "Stable request IDs help a successor avoid paying twice after an uncertain response.", layer: "Gateway · Ledger" },
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
            intro="Worker A stores a checkpoint in Arkiv. Escrow records the accepted transaction, then Worker B recovers that checkpoint from Arkiv."
          />
          <Lifecycle />
        </section>

        <section id="identity" className="l-section split">
          <div>
            <SectionHead
              index="03"
              eyebrow="Identity · ENSv2"
              title={<>One job resource. <em>Scoped worker grants.</em></>}
              intro="ENSv2 stores a permission for the job resource. Escrow checks the assigned worker’s live grant before accepting work or moving authority."
            />
            <Reveal className="bullets">
              <ul>
                <li><b>Grant scoped to the job.</b> The resolver checks the job-key resource. A broad resolver-wide role does not authorize a worker.</li>
                <li><b>Escrow moves assignment.</b> Takeover changes the assigned worker and epoch; offers signed by a stale worker are rejected.</li>
                <li><b>Revocation takes effect.</b> Escrow checks the current ENS grant before accepting a milestone or successor acknowledgement.</li>
                <li><b>Credentials stay separate.</b> An ENS grant authorizes protocol actions; it does not transfer a worker&rsquo;s private keys or service credentials.</li>
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
            <Reveal className="arkiv-principles">
              <ul>
                <li><b>Queryable</b><span>Find checkpoints by job and milestone—no indexer.</span></li>
                <li><b>Time-scoped</b><span>Expire stale claims; renew active workers only.</span></li>
                <li><b>Tamper-evident</b><span>Verify digests before the successor resumes.</span></li>
                <li><b>Wallet-owned</b><span>Only the owner wallet can update or renew it.</span></li>
              </ul>
            </Reveal>
          </div>
        </section>

        <section id="money" className="l-section">
          <SectionHead
            index="05"
            eyebrow="Rewards & services"
            title={<>Two ledgers that <em>never get mixed up.</em></>}
            intro="Sepolia tracks what each worker earns. A buyer-controlled gateway tracks external service spend separately, with durable receipts for uncertain calls."
          />
          <div className="money-grid">
            <Reveal className="money-card">
              <div className="money-head"><span className="chip">Sepolia escrow</span><span className="money-big">3 <i>/</i> 7</span></div>
              <h3>Worker reward ledger</h3>
              <p>The buyer funds milestone rewards in advance. Accepted work credits the worker who produced it; if A earns 3 and B earns 7, takeover leaves that split intact.</p>
            </Reveal>
            <Reveal className="money-card" delay={0.08}>
              <div className="money-head"><span className="chip">Service gateway</span><span className="money-big">≤ cap</span></div>
              <h3>External service budget</h3>
              <p>The backend implements per-operation budgets, a durable ledger, and reconciliation. This checkout uses a local payment fixture; live provider settlement is not configured.</p>
            </Reveal>
          </div>
          <p className="ledger-note">Worker rewards and service spend use separate budgets and records. Live service settlement remains unconfigured in this checkout.</p>
        </section>

        <GuaranteeSection />

        <section className="final-cta">
          <SignalField className="signal-cta" />
          <Reveal>
            <Baton width={136} className="final-baton" />
            <h2>Kill an agent. <em>Watch the job keep going.</em></h2>
            <p className="section-intro">Open the console, start a job under an ENS name, and see Arkiv answer every query the replacement worker makes.</p>
            <Link to="/demo" className="btn btn-primary btn-lg">Launch the browser demo</Link>
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
  const storyRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: storyRef, offset: ["start start", "end end"] });
  const packetX = useTransform(scrollYProgress, [0.08, 0.72], ["0%", "calc(100% - 34px)"]);
  const packetOpacity = useTransform(scrollYProgress, [0.04, 0.12, 0.65, 0.76], [0, 1, 1, 0]);
  const copyY = useTransform(scrollYProgress, [0.68, 0.9], [22, 0]);
  const copyOpacity = useTransform(scrollYProgress, [0.68, 0.88], [0, 1]);
  const reduceMotion = useReducedMotion();
  return (
    <div className="protocol-story" ref={storyRef}>
      <div className="protocol-sticky">
        <div className="protocol-screens" role="group" aria-label="Worker A passes an accepted checkpoint to Worker B">
          <article className="worker-screen screen-a">
            <div className="screen-top"><span className="screen-dots"><i /><i /><i /></span><span>BATON / WORKER A</span><span className="screen-live"><i /> ACTIVE</span></div>
            <div className="screen-body">
              <div className="screen-kicker">01 / STAGE CHECKPOINT</div>
              <h3>Worker A</h3>
              <p>Encrypted state is stored and verified before a milestone is offered.</p>
              <div className="screen-record"><span>CHECKPOINT</span><b>job / milestone-01</b><code>manifest · digest verified</code></div>
              <div className="screen-status"><i /> CHECKPOINT STAGED</div>
            </div>
          </article>
          <div className="screen-bridge" aria-hidden="true">
            <div className="bridge-line"><motion.span className="bridge-packet" style={reduceMotion ? { opacity: 0 } : { x: packetX, opacity: packetOpacity }} /></div>
            <span className="bridge-label">ESCROW ACCEPTS HEAD</span>
          </div>
          <article className="worker-screen screen-b">
            <div className="screen-top"><span className="screen-dots"><i /><i /><i /></span><span>BATON / WORKER B</span><span className="screen-live"><i /> READY</span></div>
            <div className="screen-body">
              <div className="screen-kicker">02 / RECOVER ACCEPTED STATE</div>
              <h3>Worker B</h3>
              <p>The successor verifies the accepted head before authority moves.</p>
              <div className="screen-record"><span>RECOVERY SOURCE</span><b>escrow / accepted-head</b><code>arkiv · ciphertext verified</code></div>
              <div className="screen-status"><i /> READY TO RESUME</div>
            </div>
          </article>
        </div>
        <motion.p className="protocol-note protocol-reveal" style={reduceMotion ? { opacity: 1, y: 0 } : { opacity: copyOpacity, y: copyY }}>
          A stages encrypted work. Escrow accepts one checkpoint. B verifies that exact checkpoint before taking over.
        </motion.p>
      </div>
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

type EnsNodeState = "job" | "dead" | "live";
type EnsNodeData = { label: string; sub: string; state: EnsNodeState };
type EnsGraphNode = Node<EnsNodeData, "ens">;

const ensNode = (id: string, x: number, y: number, width: number, height: number, label: string, sub: string, state: EnsNodeState): EnsGraphNode => ({
  id,
  type: "ens",
  position: { x, y },
  style: { width, height },
  data: { label, sub, state },
});

const ensFlowNodes: EnsGraphNode[] = [
  ensNode("job", 182, 30, 136, 48, "baton.eth", "Job resource", "job"),
  ensNode("agent-a", 8, 220, 220, 58, "worker-a", "Grant revoked", "dead"),
  ensNode("agent-b", 272, 220, 220, 58, "worker-b", "Grant active", "live"),
];

const ensFlowEdges: Edge[] = [
  { id: "job-worker-a", source: "job", sourceHandle: "tree-source", target: "agent-a", targetHandle: "tree-target", type: "smoothstep", className: "ens-edge ens-edge-dead" },
  { id: "job-worker-b", source: "job", sourceHandle: "tree-source", target: "agent-b", targetHandle: "tree-target", type: "smoothstep", className: "ens-edge" },
];

const ensNodeTypes = { ens: EnsGraphNodeView };
const ensFitViewOptions = { padding: 0.015, maxZoom: 1.2 };

function EnsGraphNodeView({ data }: NodeProps<EnsGraphNode>) {
  return (
    <div className={`ens-flow-node ${data.state}`}>
      <Handle type="target" position={Position.Top} id="tree-target" />
      <Handle type="source" position={Position.Bottom} id="tree-source" />
      <span>{data.label}</span>
      <small>{data.sub}</small>
    </div>
  );
}

function EnsMini() {
  const [nodes, , onNodesChange] = useNodesState(ensFlowNodes);
  const [edges, , onEdgesChange] = useEdgesState(ensFlowEdges);

  return (
    <div className="ens-diagram">
      <div className="ens-diagram-head"><span>ENSv2 · Job grant</span><span className="mono">baton.eth</span></div>
      <div className="ens-flow-canvas" role="group" aria-label="A job resource with one revoked worker grant and one active worker grant">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={ensNodeTypes}
          fitView
          fitViewOptions={ensFitViewOptions}
          nodesConnectable={false}
          elementsSelectable={false}
          attributionPosition="top-right"
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
        />
      </div>
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
