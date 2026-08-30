import { memo, useMemo, useRef, type ReactNode } from "react";

type TextBlock = { type: "code" | "text"; text: string };
type ParseCache = { committed: string; committedBlocks: TextBlock[] };

export const MessageBody = memo(function MessageBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const cacheRef = useRef<ParseCache>({ committed: "", committedBlocks: [] });
  const blocks = useMemo(() => splitBlocksIncremental(text, cacheRef.current), [text]);
  return (
    <div className={streaming ? "md streaming" : "md"}>
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre key={index} className="md-code">
              <code>{block.text}</code>
            </pre>
          );
        }
        const lines = block.text.split("\n");
        const listed = lines.every(
          (line) => !line.trim() || line.trim().startsWith("- ") || line.trim().startsWith("* "),
        );
        if (listed && lines.some((line) => line.trim().startsWith("- ") || line.trim().startsWith("* "))) {
          return (
            <ul key={index} className="md-list">
              {lines
                .filter((line) => line.trim())
                .map((line, lineIndex) => (
                  <li key={lineIndex}>{renderInline(line.replace(/^\s*[-*]\s+/, ""))}</li>
                ))}
            </ul>
          );
        }
        return (
          <p key={index} className="md-p">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
});

function splitBlocksIncremental(text: string, cache: ParseCache): TextBlock[] {
  const cut = lastSafeCommit(text);
  const committed = cut > 0 ? text.slice(0, cut) : "";
  const tail = cut > 0 ? text.slice(cut) : text;
  if (committed !== cache.committed) {
    if (committed.startsWith(cache.committed) && cache.committed) {
      const extra = committed.slice(cache.committed.length);
      cache.committedBlocks = extra.trim()
        ? cache.committedBlocks.concat(splitBlocks(extra))
        : cache.committedBlocks;
    } else {
      cache.committedBlocks = committed ? splitBlocks(committed) : [];
    }
    cache.committed = committed;
  }
  const tailBlocks = tail ? splitBlocks(tail) : [];
  return tailBlocks.length ? cache.committedBlocks.concat(tailBlocks) : cache.committedBlocks;
}

function lastSafeCommit(text: string): number {
  let inFence = false;
  let last = 0;
  for (let i = 0; i < text.length; ) {
    if (text.startsWith("```", i)) {
      inFence = !inFence;
      i += 3;
      if (!inFence) last = i;
      continue;
    }
    if (!inFence && text.charCodeAt(i) === 10 && i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
      last = i + 2;
    }
    i += 1;
  }
  return last;
}

function splitBlocks(text: string): TextBlock[] {
  const chunks = text.split(/```/);
  return chunks
    .map((chunk, index) => {
      if (index % 2 === 1) {
        const next = chunk.replace(/^[^\n]*\n/, "");
        return { type: "code" as const, text: next.replace(/\n$/, "") };
      }
      return { type: "text" as const, text: chunk };
    })
    .filter((block) => block.text.length > 0);
}

function renderInline(text: string): ReactNode {
  const parts = text.split(/(!\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    const image = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      return <img key={index} className="md-image" src={image[2]} alt={image[1]} />;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}
