import { memo, useMemo, useRef, type ReactNode } from "react";

type Block =
  | { type: "h"; level: number; text: string }
  | { type: "p"; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "table"; headers: string[]; rows: string[][] };

type ParseCache = { committed: string; committedBlocks: Block[] };

export const MarkdownPreview = memo(function MarkdownPreview({ text }: { text: string }) {
  const cacheRef = useRef<ParseCache>({ committed: "", committedBlocks: [] });
  const blocks = useMemo(() => parseBlocksIncremental(text, cacheRef.current), [text]);
  return (
    <div className="md-preview">
      {blocks.map((block, index) => {
        if (block.type === "h") {
          const Tag = (`h${Math.min(6, block.level)}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
          return (
            <Tag key={index} className={`md-h md-h${block.level}`}>
              {renderInline(block.text)}
            </Tag>
          );
        }
        if (block.type === "code") {
          return (
            <pre key={index} className="md-preview-code">
              {block.lang ? <span className="md-preview-lang">{block.lang}</span> : null}
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === "ul") {
          return (
            <ul key={index} className="md-preview-list">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={index} className="md-preview-list">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote key={index} className="md-preview-quote">
              {renderInline(block.text)}
            </blockquote>
          );
        }
        if (block.type === "hr") return <hr key={index} className="md-preview-hr" />;
        if (block.type === "table") {
          return (
            <div key={index} className="md-preview-tablewrap">
              <table className="md-preview-table">
                <thead>
                  <tr>
                    {block.headers.map((cell, cellIndex) => (
                      <th key={cellIndex}>{renderInline(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>{renderInline(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={index} className="md-preview-p">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
});

function parseBlocksIncremental(src: string, cache: ParseCache): Block[] {
  const text = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const cut = lastSafeCommit(text);
  const committed = cut > 0 ? text.slice(0, cut) : "";
  const tail = cut > 0 ? text.slice(cut) : text;
  if (committed !== cache.committed) {
    if (committed.startsWith(cache.committed) && cache.committed) {
      const extra = committed.slice(cache.committed.length);
      cache.committedBlocks = extra.trim()
        ? cache.committedBlocks.concat(parseBlocks(extra))
        : cache.committedBlocks;
    } else {
      cache.committedBlocks = committed ? parseBlocks(committed) : [];
    }
    cache.committed = committed;
  }
  const tailBlocks = tail ? parseBlocks(tail) : [];
  return tailBlocks.length ? cache.committedBlocks.concat(tailBlocks) : cache.committedBlocks;
}

function lastSafeCommit(text: string): number {
  let inFence = false;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("```", i) && (i === 0 || text.charCodeAt(i - 1) === 10)) {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (!inFence && text.charCodeAt(i) === 10 && i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
      last = i + 2;
    }
  }
  return last;
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, "").trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ type: "h", level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: quoted.join("\n") });
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{3,}:?\s*\|/.test(lines[i + 1])) {
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "p", text: para.join("\n") });
  }
  return blocks;
}

function isBlockStart(line: string) {
  return (
    /^```/.test(line) ||
    /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\|/.test(line)
  );
}

function splitRow(line: string) {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderInline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("~~") && part.endsWith("~~")) {
      return <del key={index}>{part.slice(2, -2)}</del>;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={index} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    }
    return <span key={index}>{part}</span>;
  });
}
