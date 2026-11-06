import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { Link } from "react-router-dom";
import { SiteFooter } from "../components/SiteFooter";

const flow = [
  {
    t: "Stage the work",
    decision: "Write encrypted state first. Offer a milestone only after its artifacts can be read back and verified.",
    d: "Worker A stores a manifest and artifact chunks on Arkiv, then signs an offer that points to the proposed checkpoint. The upload alone is not canonical.",
    usedBy: ["Worker A", "Arkiv", "EIP-712"],
    code: `<span class="c">// worker A stores a proposed checkpoint</span>
<span class="k">arkiv</span>.createEntity({ type: <span class="s">"chunk"</span>, job: <span class="s">"baton.eth"</span>, seq: 0 })
<span class="k">arkiv</span>.createEntity({ type: <span class="s">"manifest"</span>, epoch: 1, milestone: 1 })
<span class="k">sign</span>(MilestoneOffer{ job, epoch: 1, head })`,
  },
  {
    t: "Accept one head",
    decision: "Let escrow decide what counts. Only an accepted checkpoint can seed recovery.",
    d: "The buyer transaction checks the ENS grant, worker assignment, epoch, expected head and signature. It advances the head and credits the worker who earned the milestone.",
    usedBy: ["Sepolia escrow", "ENSv2", "Buyer"],
    code: `<span class="c">// buyer accepts the signed offer</span>
<span class="k">escrow</span>.acceptMilestone(job, offer)
<span class="c">//  ✓ live ENS grant · epoch · expected head</span>
<span class="c">//  → head = m1 · credits[A] += 3</span>`,
  },
  {
    t: "Recover and take over",
    decision: "Recover only the accepted head, then move authority after B acknowledges that checkpoint and epoch.",
    d: "Worker B reads the escrow head, fetches its exact manifest and chunks from Arkiv, verifies digests and decrypts with a buyer-granted key. B acknowledges the head and epoch; escrow increments the epoch and assigns B, so A's stale offers are rejected.",
    usedBy: ["Worker B", "Arkiv", "ENSv2", "Sepolia escrow"],
    code: `<span class="c">// worker B follows the accepted head</span>
<span class="k">const head</span> = await escrow.head(job)
<span class="k">const artifacts</span> = await arkiv.query(manifestFor(head))
verify(artifacts, head.digest)
decrypt(artifacts, buyerGrant(B, head))
<span class="c">// acknowledgement moves authority</span>
await escrow.takeover(job, ackFor(head, epoch))
<span class="c">// stale offers from A now fail</span>`,
  },
];

const boundaries = [
  ["No lossless cross-model continuation", "Accepted artifacts survive. An agent's hidden reasoning or full context window does not."],
  ["No credential export", "A tool manifest describes dependencies, not access. Each successor establishes its own authorized connections."],
  ["No exactly-once by magic", "A durable operation ledger and provider idempotency help reconcile uncertain responses; neither makes an external provider infallible."],
  ["Buyer-controlled acceptance", "The contract enforces signed rules, not subjective truth. Independent arbitration needs its own mechanism."],
];

export function HowItWorks() {
  const reduceMotion = useReducedMotion();
  const [activeStep, setActiveStep] = useState(0);
  return (
    <div className="page">
      <header className="page-hero how-hero">
        <p className="eyebrow">How it works</p>
        <h1>A relay race with <em>receipts.</em></h1>
        <p className="lede">Three moments make a worker handoff verifiable: stage the work, accept one head, then recover it before authority moves.</p>
      </header>

      <div className="page-body how-body">
        <section className="architecture-section" aria-label="BATON handoff architecture">
          <div className="architecture-intro">
            <p className="eyebrow">One checkpoint · three moments</p>
            <h2>State moves forward.<br /><em>Authority moves last.</em></h2>
          </div>

          <div className="architecture-walkthrough">
            <aside className="architecture-side" aria-label="Live architecture map">
              <div className="architecture-side-head">
                <span>Handoff map</span>
                <span className="architecture-live"><i /> Phase {activeStep + 1} of {flow.length}</span>
              </div>
              <ArchitectureMap activeStep={activeStep} />
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeStep}
                  className="architecture-current"
                  initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: reduceMotion ? 0 : -5 }}
                  transition={{ duration: reduceMotion ? 0.2 : 0.35 }}
                  aria-live="polite"
                >
                  <span className="architecture-current-label">At this point</span>
                  <p>{flow[activeStep].decision}</p>
                  <div className="architecture-tags">{flow[activeStep].usedBy.map((name) => <span key={name}>{name}</span>)}</div>
                </motion.div>
              </AnimatePresence>
            </aside>

            <div className="architecture-steps">
              {flow.map((item, i) => (
                <motion.article
                  key={item.t}
                id={`phase-${i + 1}`}
                  className={`architecture-step${activeStep === i ? " active" : ""}`}
                  initial={{ opacity: 0, y: reduceMotion ? 0 : 28 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.24 }}
                  onViewportEnter={() => setActiveStep(i)}
                  transition={{ duration: reduceMotion ? 0.22 : 0.6, ease: [0.22, 1, 0.36, 1] }}
                  aria-current={activeStep === i ? "step" : undefined}
                >
                  <div className="architecture-step-meta"><span>0{i + 1}</span><i />{item.usedBy[0]}</div>
                  <h3>{item.t}</h3>
                  <p className="architecture-decision"><b>Decision</b>{item.decision}</p>
                  <p className="architecture-description">{item.d}</p>
                  <div className="architecture-tags step-tags">{item.usedBy.map((name) => <span key={name}>{name}</span>)}</div>
                  <details className="architecture-code">
                    <summary>View transaction detail</summary>
                    <pre className="flow-code" dangerouslySetInnerHTML={{ __html: item.code }} />
                  </details>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        <section className="page-section boundaries-section">
          <p className="eyebrow">Boundaries</p>
          <h2>What BATON <em>doesn&rsquo;t</em> promise.</h2>
          <div className="boundaries">
            {boundaries.map(([title, description], i) => (
              <motion.article
                key={title}
                className="boundary"
                initial={{ opacity: 0, y: reduceMotion ? 0 : 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.25 }}
                transition={{ duration: reduceMotion ? 0.22 : 0.48, delay: reduceMotion ? 0 : i * 0.07 }}
              >
                <span className="boundary-index">0{i + 1}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </motion.article>
            ))}
          </div>
        </section>

        <motion.section
          className="page-section how-cta"
          initial={{ opacity: 0, y: reduceMotion ? 0 : 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: reduceMotion ? 0.22 : 0.55 }}
        >
          <p className="eyebrow">Watch the handoff</p>
          <h2>See the job <em>keep going.</em></h2>
          <p className="section-intro">Start a browser simulation. Kill a worker, watch its ENS branch turn inactive, and see its successor recover the last accepted checkpoint.</p>
          <div className="cta-flow" aria-label="BATON handoff sequence">
            <div className="cta-flow-head">
              <span>Handoff sequence</span>
              <span className="mono">CHECKPOINT BOUND · BUYER CONTROLLED</span>
            </div>
            <ol className="cta-flow-steps">
              <li><span className="cta-flow-number">01</span><span><b>Stage</b><small>Encrypted state is stored</small></span></li>
              <li><span className="cta-flow-number">02</span><span><b>Accept</b><small>Buyer anchors one head</small></span></li>
              <li><span className="cta-flow-number">03</span><span><b>Recover</b><small>Successor verifies that head</small></span></li>
              <li><span className="cta-flow-number">04</span><span><b>Assign</b><small>Authority moves after ACK</small></span></li>
            </ol>
          </div>
          <Link className="btn btn-primary btn-lg" to="/demo">Preview a handoff <span aria-hidden="true">↗</span></Link>
        </motion.section>
      </div>
      <SiteFooter />
    </div>
  );
}

function ArchitectureMap({ activeStep }: { activeStep: number }) {
  const wire = (steps: number[]) => `arch-wire${steps.includes(activeStep) ? " active" : ""}`;
  const node = (name: string, steps: number[]) => `arch-node${steps.includes(activeStep) ? " active" : ""} arch-${name}`;
  return (
    <svg className="architecture-map" viewBox="0 0 440 280" role="img" aria-labelledby="architecture-map-title">
      <title id="architecture-map-title">Worker A stages encrypted state; escrow accepts a checkpoint; Worker B recovers it and takes over.</title>
      <defs>
        <marker id="arch-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 8 4 0 8Z" /></marker>
      </defs>
      <path className={wire([0])} d="M118 132 C142 132 141 40 166 40" markerEnd="url(#arch-arrow)" />
      <path className={wire([0, 1])} d="M220 68 V110" markerEnd="url(#arch-arrow)" />
      <path className={wire([1, 2])} d="M220 210 V166" markerEnd="url(#arch-arrow)" />
      <path className={wire([2])} d="M274 40 C303 40 300 114 322 122" markerEnd="url(#arch-arrow)" />
      <path className={wire([2])} d="M274 145 H322" markerEnd="url(#arch-arrow)" />
      <path className={wire([2])} d="M376 162 V210" markerEnd="url(#arch-arrow)" />
      <text className="arch-wire-label" x="138" y="99">write</text>
      <text className="arch-wire-label" x="228" y="94">head</text>
      <text className="arch-wire-label" x="228" y="194">grant</text>
      <text className="arch-wire-label" x="294" y="85">recover</text>
      <text className="arch-wire-label" x="284" y="139">assign</text>
      <text className="arch-wire-label" x="383" y="193">receipts</text>
      <g className={node("worker-a", [0])}>
        <rect x="12" y="110" width="106" height="52" rx="12" />
        <text className="arch-node-title" x="65" y="133" textAnchor="middle">Worker A</text>
        <text className="arch-node-sub" x="65" y="149" textAnchor="middle">signs result</text>
      </g>
      <g className={node("arkiv", [0, 1, 2])}>
        <rect x="166" y="12" width="108" height="56" rx="12" />
        <text className="arch-node-title" x="220" y="36" textAnchor="middle">Arkiv</text>
        <text className="arch-node-sub" x="220" y="52" textAnchor="middle">encrypted state</text>
      </g>
      <g className={node("escrow", [1, 2])}>
        <rect x="166" y="110" width="108" height="56" rx="12" />
        <text className="arch-node-title" x="220" y="134" textAnchor="middle">Sepolia</text>
        <text className="arch-node-sub" x="220" y="150" textAnchor="middle">accepted head</text>
      </g>
      <g className={node("ens", [1, 2])}>
        <rect x="166" y="210" width="108" height="56" rx="12" />
        <text className="arch-node-title" x="220" y="234" textAnchor="middle">ENSv2</text>
        <text className="arch-node-sub" x="220" y="250" textAnchor="middle">scoped grant</text>
      </g>
      <g className={node("worker-b", [2])}>
        <rect x="322" y="110" width="108" height="52" rx="12" />
        <text className="arch-node-title" x="376" y="133" textAnchor="middle">Worker B</text>
        <text className="arch-node-sub" x="376" y="149" textAnchor="middle">successor</text>
      </g>
      <g className={node("gateway", [2])}>
        <rect x="322" y="210" width="108" height="56" rx="12" />
        <text className="arch-node-title" x="376" y="234" textAnchor="middle">Service gateway</text>
        <text className="arch-node-sub" x="376" y="250" textAnchor="middle">budgeted calls</text>
      </g>
    </svg>
  );
}
