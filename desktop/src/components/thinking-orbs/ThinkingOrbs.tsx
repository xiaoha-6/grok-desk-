export function ThinkingOrbs({ className }: { className?: string }) {
  return (
    <span className={["thinking-orbs", className].filter(Boolean).join(" ")} aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}
