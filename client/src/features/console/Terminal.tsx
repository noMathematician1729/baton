import { useEffect, useRef, useState } from "react";
import { fmtClock, type LogKind, type LogLine } from "./sim";

const FILTERS: { id: string; label: string; kinds: LogKind[] | null }[] = [
  { id: "all", label: "All", kinds: null },
  { id: "arkiv", label: "Arkiv", kinds: ["query", "response", "write", "ttl"] },
  { id: "ens", label: "ENS", kinds: ["ens"] },
  { id: "chain", label: "Escrow", kinds: ["chain", "key"] },
  { id: "x402", label: "x402", kinds: ["x402"] },
];

const TAG: Record<LogKind, string> = {
  query: "→ QUERY", response: "← RESP", write: "✎ WRITE", ens: "ENS", chain: "CHAIN", x402: "x402", ttl: "⏱ TTL", key: "SIGN", sys: "SYS", error: "! ERR",
};

export function Terminal({ logs }: { logs: LogLine[] }) {
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const kinds = FILTERS.find((f) => f.id === filter)!.kinds;
  const shown = kinds ? logs.filter((l) => kinds.includes(l.kind) || (filter === "arkiv" && l.actor === "arkiv")) : logs;
  const lastId = shown.at(-1)?.id;

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastId, filter]);

  return (
    <div className="terminal">
      <div className="terminal-head">
        <div className="term-dots"><i /><i /><i /></div>
        <span className="term-title">simulated event trace</span>
        <button type="button" className="term-toggle" aria-label="Show event payload details" aria-pressed={expanded} onClick={() => setExpanded((v) => !v)} title="Show or hide event payload details">{expanded ? "payloads on" : "payloads off"}</button>
      </div>
      <div className="terminal-tabs" role="group" aria-label="Filter event trace">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={filter === f.id} className={filter === f.id ? "on" : ""} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>
      <div
        className="terminal-body"
        ref={bodyRef}
        role="log"
        aria-label="Simulated event trace"
        aria-live="off"
        tabIndex={0}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
      >
        {!shown.length && <div className="term-empty">$ waiting for job… <span className="caret" /></div>}
        {shown.map((l) => (
          <div key={l.id} className={`term-line k-${l.kind}`}>
            <span className="t-time">{fmtClock(l.t)}</span>
            <span className="t-tag">{TAG[l.kind]}</span>
            <span className="t-main"><span className="t-actor">{l.actor}</span><span className="t-text">{l.text}</span></span>
            {expanded && l.detail && <pre className="t-detail">{l.detail}</pre>}
          </div>
        ))}
        {shown.length > 0 && <div className="term-cursor">$ <span className="caret" /></div>}
      </div>
    </div>
  );
}
