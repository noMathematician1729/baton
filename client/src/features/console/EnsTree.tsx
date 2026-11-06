import { AnimatePresence, motion } from "framer-motion";
import { useMemo } from "react";
import type { TreeNode, Worker } from "./sim";

const W = 252;
const H = 88;
const GAP_X = 30;
const GAP_Y = 76;

type Pos = { x: number; y: number };

function layout(nodes: TreeNode[]) {
  const kids = new Map<string | null, TreeNode[]>();
  nodes.forEach((n) => { const arr = kids.get(n.parent) ?? []; arr.push(n); kids.set(n.parent, arr); });
  const pos = new Map<string, Pos>();
  let cursor = 0;
  const place = (n: TreeNode, depth: number): number => {
    const c = kids.get(n.id) ?? [];
    let x: number;
    if (!c.length) { x = cursor; cursor += W + GAP_X; }
    else { const xs = c.map((k) => place(k, depth + 1)); x = (xs[0] + xs[xs.length - 1]) / 2; }
    pos.set(n.id, { x, y: depth * (H + GAP_Y) });
    return x;
  };
  (kids.get(null) ?? []).forEach((r) => place(r, 0));
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const minX = Math.min(0, ...xs), maxX = Math.max(W, ...xs.map((x) => x + W));
  const maxY = Math.max(H, ...ys.map((y) => y + H));
  const contentWidth = maxX - minX;
  const width = Math.max(contentWidth + 72, 560);
  const centerOffset = (width - (contentWidth + 72)) / 2;
  if (centerOffset > 0) pos.forEach((point) => { point.x += centerOffset; });
  return { pos, box: { x: minX - 36, y: -24, w: width, h: maxY + 52 } };
}

const STATUS_TEXT: Record<TreeNode["status"], string> = {
  booting: "minting",
  live: "ready",
  working: "working",
  recovering: "recovering",
  dead: "dead",
  done: "complete",
};

const ROLE_TEXT: Record<TreeNode["role"], string> = {
  job: "JOB ROOT",
  primary: "WORKER",
  sub: "DELEGATED",
};

function ensOwner(node: TreeNode, workers: Worker[]) {
  return node.records.owner
    ?? node.records["baton.worker"]
    ?? workers.find((worker) => worker.id === node.worker)?.addr
    ?? node.records["baton.parent"]
    ?? "assignment pending";
}

export function EnsTree({ nodes, workers, selected, onSelect }: { nodes: TreeNode[]; workers: Worker[]; selected?: string; onSelect: (id?: string) => void }) {
  const { pos, box } = useMemo(() => layout(nodes), [nodes.length, nodes.map((n) => n.id).join()]);

  if (!nodes.length) {
    return (
      <div className="tree-empty">
        <svg className="tree-empty-diagram" viewBox="0 0 480 174" aria-hidden="true">
          <g className="tree-preview-links" fill="none">
            <path d="M240 55V78M240 78H113V103M240 78H367V103" />
          </g>
          <g className="tree-preview-root">
            <rect x="145" y="10" width="190" height="46" rx="15" />
            <text x="240" y="30" textAnchor="middle">baton.eth</text>
            <text className="tree-preview-owner" x="240" y="46" textAnchor="middle">owner · buyer</text>
          </g>
          <g className="tree-preview-node">
            <rect x="18" y="102" width="190" height="52" rx="15" />
            <text x="113" y="125" textAnchor="middle">agent-a.baton.eth</text>
            <text className="tree-preview-owner" x="113" y="141" textAnchor="middle">primary · delegated</text>
          </g>
          <g className="tree-preview-node standby">
            <rect x="272" y="102" width="190" height="52" rx="15" />
            <text x="367" y="125" textAnchor="middle">agent-b.baton.eth</text>
            <text className="tree-preview-owner" x="367" y="141" textAnchor="middle">standby · ready</text>
          </g>
        </svg>
        <p>One job. A tree of accountable workers.</p>
        <span>Set the primary and standby workers, then start the simulation to watch ENS names, delegated branches and Arkiv claims build in real time.</span>
      </div>
    );
  }

  return (
    <svg
      className="ens-tree"
      role="group"
      aria-label="ENS job and delegated worker tree"
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      width={box.w}
      height={box.h}
      onClick={() => onSelect(undefined)}
    >
      <title>ENS job tree</title>
      <desc>Each card is an ENS name. Focus or select a card to inspect its owner, status and delegated names.</desc>
      <g className="tree-links">
        <AnimatePresence>
          {nodes.filter((n) => n.parent).map((n) => {
            const a = pos.get(n.parent!), b = pos.get(n.id);
            if (!a || !b) return null;
            const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y;
            const my = (y1 + y2) / 2;
            return (
              <motion.path
                key={`l-${n.id}`}
                className={`tree-link ${n.status}`}
                d={`M${x1} ${y1} C${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.6, ease: "easeOut" }}
              />
            );
          })}
        </AnimatePresence>
      </g>
      <AnimatePresence>
        {nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const isSel = selected === n.id;
          const owner = ensOwner(n, workers);
          return (
            <motion.g
              key={n.id}
              role="button"
              tabIndex={0}
              aria-label={`${n.ens}, ${ROLE_TEXT[n.role].toLowerCase()}, ${STATUS_TEXT[n.status]}. Owner: ${owner}`}
              aria-pressed={isSel}
              className={`tree-node ${n.role} ${n.status}${isSel ? " selected" : ""}`}
              initial={{ opacity: 0, x: p.x, y: p.y - 18 }}
              animate={{ opacity: 1, x: p.x, y: p.y }}
              transition={{ type: "spring", stiffness: 140, damping: 18 }}
              onClick={(e) => { e.stopPropagation(); onSelect(n.id); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onSelect(n.id); }
                if (e.key === "Escape") { e.stopPropagation(); onSelect(undefined); }
              }}
            >
              {(n.status === "working" || n.status === "recovering") && <rect className="node-pulse" x={-4} y={-4} width={W + 8} height={H + 8} rx="21" />}
              <rect className="node-body" width={W} height={H} rx="18" />
              <rect className="node-status-bg" x="14" y="11" width="92" height="20" rx="10" />
              <circle className="node-dot" cx="25" cy="21" r="3.5" />
              <text className="node-state" x="34" y="24">{STATUS_TEXT[n.status]}</text>
              <text className="node-role" x={W - 14} y="24" textAnchor="end">{ROLE_TEXT[n.role]}</text>
              <text className="node-label" x="16" y="53" textLength={Math.min(n.ens.length * 8.1, W - 32)} lengthAdjust="spacingAndGlyphs">{n.ens}</text>
              <line className="node-divider" x1="16" y1="61" x2={W - 16} y2="61" />
              <text className="node-owner" x="16" y="77">owner: {owner}</text>
              <title>{n.ens}</title>
            </motion.g>
          );
        })}
      </AnimatePresence>
    </svg>
  );
}
