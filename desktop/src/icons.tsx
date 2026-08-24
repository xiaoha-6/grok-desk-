import type { ReactNode } from "react";
import type { ActivityCategory } from "./timeline";

type IconProps = { size?: number; className?: string };

export function GrokMark({ size = 24, className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden
    >
      <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
    </svg>
  );
}

function Svg({ size = 15, children, className }: IconProps & { children: ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7">
      {children}
    </svg>
  );
}

export function IconSidebar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M9 4.5v15" />
    </Svg>
  );
}
export function IconCompose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20h4l10.2-10.2a2 2 0 0 0 0-2.8L16 5a2 2 0 0 0-2.8 0L3 15.2V20z" />
      <path d="M12.5 6.5l5 5" />
    </Svg>
  );
}
export function IconFolder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 8.5h6l2 2H20.5v8.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z" />
      <path d="M3.5 8.5V6.8A1.8 1.8 0 0 1 5.3 5h4.1l2 2" />
    </Svg>
  );
}
export function IconGear(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3V21M4.8 7.2l1.9 1.1M17.3 15.7l1.9 1.1M4.8 16.8l1.9-1.1M17.3 8.3l1.9-1.1M3.5 12H5.7M18.3 12H21" />
    </Svg>
  );
}
export function IconTerminal(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M7 10l3 2-3 2M12 14h5" />
    </Svg>
  );
}
export function IconRelay(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 7h8a4 4 0 1 1 0 8h-1" />
      <path d="M17 17H9a4 4 0 1 1 0-8h1" />
      <path d="M15 5l2 2-2 2M9 15l-2 2 2 2" />
    </Svg>
  );
}
export function IconSpark(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 28}>
      <path d="M12 3l1.4 6.1L20 10.5 13.4 12.9 12 21l-1.4-8.1L4 10.5l6.6-1.4z" />
    </Svg>
  );
}
export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 12}>
      <path d="M9 6l6 6-6 6" strokeWidth="2" />
    </Svg>
  );
}
export function IconChevronLeft(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 14}>
      <path d="M15 6l-6 6 6 6" strokeWidth="2" />
    </Svg>
  );
}
export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 11}>
      <path d="M6 9l6 6 6-6" strokeWidth="2" />
    </Svg>
  );
}
export function IconArrowUp(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 13}>
      <path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" strokeWidth="2.2" />
    </Svg>
  );
}
export function IconStop() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
      <rect x="7" y="7" width="10" height="10" rx="1.4" />
    </svg>
  );
}
export function IconClose(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 11}>
      <path d="M6 6l12 12M18 6L6 18" strokeWidth="2" />
    </Svg>
  );
}
export function IconBrain(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.5 7.2a3.2 3.2 0 0 1 3.5-2.7 3.2 3.2 0 0 1 3.5 2.7 3 3 0 0 1 2.3 2.9c0 3.4-2.4 5.2-5.8 8.1-3.4-2.9-5.8-4.7-5.8-8.1A3 3 0 0 1 8.5 7.2z" />
      <path d="M9.2 10.5h2.2M13 13h2" />
    </Svg>
  );
}
export function IconBox(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 8.2 12 4.5l7.5 3.7v7.6L12 19.5 4.5 15.8z" />
      <path d="M12 8.2V19.5M4.5 8.2 12 12l7.5-3.8" />
    </Svg>
  );
}
export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="5.5" />
      <path d="M15.5 15.5 20 20" />
      <path d="M8 8.5h.8M9.2 7.2v.8" />
    </Svg>
  );
}
export function IconFile(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 4.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V6A1.5 1.5 0 0 1 7 4.5z" />
      <path d="M14 4.5V9h4.5" />
    </Svg>
  );
}
export function IconHooks(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 6.5v5a5 5 0 0 0 10 0V8" />
      <path d="M15 6l2 2 2-2" />
      <circle cx="7" cy="5.5" r="1.4" />
    </Svg>
  );
}
export function IconContext(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.8 12a7.2 7.2 0 0 1 12.3-5.1L19 5.2V10h-4.8" />
      <path d="M19.2 12a7.2 7.2 0 0 1-12.3 5.1L5 18.8V14h4.8" />
    </Svg>
  );
}
export function IconPlan(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 7h12M6 12h12M6 17h8" />
      <path d="M4.5 7h0M4.5 12h0M4.5 17h0" />
      <circle cx="4.7" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.7" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.7" cy="17" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}
export function IconHand(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 11.5V6.8a1.3 1.3 0 0 1 2.6 0V11" />
      <path d="M11.6 11V5.8a1.3 1.3 0 0 1 2.6 0V11" />
      <path d="M14.2 11V7.2a1.3 1.3 0 0 1 2.6 0v6.2c0 3-1.8 5.1-4.8 5.1S7.2 16.4 7.2 13.5V12" />
      <path d="M9 12.2 7 10.4a1.3 1.3 0 0 0-1.8 1.8l3.2 4.4" />
    </Svg>
  );
}
export function IconTool(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.5 6.2a3.4 3.4 0 0 0-4.6 4.6L4.5 16.2 7.8 19.5l5.4-5.4a3.4 3.4 0 0 0 4.6-4.6L15.6 11z" />
    </Svg>
  );
}
export function IconPerson(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.5" r="3.2" />
      <path d="M5.5 19.2c.8-3.4 3.2-5.2 6.5-5.2s5.7 1.8 6.5 5.2" />
    </Svg>
  );
}
export function IconArchive(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 7.5h15v3h-15z" />
      <path d="M6 10.5h12V19a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z" />
      <path d="M10 13.5h4" />
    </Svg>
  );
}
export function IconSliders(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8h16M4 16h16" />
      <circle cx="9" cy="8" r="2" />
      <circle cx="15" cy="16" r="2" />
    </Svg>
  );
}
export function IconShield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.5 19 7.2v5.3c0 4.2-3 6.7-7 8-4-1.3-7-3.8-7-8V7.2z" />
    </Svg>
  );
}
export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.8 12a7.2 7.2 0 0 1 12.4-5L19 5.5V10h-4.6" />
      <path d="M19.2 12a7.2 7.2 0 0 1-12.4 5L5 18.5V14h4.6" />
    </Svg>
  );
}
export function IconGauge(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 16.5a7.5 7.5 0 1 1 14 0" />
      <path d="M12 16.5 16 11" />
      <circle cx="12" cy="16.5" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}
export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 6v12M6 12h12" strokeWidth="2" />
    </Svg>
  );
}
export function IconInspector(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M15 4.5v15" />
    </Svg>
  );
}

export function CategoryIcon({ category, size = 16 }: { category: ActivityCategory; size?: number }) {
  switch (category) {
    case "reasoning":
      return <IconBrain size={size} />;
    case "skills":
      return <IconBox size={size} />;
    case "files":
      return <IconSearch size={size} />;
    case "commands":
      return <IconTerminal size={size} />;
    case "hooks":
      return <IconHooks size={size} />;
    case "context":
      return <IconContext size={size} />;
    case "plan":
      return <IconPlan size={size} />;
    case "interactions":
      return <IconHand size={size} />;
    case "system":
      return <IconGauge size={size} />;
    default:
      return <IconTool size={size} />;
  }
}

export function EventKindIcon({ kind, size = 13 }: { kind: string; size?: number }) {
  switch (kind) {
    case "brain":
      return <IconBrain size={size} />;
    case "plan":
      return <IconPlan size={size} />;
    case "context":
      return <IconContext size={size} />;
    case "hooks":
      return <IconHooks size={size} />;
    case "permission":
      return <IconHand size={size} />;
    case "terminal":
      return <IconTerminal size={size} />;
    case "search":
      return <IconSearch size={size} />;
    case "file":
      return <IconFile size={size} />;
    case "skills":
      return <IconBox size={size} />;
    default:
      return <IconTool size={size} />;
  }
}
