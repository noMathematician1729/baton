export function Baton({ width = 180, className }: { width?: number; className?: string }) {
  return (
    <svg className={className} width={width} viewBox="0 0 260 68" aria-hidden="true">
      <path
        d="M12 33.5c58-.5 133-2 186-5.5 7-.5 11-4 16-9 4-4 7-5 10-3 9 5 17 11 24 17.5 1 1 1 2 0 3-7 6.5-15 12.5-24 17.5-3 2-6 1-10-3-5-5-9-8.5-16-9-53-3.5-128-5-186-5.5-3 0-4-.8-4-2C8 33.5 9 33.5 12 33.5Z"
        fill="var(--walnut)"
      />
    </svg>
  );
}

export function BatonMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 28 28" width="28" height="28">
        <path
          d="M4 2.4c.8-.8 1.8-.5 2.4.4l12.2 15.6c.7.8 2.2 1.1 3.3 2.1l3.7 3.6c.5.5.5 1.1 0 1.5l-2.7 1.7c-.5.3-1.2.1-1.6-.4l-2.4-3.4c-.7-.8-1.8-1.3-2.7-2.2L3.4 4.5C2.8 3.8 3.2 3 4 2.4Z"
          fill="var(--walnut)"
        />
      </svg>
    </span>
  );
}
