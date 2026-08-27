import * as monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import type { DiffHunk } from "./diff";
import { IconCheck, IconUndo } from "./icons";
import type { Copy } from "./i18n";

type Hovered = {
  hunk: DiffHunk;
  top: number;
};

export function HunkOverlay({
  editor,
  hunks,
  copy,
  onKeep,
  onUndo,
}: {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  hunks: DiffHunk[];
  copy: Copy;
  onKeep: (hunk: DiffHunk) => void;
  onUndo: (hunk: DiffHunk) => void;
}) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const holdRef = useRef(false);
  const hideTimer = useRef(0);

  useEffect(() => {
    if (!editor) return;
    const decorations = editor.createDecorationsCollection(
      hunks.map((hunk) => {
        const start = hunk.newStart + 1;
        const end = hunk.newCount > 0 ? hunk.newStart + hunk.newCount : Math.max(1, hunk.newStart);
        return {
          range: new monaco.Range(start, 1, Math.max(start, end), 1),
          options: {
            isWholeLine: true,
            className: hunk.newCount ? "hunk-line-add" : "hunk-line-del",
            linesDecorationsClassName: "hunk-gutter",
          },
        };
      }),
    );
    return () => decorations.clear();
  }, [editor, hunks]);

  useEffect(() => {
    if (!editor) return;
    const findHunk = (line: number) =>
      hunks.find((hunk) => {
        if (hunk.newCount > 0) return line >= hunk.newStart + 1 && line <= hunk.newStart + hunk.newCount;
        return line === Math.max(1, hunk.newStart);
      });
    const showAt = (hunk: DiffHunk) => {
      const line = hunk.newCount > 0 ? hunk.newStart + 1 : Math.max(1, hunk.newStart);
      const coords = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
      if (!coords) {
        setHovered(null);
        return;
      }
      setHovered({ hunk, top: Math.max(8, coords.top + 2) });
    };
    const scheduleHide = () => {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        if (!holdRef.current) setHovered(null);
      }, 160);
    };
    const mouse = editor.onMouseMove((event) => {
      const line = event.target.position?.lineNumber;
      if (!line) {
        scheduleHide();
        return;
      }
      const hunk = findHunk(line);
      if (!hunk) {
        scheduleHide();
        return;
      }
      window.clearTimeout(hideTimer.current);
      showAt(hunk);
    });
    const leave = editor.onMouseLeave(() => scheduleHide());
    const scroll = editor.onDidScrollChange(() => {
      setHovered((current) => {
        if (!current) return current;
        const line = current.hunk.newCount > 0 ? current.hunk.newStart + 1 : Math.max(1, current.hunk.newStart);
        const coords = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
        if (!coords) return null;
        return { ...current, top: Math.max(8, coords.top + 2) };
      });
    });
    return () => {
      mouse.dispose();
      leave.dispose();
      scroll.dispose();
      window.clearTimeout(hideTimer.current);
    };
  }, [editor, hunks]);

  if (!hovered) return null;
  return (
    <div
      className="hunk-bar"
      style={{ top: hovered.top }}
      onMouseEnter={() => {
        holdRef.current = true;
        window.clearTimeout(hideTimer.current);
      }}
      onMouseLeave={() => {
        holdRef.current = false;
        setHovered(null);
      }}
    >
      <button type="button" className="keep" title={copy.keepHunk} onClick={() => onKeep(hovered.hunk)}>
        <IconCheck size={13} />
        <span>{copy.keepHunk}</span>
      </button>
      <button type="button" className="undo" title={copy.undoHunk} onClick={() => onUndo(hovered.hunk)}>
        <IconUndo size={13} />
        <span>{copy.undoHunk}</span>
      </button>
    </div>
  );
}
