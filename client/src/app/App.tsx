import { useEffect, useState } from "react";
import { getApiHealth } from "../lib/api/health";
import { getRuntimeStatus, type RuntimeStatus } from "../lib/api/status";

type ApiStatus = "checking" | "online" | "offline";

const pillars = [
  {
    number: "01",
    title: "Funded work",
    detail: "Agree on deliverables and fixed milestone rewards before a worker starts.",
    tag: "Sepolia escrow",
  },
  {
    number: "02",
    title: "Accepted state",
    detail: "Keep a verifiable checkpoint that another compatible worker can recover.",
    tag: "Arkiv",
  },
  {
    number: "03",
    title: "Controlled services",
    detail: "Route paid work through a budgeted gateway with receipts that survive handoff.",
    tag: "Hedera x402",
  },
];

export function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getApiHealth(controller.signal)
      .then(() => setApiStatus("online"))
      .catch(() => {
        if (!controller.signal.aborted) setApiStatus("offline");
      });
    getRuntimeStatus(controller.signal)
      .then(setRuntimeStatus)
      .catch(() => {
        if (!controller.signal.aborted) setRuntimeStatus(null);
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="console-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="BATON home">
          <span className="wordmark-mark" aria-hidden="true">B</span>
          <span>BATON</span>
        </a>
        <nav className="top-nav" aria-label="Main navigation">
          <a className="nav-active" href="#overview">Overview</a>
          <a href="#lifecycle">Lifecycle</a>
          <a href="#integrations">Integrations</a>
        </nav>
        <div className={`api-indicator api-${apiStatus}`} role="status">
          <span className="status-dot" />
          {apiStatus === "online" ? "API connected" : apiStatus === "offline" ? "API unavailable" : "Connecting"}
        </div>
      </header>

      <section className="hero" id="overview">
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-line" />THE BUYER CONSOLE</p>
          <h1>Good work<br /><em>keeps moving.</em></h1>
          <p className="hero-description">
            Fund a job, accept verified milestones, and hand it to a new worker with its history intact.
          </p>
          <a className="primary-link" href="#lifecycle">
            Explore the workflow <span aria-hidden="true">↘</span>
          </a>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-outer" />
          <div className="orbit orbit-inner" />
          <div className="orbit-node node-one" />
          <div className="orbit-node node-two" />
          <div className="orbit-node node-three" />
          <div className="handoff-core"><span>B</span></div>
          <div className="art-caption"><span className="caption-rule" />STATE, AUTHORITY, REWARDS</div>
        </div>
      </section>

      <section className="lifecycle-section" id="lifecycle">
        <div className="section-heading">
          <div>
            <p className="eyebrow">A CLEAR CHAIN OF CUSTODY</p>
            <h2>Work has a <em>throughline.</em></h2>
          </div>
          <p className="section-intro">Each handoff starts from an accepted task state, with authority and earned rewards accounted for.</p>
        </div>
        <div className="pillar-grid">
          {pillars.map((pillar) => (
            <article className="pillar-card" key={pillar.number}>
              <div className="card-topline">
                <span className="card-number">{pillar.number}</span>
                <span className="card-arrow" aria-hidden="true">↗</span>
              </div>
              <h3>{pillar.title}</h3>
              <p>{pillar.detail}</p>
              <span className="card-tag">{pillar.tag}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="integration-section" aria-labelledby="integration-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">LOCAL CONFIGURATION</p>
            <h2 id="integration-heading">Ready for <em>the next gate.</em></h2>
          </div>
          <p className="section-intro">Configuration presence only. A green status does not mean a live chain or payment integration has passed.</p>
        </div>
        <div className="integration-grid">
          {[
            ["Arkiv writer", runtimeStatus?.configuration.arkiv],
            ["Sepolia escrow", runtimeStatus?.configuration.sepolia],
            ["ENS job grant", runtimeStatus?.configuration.ens],
            ["Hedera x402 payer", runtimeStatus?.configuration.hederaX402],
          ].map(([name, configured]) => (
            <div className="integration-item" key={String(name)}>
              <span className="integration-name">{name}</span>
              <span className={configured ? "integration-value configured" : "integration-value"}>
                {configured === undefined ? "Unknown" : configured ? "Configured" : "Needs setup"}
              </span>
            </div>
          ))}
          <div className="integration-item">
            <span className="integration-name">Payment ledger</span>
            <span className="integration-value">SQLite selected · implementation pending</span>
          </div>
        </div>
      </section>

      <footer id="integrations">
        <span>BATON <span className="footer-separator">/</span> COORDINATED WORK</span>
        <span className="footer-note">Local development scaffold · Integrations require configuration</span>
      </footer>
    </main>
  );
}
