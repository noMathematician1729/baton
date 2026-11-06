import { BrowserRouter, Route, Routes } from "react-router-dom";
import { SiteNav } from "../components/SiteNav";
import { Landing } from "../pages/Landing";
import { BrowserDemo } from "../pages/Console";
import { CoreConsole } from "../pages/CoreConsole";
import { LiveConsole } from "../pages/LiveConsole";
import { HowItWorks } from "../pages/HowItWorks";
import { Faq, NotFound } from "../pages/Faq";

export function App() {
  return (
    <BrowserRouter>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <SiteNav />
      <main id="main-content" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/console" element={<CoreConsole />} />
          <Route path="/jobs" element={<LiveConsole />} />
          <Route path="/demo" element={<BrowserDemo />} />
          <Route path="/how-it-works" element={<HowItWorks />} />
          <Route path="/faq" element={<Faq />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
