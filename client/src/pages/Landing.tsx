import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import type { MotionValue } from "framer-motion";
import { BaseEdge, Handle, Position, ReactFlow, useEdgesState, useNodesState, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { lazy, Suspense, useRef } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CreationHero, type RailSection } from "./landing/CreationHero";
import { SiteFooter } from "../components/SiteFooter";
import { Baton } from "../components/Baton";

const ProtocolScene = lazy(() => import("../components/ProtocolScene").then(({ ProtocolScene: Scene }) => ({ default: Scene })));

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
        </section>

        <GuaranteeSection />

        <section className="final-cta">
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
  return (
    <div className="protocol-wrap">
      <div className="protocol-flow" role="group" aria-label="Worker A stores a checkpoint in Arkiv, escrow records the transaction, and Worker B recovers the checkpoint from Arkiv">
        <span className="sr-only">Worker A stores in Arkiv. Escrow records the accepted transaction. Worker B takes the checkpoint from Arkiv.</span>
        <Suspense fallback={null}>
          <ProtocolScene />
        </Suspense>
      </div>
      <p className="protocol-note">A stores the checkpoint in Arkiv. Escrow records acceptance and credits the worker. B recovers the accepted checkpoint from Arkiv.</p>
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

type EnsNodeState = "job" | "dead" | "live" | "alias";
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
  ensNode("job", 164, 33, 172, 44, "baton.eth", "Job namespace", "job"),
  ensNode("agent-a", 65, 125, 160, 44, "agent-a", "Revoked · subregistry", "dead"),
  ensNode("agent-b", 275, 125, 160, 44, "agent-b", "Active · subregistry", "live"),
  ensNode("fetch-a", 31, 216, 108, 44, "fetch", "agent-a", "dead"),
  ensNode("compute-a", 151, 216, 108, 44, "compute", "agent-a", "dead"),
  ensNode("fetch-b", 241, 216, 108, 44, "fetch", "agent-b", "live"),
  ensNode("compute-b", 361, 216, 108, 44, "compute", "agent-b", "live"),
  ensNode("active-alias", 137, 306, 226, 40, "active.baton.eth", "Resolves to agent-b", "alias"),
];

const ensFlowEdges: Edge[] = [
  { id: "job-agent-a", source: "job", sourceHandle: "tree-source", target: "agent-a", targetHandle: "tree-target", type: "smoothstep", className: "ens-edge" },
  { id: "job-agent-b", source: "job", sourceHandle: "tree-source", target: "agent-b", targetHandle: "tree-target", type: "smoothstep", className: "ens-edge" },
  { id: "agent-a-fetch", source: "agent-a", sourceHandle: "tree-source", target: "fetch-a", targetHandle: "tree-target", type: "smoothstep", className: "ens-edge ens-edge-dead" },
  { id: "agent-a-compute", source: "agent-a", sourceHandle: "tree-source", target: "compute-a", targetHandle: "tree-target", type: "smoothstep", className: "ens-edge ens-edge-dead" },
  { id: "agent-b-fetch", source: "agent-b", sourceHandle: "tree-source", target: "fetch-b", targetHandle: "tree-target", type: "smoothstep", className: "ens-edge" },
  { id: "agent-b-compute", source: "agent-b", sourceHandle: "tree-source", target: "compute-b", targetHandle: "tree-target", type: "smoothstep", className: "ens-edge" },
  { id: "agent-b-alias", source: "agent-b", sourceHandle: "alias-source", target: "active-alias", targetHandle: "alias-target", type: "alias", className: "ens-edge ens-edge-alias" },
];

const ensNodeTypes = { ens: EnsGraphNodeView };
const ensEdgeTypes = { alias: EnsAliasEdge };
const ensFitViewOptions = { padding: 0.06 };

function EnsGraphNodeView({ data }: NodeProps<EnsGraphNode>) {
  return (
    <div className={`ens-flow-node ${data.state}`}>
      <Handle type="target" position={Position.Top} id="tree-target" />
      <Handle type="source" position={Position.Bottom} id="tree-source" />
      {data.state === "live" && <Handle type="source" position={Position.Right} id="alias-source" />}
      {data.state === "alias" && <Handle type="target" position={Position.Right} id="alias-target" />}
      <span>{data.label}</span>
      <small>{data.sub}</small>
    </div>
  );
}

function EnsAliasEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd }: EdgeProps) {
  const laneX = Math.max(sourceX, targetX) + 47;
  const path = `M ${sourceX} ${sourceY} H ${laneX} V ${targetY} H ${targetX}`;
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}

function EnsMini() {
  const [nodes, , onNodesChange] = useNodesState(ensFlowNodes);
  const [edges, , onEdgesChange] = useEdgesState(ensFlowEdges);

  return (
    <div className="ens-diagram">
      <div className="ens-diagram-head"><span>ENSv2 · Job tree</span><span className="mono">baton.eth</span></div>
      <div className="ens-flow-canvas" role="group" aria-label="A job registry with a revoked worker branch and an active successor branch">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={ensNodeTypes}
          edgeTypes={ensEdgeTypes}
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
