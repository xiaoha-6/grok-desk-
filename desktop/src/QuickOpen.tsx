import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileKindIcon } from "./fileIcons";
import type { Copy } from "./i18n";
import type { GrepHit, SshTarget, WorkspaceEntry } from "./types";

type Props = {
  open: boolean;
  mode: "file" | "grep";
  cwd: string;
  ssh?: SshTarget | null;
  copy: Copy;
  onClose: () => void;
  onOpenFile: (path: string) => void;
};

export function QuickOpen({ open, mode, cwd, ssh, copy, onClose, onOpenFile }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<WorkspaceEntry[]>([]);
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    setFiles([]);
    setHits([]);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open, mode]);

  useEffect(() => {
    if (!open || !cwd) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setBusy(true);
      const run =
        mode === "grep" && query.trim()
          ? invoke<GrepHit[]>("grep_workspace", { root: cwd, query, limit: 50, ssh: ssh || null }).then((rows) => {
              if (cancelled) return;
              setHits(Array.isArray(rows) ? rows : []);
              setFiles([]);
              setIndex(0);
            })
          : invoke<WorkspaceEntry[]>("search_workspace", {
              root: cwd,
              query,
              limit: 80,
              ssh: ssh || null,
            }).then((rows) => {
              if (cancelled) return;
              setFiles((Array.isArray(rows) ? rows : []).filter((item) => !item.isDir));
              setHits([]);
              setIndex(0);
            });
      void run.catch(() => {
        if (cancelled) return;
        setFiles([]);
        setHits([]);
      }).finally(() => {
        if (!cancelled) setBusy(false);
      });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cwd, mode, open, query, ssh]);

  const items = useMemo(() => {
    if (mode === "grep") return hits.map((hit) => ({ key: `${hit.path}:${hit.line}`, path: hit.path, label: hit.path, detail: `${hit.line}: ${hit.text}` }));
    return files.map((item) => ({ key: item.path, path: item.path, label: item.name, detail: item.path }));
  }, [files, hits, mode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((value) => Math.min(items.length - 1, value + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((value) => Math.max(0, value - 1));
      } else if (event.key === "Enter") {
        const item = items[index];
        if (!item) return;
        event.preventDefault();
        onOpenFile(item.path);
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, items, onClose, onOpenFile, open]);

  if (!open) return null;

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label={mode === "grep" ? copy.projectSearch : copy.quickOpen} onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder={mode === "grep" ? copy.projectSearchHint : copy.quickOpenHint}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="palette-list">
          {items.map((item, i) => (
            <button
              key={item.key}
              type="button"
              className={i === index ? "on" : ""}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                onOpenFile(item.path);
                onClose();
              }}
            >
              <FileKindIcon name={item.path} isDir={false} />
              <span>
                <strong>{item.label}</strong>
                <em>{item.detail}</em>
              </span>
            </button>
          ))}
          {!busy && !items.length ? <p className="hint">{copy.noSearchHits}</p> : null}
        </div>
      </div>
    </div>
  );
}
