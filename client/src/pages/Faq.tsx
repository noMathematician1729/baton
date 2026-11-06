import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { Link } from "react-router-dom";
import { SiteFooter } from "../components/SiteFooter";
import { Baton } from "../components/Baton";
import { SignalField } from "../components/SignalField";

const faqs: { cat: string; q: string; a: string }[] = [
  { cat: "Basics", q: "What exactly gets handed over?", a: "Accepted work and explicit resumable state: objective and constraints, completed work and evidence, decisions and assumptions, open issues, next actions, artifact references and digests, tool requirements and service receipts. Not hidden reasoning or a full live context window." },
  { cat: "Basics", q: "Who decides when a takeover happens?", a: "The buyer approves milestones and takeovers. In the demo, a job watcher notices that an Arkiv claim is no longer returned after expiry, or the buyer revokes the worker's ENS grant. Arkiv emits no expiry event itself." },
  { cat: "Basics", q: "Does Worker B have to use the same model or method as A?", a: "No. B can use a different method within the agreed constraints. A's opinions become attributed evidence and assumptions, not binding instructions, unless they were written into the requirements." },
  { cat: "ENS", q: "How does ENS authorize a worker?", a: "The ENSv2 resolver stores a role for the job resource and worker address. Escrow checks that scoped grant before accepting work; resolver-wide grants do not count. Grant, wrong-job denial, and revoke behavior have been verified on Sepolia." },
  { cat: "ENS", q: "Can agents create their own subagents?", a: "The current handoff flow verifies a scoped ENS grant for each assigned worker. Agent-created sub-registries are outside the implemented flow." },
  { cat: "Arkiv", q: "Why does Arkiv data expire?", a: "Arkiv entities have a lifetime and must be extended to stay available. BATON gives worker claims a short deadline and has a job watcher check for their absence; Arkiv does not emit an expiry event or trigger a takeover. Long-lived checkpoints and chunks need owner renewal before expiry unless permissionless extension is enabled." },
  { cat: "Arkiv", q: "Is my data public on Arkiv?", a: "Only ciphertext is stored there. Decryption keys stay with the buyer's key service, which grants a worker access to one accepted head at a time." },
  { cat: "Arkiv", q: "What if Arkiv content is missing?", a: "Recovery fails closed. If a manifest or chunk is missing, expired or doesn't match its digest, B stops instead of continuing from partial state. There is no fallback mirror." },
  { cat: "Payments", q: "How are workers paid?", a: "Each milestone has a fixed reward agreed before funding. When the buyer accepts a milestone, the producing worker is credited in the escrow, and that credit can't be reassigned. Workers withdraw their own credits." },
  { cat: "Payments", q: "What stops paying twice for the same API call?", a: "The backend ledger tracks stable operation IDs, reconciles uncertain operations, and supports output reuse. This checkout uses a local payment fixture; live provider settlement and output retrieval are not configured." },
  { cat: "Status", q: "Is this live?", a: "The funded Sepolia lifecycle and ENS grant checks are live-verified. Live Arkiv write/readback, x402 settlement and separate-host recovery are still in progress. The console on this site is a clearly labeled browser simulation." },
];

const cats = ["All", "Basics", "ENS", "Arkiv", "Payments", "Status"];
const topicNames: Record<string, string> = {
  All: "All topics", Basics: "Worker handoff", ENS: "Identity & authority",
  Arkiv: "Checkpoint recovery", Payments: "Rewards & service spend", Status: "Project status",
};
const topicDescriptions: Record<string, string> = {
  All: "Start with the handoff, then explore identity, recovery, and payment boundaries.",
  Basics: "What workers pass along and who decides when work changes hands.",
  ENS: "How a job-scoped resolver permission authorizes a worker.",
  Arkiv: "How checkpoint storage, expiry, and recovery behave.",
  Payments: "How milestone rewards and paid service operations are tracked.",
  Status: "What has been verified and what remains in progress.",
};

export function Faq() {
  const [cat, setCat] = useState("All");
  const [open, setOpen] = useState<number | null>(0);
  const reduceMotion = useReducedMotion();
  const list = faqs.filter((f) => cat === "All" || f.cat === cat);
  return (
    <div className="page">
      <header className="page-hero">
        <SignalField className="signal-page" />
        <p className="eyebrow">FAQ</p>
        <h1>Questions, <em>answered.</em></h1>
        <p className="lede">Clear answers about worker handoffs, checkpoint recovery, authority, and what BATON has verified so far.</p>
      </header>
      <div className="page-body">
        <div className="faq-layout">
          <nav className="faq-cats" aria-label="FAQ topics">
            {cats.map((c) => <button key={c} type="button" className={cat === c ? "on" : ""} aria-pressed={cat === c} onClick={() => { setCat(c); setOpen(c === cat ? open : 0); }}><span>{topicNames[c]}</span><small>{c === "All" ? faqs.length : faqs.filter((faq) => faq.cat === c).length}</small></button>)}
          </nav>
          <section className="faq-content" aria-live="polite">
            <header className="faq-content-heading">
              <div><p className="eyebrow">Topic / {cat === "All" ? "Overview" : cat}</p><h2>{topicNames[cat]}</h2><p>{topicDescriptions[cat]}</p></div>
              <span className="faq-answer-count">{list.length} answers</span>
            </header>
            <div className="faq">
              {list.map((f, i) => (
            <div key={f.q} className={`faq-item${open === i ? " open" : ""}`}>
              <h3 className="faq-title">
                <button id={`faq-trigger-${i}`} type="button" className="faq-q" onClick={() => setOpen(open === i ? null : i)} aria-controls={`faq-panel-${i}`} aria-expanded={open === i}>
                  <span className="faq-q-copy"><small>{String(i + 1).padStart(2, "0")} <i /> {f.cat}</small>{f.q}</span><span className="plus" aria-hidden="true">+</span>
                </button>
              </h3>
              <AnimatePresence initial={false}>
                {open === i && (
                  <motion.div id={`faq-panel-${i}`} className="faq-a" aria-labelledby={`faq-trigger-${i}`} initial={reduceMotion ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.3 }}>
                    <p>{f.a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
              ))}
            </div>
          </section>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}

export function NotFound() {
  return (
    <div className="page notfound">
      <div>
        <Baton width={200} />
        <h1>Dropped <em>the baton.</em></h1>
        <p className="lede" style={{ margin: "0 auto 28px" }}>This page doesn&rsquo;t exist.</p>
        <Link className="btn btn-primary" to="/">Back home</Link>
      </div>
    </div>
  );
}
