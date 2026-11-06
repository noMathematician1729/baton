import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { BatonMark } from "./Baton";

type Theme = "light" | "dark";

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem("baton-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* storage unavailable */ }
  return "dark";
}

export function SiteNav() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#080b14" : "#f5f7fc");
    try { localStorage.setItem("baton-theme", theme); } catch { /* storage unavailable */ }
  }, [theme]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => { window.scrollTo(0, 0); setMenuOpen(false); }, [pathname]);

  return (
    <header className={`site-nav${scrolled ? " is-scrolled" : ""}${pathname === "/console" || pathname === "/demo" ? " is-app" : ""}${menuOpen ? " menu-open" : ""}`}>
      <div className="site-nav-inner">
        <Link to="/" className="brand" aria-label="BATON home">
          <BatonMark />
          <span>BATON</span>
        </Link>
        <nav className="nav-links" aria-label="Main">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/how-it-works">How it works</NavLink>
          <NavLink to="/faq">FAQ</NavLink>
        </nav>
        <div className="nav-actions">
          <button
            className="theme-toggle"
            aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            )}
          </button>
          <Link to="/console" className="btn btn-primary btn-sm">Launch console</Link>
          <button className="menu-toggle" aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={menuOpen} aria-controls="mobile-menu" onClick={() => setMenuOpen((open) => !open)}>
            <span /><span />
          </button>
        </div>
      </div>
      {menuOpen && (
        <nav className="mobile-nav" id="mobile-menu" aria-label="Mobile main navigation">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/how-it-works">How it works</NavLink>
          <NavLink to="/faq">FAQ</NavLink>
          <Link to="/console" className="btn btn-primary">Launch console <span aria-hidden="true">↗</span></Link>
        </nav>
      )}
    </header>
  );
}
