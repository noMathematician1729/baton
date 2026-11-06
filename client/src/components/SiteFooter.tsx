import { Link } from "react-router-dom";
import { BatonMark } from "./Baton";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <div className="brand"><BatonMark /><span>BATON</span></div>
          <p>Resumable, verifiable handoff for agent work. Built on ENS, Arkiv, Sepolia and Hedera.</p>
        </div>
        <div className="footer-cols">
          <div>
            <h4>Product</h4>
            <Link to="/console">Live console</Link>
            <Link to="/demo">Browser demo</Link>
            <Link to="/how-it-works">How it works</Link>
            <Link to="/faq">FAQ</Link>
          </div>
          <div>
            <h4>Stack</h4>
            <span>ENSv2 · Sepolia</span>
            <span>Arkiv</span>
            <span>Hedera x402</span>
          </div>
        </div>
      </div>
      <div className="footer-base">
        <span>© 2026 BATON</span>
        <span className="mono">Resumable work · verifiable handoffs</span>
      </div>
    </footer>
  );
}
