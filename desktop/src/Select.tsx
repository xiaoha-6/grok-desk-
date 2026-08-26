import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "./icons";

export type SelectOption = {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
};

type Align = "start" | "end";
type Variant = "inline" | "field";

type MenuBox = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

export function Select({
  value,
  options,
  onChange,
  disabled,
  variant = "inline",
  align = "end",
  prefix,
  className,
  menuClassName,
  dense,
  ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  variant?: Variant;
  align?: Align;
  prefix?: ReactNode;
  className?: string;
  menuClassName?: string;
  /** Smaller menu / option footprint for composer chips. */
  dense?: boolean;
  ariaLabel?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const openedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<MenuBox>({ top: 0, left: 0, width: 180, maxHeight: 280 });

  const current = options.find((item) => item.id === value) || options[0];
  const currentId = current?.id ?? value;
  const label = current?.label || value;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 8;
      const hasHints = options.some((item) => Boolean(item.hint));
      const hintFloor = dense ? 210 : 260;
      const hintPreferred = dense ? 228 : 280;
      const minW = variant === "field"
        ? Math.min(hasHints ? (dense ? 240 : 300) : 220, vw - margin * 2)
        : Math.min(Math.max(rect.width, hasHints ? hintPreferred : 140), vw - margin * 2);
      const preferred = Math.max(rect.width, minW);
      const width = Math.min(Math.max(preferred, hasHints ? hintFloor : 140), Math.max(140, vw - margin * 2));
      const leftRaw = align === "end" ? rect.right - width : rect.left;
      const left = Math.min(Math.max(margin, leftRaw), Math.max(margin, vw - width - margin));
      const spaceBelow = Math.max(96, vh - rect.bottom - margin);
      const spaceAbove = Math.max(96, rect.top - margin);
      const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
      const maxHeight = Math.min(dense ? 280 : 320, openUp ? spaceAbove : spaceBelow);
      const top = openUp ? Math.max(margin, rect.top - maxHeight - 4) : rect.bottom + 4;
      setBox({ top, left, width, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, dense, open, variant, options.length]);

  useEffect(() => {
    if (!open) return;
    const index = Math.max(0, options.findIndex((item) => item.id === currentId));
    setActive(index < 0 ? 0 : index);
    const id = window.requestAnimationFrame(() => menuRef.current?.focus());
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(id);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [currentId, open, options]);

  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    const list = menuRef.current?.querySelector<HTMLElement>(".app-select-list");
    const option = list?.querySelector<HTMLElement>(".app-select-option.active");
    if (!list || !option) return;
    if (!openedRef.current) {
      openedRef.current = true;
      list.scrollTop = option.offsetTop;
      return;
    }
    const listRect = list.getBoundingClientRect();
    const optRect = option.getBoundingClientRect();
    if (optRect.bottom > listRect.bottom) list.scrollTop += optRect.bottom - listRect.bottom + 4;
    else if (optRect.top < listRect.top) list.scrollTop -= listRect.top - optRect.top + 4;
  }, [active, open, options.length]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    setActive((index) => (options.length ? Math.min(index, options.length - 1) : 0));
  }, [options.length]);

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (options.length ? (index + 1) % options.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (options.length ? (index - 1 + options.length) % options.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = options[active];
      if (item) choose(item.id);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          className={["app-select-menu", dense ? "dense" : "", menuClassName].filter(Boolean).join(" ")}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel || label}
          aria-activedescendant={options[active] ? `app-select-opt-${active}` : undefined}
          style={{ top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight }}
          onKeyDown={onMenuKey}
        >
          <div className="app-select-list">
            {options.length ? (
              options.map((item, index) => {
                const selected = item.id === currentId;
                return (
                  <button
                    key={`${item.id}-${index}`}
                    id={`app-select-opt-${index}`}
                    className={`app-select-option${selected ? " on" : ""}${index === active ? " active" : ""}${item.icon ? " with-icon" : ""}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    title={item.hint || item.label}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(item.id)}
                  >
                    {item.icon ? <span className="app-select-option-icon">{item.icon}</span> : null}
                    <span className="app-select-option-copy">
                      <span className="app-select-option-name">{item.label}</span>
                      {item.hint ? <span className="app-select-option-id">{item.hint}</span> : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="app-select-empty">—</div>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className={["app-select", variant, className].filter(Boolean).join(" ")}>
      <button
        ref={triggerRef}
        className={`app-select-trigger${open ? " on" : ""}`}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={current?.hint || label}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={onTriggerKey}
      >
        {prefix ? <span className="app-select-prefix">{prefix}</span> : current?.icon ? (
          <span className="app-select-prefix">{current.icon}</span>
        ) : null}
        <span className="app-select-label">{label}</span>
        <IconChevronDown />
      </button>
      {menu}
    </div>
  );
}
