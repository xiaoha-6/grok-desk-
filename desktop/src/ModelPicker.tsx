import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown, IconSearch } from "./icons";
import type { CatalogModel } from "./types";

type Align = "start" | "end";
type Variant = "inline" | "field";

type MenuBox = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

function modelLabel(item?: CatalogModel | null, fallback = "") {
  if (!item) return fallback;
  return item.name || item.id || fallback;
}

function modelHint(item?: CatalogModel | null) {
  if (!item) return "";
  if (item.name && item.name !== item.id) return `${item.name} · ${item.id}`;
  return item.name || item.id || "";
}

export function ModelPicker({
  value,
  options,
  onChange,
  disabled,
  variant = "inline",
  align = "end",
  allowCustom,
  searchPlaceholder,
  emptyLabel,
  customPlaceholder,
}: {
  value: string;
  options: CatalogModel[];
  onChange: (value: string) => void;
  disabled?: boolean;
  variant?: Variant;
  align?: Align;
  allowCustom?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  customPlaceholder?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const openedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<MenuBox>({ top: 0, left: 0, width: 280, maxHeight: 320 });

  const current = options.find((item) => item.id === value) || options[0];
  const currentId = current?.id || value;
  const label = modelLabel(current, value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((item) => {
      const name = (item.name || "").toLowerCase();
      const id = (item.id || "").toLowerCase();
      return name.includes(needle) || id.includes(needle);
    });
  }, [options, query]);
  const showSearch = options.length > 6;
  const customValue = allowCustom ? query.trim() : "";
  const showCustom =
    Boolean(customValue) && !options.some((item) => item.id.toLowerCase() === customValue.toLowerCase());
  const rows = showCustom ? [...filtered, { id: customValue, name: customValue }] : filtered;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 8;
      const minW = variant === "field" ? Math.min(320, vw - margin * 2) : Math.min(280, vw - margin * 2);
      const width = Math.min(Math.max(rect.width, minW), Math.max(160, vw - margin * 2));
      const leftRaw = align === "end" ? rect.right - width : rect.left;
      const left = Math.min(Math.max(margin, leftRaw), Math.max(margin, vw - width - margin));
      const spaceBelow = Math.max(96, vh - rect.bottom - margin);
      const spaceAbove = Math.max(96, rect.top - margin);
      const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
      const maxHeight = Math.min(360, openUp ? spaceAbove : spaceBelow);
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
  }, [align, open, variant, rows.length, showSearch]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const index = Math.max(0, options.findIndex((item) => item.id === currentId));
    setActive(index < 0 ? 0 : index);
    const id = window.requestAnimationFrame(() => {
      if (showSearch) searchRef.current?.focus();
      else menuRef.current?.focus();
    });
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
  }, [currentId, open, options, showSearch]);

  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    const list = menuRef.current?.querySelector<HTMLElement>(".model-picker-list");
    const option = list?.querySelector<HTMLElement>(".model-picker-option.active");
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
  }, [active, open, rows.length]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    setActive((index) => (rows.length ? Math.min(index, rows.length - 1) : 0));
  }, [rows.length]);

  function choose(id: string) {
    if (!id) return;
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
      setActive((index) => (rows.length ? (index + 1) % rows.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (rows.length ? (index - 1 + rows.length) % rows.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = rows[active];
      if (item) choose(item.id);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  if (!options.length && allowCustom) {
    return (
      <input
        className={variant === "field" ? undefined : "model-mini"}
        value={value}
        spellCheck={false}
        disabled={disabled}
        placeholder={customPlaceholder || "grok-4.5"}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          className="model-picker-menu"
          role="listbox"
          tabIndex={-1}
          aria-label={searchPlaceholder || "models"}
          aria-activedescendant={rows[active] ? `model-opt-${active}` : undefined}
          style={{ top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight }}
          onKeyDown={onMenuKey}
        >
          {showSearch ? (
            <label className="model-picker-search">
              <IconSearch />
              <input
                ref={searchRef}
                value={query}
                placeholder={searchPlaceholder}
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  onMenuKey(event);
                }}
              />
            </label>
          ) : null}
          <div className="model-picker-list" style={{ maxHeight: Math.max(96, box.maxHeight - (showSearch ? 52 : 12)) }}>
            {rows.length ? (
              rows.map((item, index) => {
                const selected = item.id === currentId;
                const custom = Boolean(showCustom && index >= filtered.length);
                return (
                  <button
                    key={`${item.id}-${index}`}
                    id={`model-opt-${index}`}
                    className={`model-picker-option${selected ? " on" : ""}${index === active ? " active" : ""}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    title={modelHint(item)}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(item.id)}
                  >
                    <span className="model-picker-option-name">{custom ? item.id : modelLabel(item)}</span>
                    {!custom && item.name && item.name !== item.id ? (
                      <span className="model-picker-option-id">{item.id}</span>
                    ) : null}
                  </button>
                );
              })
            ) : (
              <div className="model-picker-empty">{emptyLabel || "—"}</div>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className={`model-picker ${variant}`}>
      <button
        ref={triggerRef}
        className={`model-picker-trigger${open ? " on" : ""}`}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={modelHint(current) || label}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={onTriggerKey}
      >
        <span className="model-picker-label">{label}</span>
        <IconChevronDown />
      </button>
      {menu}
    </div>
  );
}
