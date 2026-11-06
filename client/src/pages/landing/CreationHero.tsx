import { motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";

export type RailSection = { id: string; label: string };

export function CreationHero({ sections }: { sections: RailSection[] }) {
  const reduceMotion = useReducedMotion();
  const entrance = reduceMotion ? false : { opacity: 0, y: 18 };

  return (
    <>
      <section className="creation" aria-labelledby="hero-title">
        <div className="creation-grid">
          <motion.div
            className="hero-copy"
            initial={entrance}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.62, ease: [0.22, 1, 0.36, 1] }}
          >
            <p className="eyebrow"><span className="hero-signal" aria-hidden="true" />Resumable work · verifiable handoffs</p>
            <h1 id="hero-title">When a worker stops,<br /><em>the work carries on.</em></h1>
            <p className="lede">
              BATON is a protocol for resuming long-running agent jobs from the last checkpoint a buyer accepts.
              State stays encrypted, worker authority stays revocable, and rewards stay with the worker who earned them.
            </p>
            <div className="cta-row">
              <Link to="/console" className="btn btn-primary">Open live console <span aria-hidden="true">↗</span></Link>
              <Link to="/how-it-works" className="btn btn-ghost">Read how it works <span aria-hidden="true">→</span></Link>
            </div>
            <ul className="hero-proof" aria-label="Protocol properties">
              <li>Buyer-controlled acceptance</li>
              <li>Encrypted checkpoints</li>
              <li>Scoped worker authority</li>
            </ul>
          </motion.div>

          <motion.div
            className="hero-visual"
            role="img"
            aria-label="Illustrative job trace: the main BATON job line remains active while Worker A's branch goes offline and Worker B's branch lights up from accepted checkpoint M02."
            initial={reduceMotion ? false : { opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.72, delay: reduceMotion ? 0 : 0.12, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="demo-head">
              <span><i className="demo-live" aria-hidden="true" /> Protocol trace <span className="mono">/ 01</span></span>
              <span className="demo-badge">ILLUSTRATIVE · NOT LIVE DATA</span>
            </div>

            <div className="continuity-ui">
              <div className="continuity-head">
                <div className="continuity-identity">
                  <span className="continuity-label">JOB / BATON.ETH</span>
                  <span className="continuity-meta">accepted head · M02</span>
                </div>
                <span className="continuity-state"><i /> RUNNING</span>
              </div>

              <div className="continuity-rail" aria-hidden="true">
                <span className="rail-origin">WORK</span>
                <span className="rail-line"><i /></span>
                <span className="rail-checkpoint"><b>M02</b><small>ACCEPTED</small></span>
                <span className="rail-destination">CONTINUES</span>
              </div>

              <div className="agent-lines">
                <div className="agent-line agent-line-offline">
                  <span className="agent-mark" aria-hidden="true">A</span>
                  <span className="agent-name"><b>Worker A</b><small>PRIMARY WORKER</small></span>
                  <span className="agent-wire" aria-hidden="true"><i /></span>
                  <span className="agent-status is-offline"><i /> STOPPED</span>
                </div>
                <div className="agent-line agent-line-active">
                  <span className="agent-mark" aria-hidden="true">B</span>
                  <span className="agent-name"><b>Worker B</b><small>SUCCESSOR</small></span>
                  <span className="agent-wire" aria-hidden="true"><i /></span>
                  <span className="agent-status"><i /> RESUMED · M02</span>
                </div>
              </div>

              <div className="continuity-result">
                <span><i /> Job stays live</span>
                <small>Authority moves after the successor acknowledges recovery.</small>
              </div>
            </div>

            <div className="demo-foot">
              <div className="demo-sequence" aria-hidden="true">Stage <i /> Accept <i /> Recover <i /> Assign</div>
              <p>Try the sequence in the browser simulation.</p>
            </div>
          </motion.div>
        </div>
      </section>

      <nav className="landing-index" aria-label="Explore BATON sections">
        <span className="landing-index-label">Explore BATON</span>
        <div className="landing-index-links">
          {sections.map((section, index) => (
            <a key={section.id} href={`#${section.id}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>{section.label}
            </a>
          ))}
        </div>
      </nav>
    </>
  );
}
