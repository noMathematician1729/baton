const nodes = [
  [72, 52], [190, 112], [345, 46], [490, 135], [640, 60], [820, 118],
  [112, 270], [278, 350], [432, 262], [612, 370], [768, 285], [914, 388],
  [46, 474], [244, 500], [500, 468], [706, 506], [878, 470],
] as const;

const links = [[0, 1], [1, 2], [1, 6], [2, 3], [3, 4], [3, 8], [4, 5], [5, 10], [6, 7], [7, 8], [7, 13], [8, 9], [9, 10], [9, 14], [10, 11], [11, 16], [12, 13], [13, 14], [14, 15], [15, 16]] as const;

/** Lightweight, decorative network field used behind page and section headers. */
export function SignalField({ className = "" }: { className?: string }) {
  return (
    <div className={`signal-field ${className}`} aria-hidden="true">
      <svg viewBox="0 0 960 540" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="signal-line" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--signal-cyan)" />
            <stop offset="1" stopColor="var(--signal-violet)" />
          </linearGradient>
        </defs>
        <g className="signal-links">
          {links.map(([a, b]) => <line key={`${a}-${b}`} x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]} />)}
        </g>
        <g className="signal-nodes">
          {nodes.map(([cx, cy], i) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={i % 4 === 0 ? 3.2 : 2} style={{ animationDelay: `${(i % 7) * -0.45}s` }} />)}
        </g>
        <path className="signal-pulse" d="M72 52 190 112 345 46 490 135 640 60 820 118" />
        <path className="signal-pulse signal-pulse-lower" d="M46 474 244 500 500 468 706 506 878 470" />
      </svg>
      <div className="signal-vignette" />
    </div>
  );
}
