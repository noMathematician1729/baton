import { BrowserRouter, Route, Routes } from "react-router-dom";
import { SiteNav } from "../components/SiteNav";
import { Landing } from "../pages/Landing";
import { Console } from "../pages/Console";
import { CoreConsole } from "../pages/CoreConsole";
import { HowItWorks } from "../pages/HowItWorks";
import { Faq, NotFound } from "../pages/Faq";
import { SignalField } from "../components/SignalField";

export function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <SignalField className="signal-global" />
        <a className="skip-link" href="#main-content">Skip to content</a>
        <SiteNav />
        <main id="main-content" tabIndex={-1}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/console" element={<CoreConsole />} />
            <Route path="/demo" element={<Console />} />
            <Route path="/how-it-works" element={<HowItWorks />} />
            <Route path="/faq" element={<Faq />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
