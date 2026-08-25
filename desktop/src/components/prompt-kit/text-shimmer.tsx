import type { ReactNode } from "react";

export function TextShimmer({
  children,
  className,
  active = true,
}: {
  children: ReactNode;
  className?: string;
  active?: boolean;
}) {
  return (
    <span className={["text-shimmer", active ? "is-on" : "", className].filter(Boolean).join(" ")}>
      {children}
    </span>
  );
}
