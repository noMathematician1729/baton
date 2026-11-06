import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Baton } from "../../components/Baton";
import { SignalField } from "../../components/SignalField";

export const HANDS_SRC = "/fresco/hands-cutout.webp";
const GAP_X = 0.5;
const GAP_Y = 0.5;

export type RailSection = { id: string; label: string };

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const range = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const cubic = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

export function CreationHero({ sections }: { sections: RailSection[] }) {
  const heroRef = useRef<HTMLElement>(null);
  const frescoRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const sparkRef = useRef<HTMLDivElement>(null);
  const outroRef = useRef<HTMLDivElement>(null);
  const batonRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const railTrackRef = useRef<HTMLDivElement>(null);
  const railFillRef = useRef<HTMLDivElement>(null);
  const captionRefs = useRef<(HTMLParagraphElement | null)[]>([]);

  useEffect(() => {
    let frame = 0;

    const render = () => {
      frame = 0;
      const hero = heroRef.current;
      const fresco = frescoRef.current;
      const baton = batonRef.current;
      if (!hero || !fresco || !baton) return;

      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const heroRect = hero.getBoundingClientRect();
      const travel = Math.max(1, heroRect.height - vh);
      const p = clamp(-heroRect.top / travel);

      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const converge = easeOut(range(p, 0.02, 0.56));
        const shift = (1 - converge) * 30;
        leftRef.current!.style.transform = `translate3d(${-shift}%,0,0)`;
        rightRef.current!.style.transform = `translate3d(${shift}%,0,0)`;
        const frescoFade = range(p, 0.82, 0.9);
        fresco.style.opacity = String(1 - frescoFade * 0.9);
        fresco.style.transform = "none";
        const intro = range(p, 0, 0.18);
        introRef.current!.style.opacity = String(1 - intro);
        introRef.current!.style.transform = "none";
        const caps: [number, number][] = [[0.16, 0.36], [0.36, 0.54], [0.58, 0.76]];
        caps.forEach(([a, b], i) => {
          const el = captionRefs.current[i];
          if (el) {
            el.style.opacity = String(range(p, a, a + 0.06) * (1 - range(p, b - 0.06, b)));
            el.style.transform = "none";
          }
        });
        const spark = range(p, 0.5, 0.6) * (1 - range(p, 0.72, 0.84));
        sparkRef.current!.style.opacity = String(spark);
        sparkRef.current!.style.transform = "translate(-50%,-50%)";
        const outro = range(p, 0.85, 0.97);
        outroRef.current!.style.opacity = String(outro);
        outroRef.current!.style.transform = "none";
        outroRef.current!.style.pointerEvents = outro > 0.5 ? "auto" : "none";
        const fr = fresco.getBoundingClientRect();
        const appear = easeOut(range(p, 0.55, 0.64));
        const batonFade = appear * (1 - range(p, 0.72, 0.84));
        baton.style.width = `${Math.min(170, fr.width * 0.13)}px`;
        baton.style.opacity = String(batonFade);
        baton.style.transform = `translate3d(${fr.left + fr.width * GAP_X}px,${fr.top + fr.height * GAP_Y}px,0) translate(-50%,-50%) rotate(55deg)`;
        if (railRef.current) {
          railRef.current.style.visibility = "hidden";
          railRef.current.style.opacity = "0";
          railRef.current.style.pointerEvents = "none";
        }
        return;
      }

      const converge = easeOut(range(p, 0.02, 0.56));
      const shift = (1 - converge) * 30;
      leftRef.current!.style.transform = `translate3d(${-shift}%,0,0)`;
      rightRef.current!.style.transform = `translate3d(${shift}%,0,0)`;

      const frescoFade = range(p, 0.72, 0.86);
      fresco.style.opacity = String(1 - frescoFade * 0.9);
      fresco.style.transform = `scale(${lerp(1.06, 1, range(p, 0, 0.56)) - frescoFade * 0.04})`;

      const intro = range(p, 0, 0.16);
      introRef.current!.style.opacity = String(1 - intro);
      introRef.current!.style.transform = `translate3d(0,${-intro * 40}px,0)`;

      const caps: [number, number][] = [[0.16, 0.36], [0.36, 0.54], [0.58, 0.76]];
      caps.forEach(([a, b], i) => {
        const el = captionRefs.current[i];
        if (!el) return;
        const t = range(p, a, a + 0.04) * (1 - range(p, b - 0.04, b));
        el.style.opacity = String(t);
        el.style.transform = `translate3d(0,${(1 - t) * 14}px,0)`;
      });

      const spark = range(p, 0.5, 0.6) * (1 - range(p, 0.72, 0.84));
      sparkRef.current!.style.opacity = String(spark);
      sparkRef.current!.style.transform = `translate(-50%,-50%) scale(${0.6 + spark * 0.6})`;
      sparkRef.current!.style.setProperty("--spark-progress", String(spark));

      const outro = range(p, 0.85, 0.97);
      outroRef.current!.style.opacity = String(outro);
      outroRef.current!.style.transform = `translate3d(0,${(1 - outro) * 24}px,0)`;
      outroRef.current!.style.pointerEvents = outro > 0.5 ? "auto" : "none";

      // The baton appears at an angle, then turns upright as it docks on the reading rail.
      const fr = fresco.getBoundingClientRect();
      const gapX = fr.left + fr.width * GAP_X;
      const gapY = fr.top + fr.height * GAP_Y;
      const wide = vw >= 1280;
      const railTrack = railTrackRef.current?.getBoundingClientRect();
      const railX = railTrack ? railTrack.left - 26 : Math.max(0, (vw - 1280) / 2) + 17;
      const railTop = vh * 0.24;
      const railLen = vh * 0.52;

      const doc = document.documentElement;
      const after = clamp((window.scrollY - (hero.offsetTop + travel)) / Math.max(1, doc.scrollHeight - vh - (hero.offsetTop + travel)));
      const railY = railTop + after * railLen;

      const appear = easeOut(range(p, 0.55, 0.64));
      const fly = ease(range(p, 0.72, 0.97));
      const flight = ease(range(p, 0.72, 0.91));
      const settle = easeOut(range(p, 0.91, 0.97));
      const batonW = Math.min(170, fr.width * 0.13);
      const flightX = cubic(gapX, gapX - vw * 0.08, railX + Math.max(90, vw * 0.06), railX - 14, flight);
      const flightY = cubic(gapY, gapY - vh * 0.28, railY + vh * 0.08, railY - 12, flight);
      const x = wide ? lerp(flightX, railX, settle) : gapX;
      const y = wide ? lerp(flightY, railY, settle) : lerp(gapY, gapY - 80, fly);
      const rot = wide ? lerp(lerp(55, 96, flight), 90, settle) : 55;
      const scale = (wide ? lerp(1, 0.52, fly) : 1) * lerp(0.4, 1, appear);
      const opacity = wide ? appear : appear * (1 - fly);
      baton.style.width = `${batonW}px`;
      baton.style.opacity = String(opacity);
      baton.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-50%) rotate(${rot}deg) scale(${scale})`;

      const rail = railRef.current;
      if (rail) {
        const railOn = wide ? range(p, 0.86, 0.96) : 0;
        rail.style.opacity = String(railOn);
        rail.style.visibility = railOn > 0.02 ? "visible" : "hidden";
        rail.style.pointerEvents = railOn > 0.5 ? "auto" : "none";
        railFillRef.current!.style.transform = `scaleY(${after})`;
        const idx = Math.min(sections.length - 1, Math.floor(after * sections.length + 0.0001));
        rail.querySelectorAll<HTMLElement>(".rail-tick").forEach((t, i) => {
          const active = p >= 1 && i === idx;
          t.classList.toggle("is-active", active);
          if (active) t.setAttribute("aria-current", "location");
          else t.removeAttribute("aria-current");
        });
      }
    };

    const request = () => { if (!frame) frame = requestAnimationFrame(render); };
    render();
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);
    return () => {
      window.removeEventListener("scroll", request);
      window.removeEventListener("resize", request);
      cancelAnimationFrame(frame);
    };
  }, [sections.length]);

  const jump = (id: string) => {
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    document.getElementById(id)?.scrollIntoView({ behavior, block: "start" });
  };

  return (
    <>
      <section ref={heroRef} className="creation" aria-label="Introduction">
        <div className="creation-stage">
          <SignalField className="signal-hero" />
          <div ref={introRef} className="creation-intro">
            <p className="eyebrow">The handoff layer for agent work</p>
            <h1>Work that outlives <em>its worker.</em></h1>
          </div>

          <div ref={frescoRef} className="fresco" role="img" aria-label="Two Renaissance-inspired hands reaching toward each other">
            <div ref={leftRef} className="fresco-half fresco-left">
              <img src={HANDS_SRC} alt="" draggable={false} />
            </div>
            <div ref={rightRef} className="fresco-half fresco-right">
              <img src={HANDS_SRC} alt="" draggable={false} />
            </div>
            <div ref={sparkRef} className="fresco-spark" />
          </div>

          <div className="creation-captions" aria-hidden="true">
            <p ref={(el) => { captionRefs.current[0] = el; }}>Worker A has carried the job as far as it can.</p>
            <p ref={(el) => { captionRefs.current[1] = el; }}>Worker B reaches in, verified and ready.</p>
            <p ref={(el) => { captionRefs.current[2] = el; }}>The baton passes. <em>Accepted work carries forward.</em></p>
          </div>

          <div ref={outroRef} className="creation-outro">
            <p className="eyebrow">BATON</p>
            <h2>Fund a job once. Let any verified worker <em>finish it.</em></h2>
            <p className="lede">
              Accepted checkpoints live encrypted on Arkiv, worker authority is a revocable ENS name,
              and earned rewards stay with whoever earned them. When an agent dies, the next one picks up
              exactly where the last accepted step left off.
            </p>
            <div className="cta-row">
              <Link to="/demo" className="btn btn-primary">Preview a handoff</Link>
              <a className="btn btn-ghost" href="#problem" onClick={(e) => { e.preventDefault(); jump("problem"); }}>How it works ↓</a>
            </div>
          </div>

        </div>
      </section>

      <div ref={batonRef} className="flying-baton" aria-hidden="true">
        <Baton width={170} />
      </div>

      <nav ref={railRef} className="baton-rail" aria-label="Page sections">
        <div ref={railTrackRef} className="rail-track"><div ref={railFillRef} className="rail-fill" /></div>
        <ol>
          {sections.map((s, i) => (
            <li key={s.id}>
              <button className="rail-tick" aria-label={`${i + 1}. ${s.label}`} onClick={() => jump(s.id)}>
                <span className="rail-num">{String(i + 1).padStart(2, "0")}</span>
                <span className="rail-label">{s.label}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}
