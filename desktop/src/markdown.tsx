import type { ReactNode } from "react";

export function MessageBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = splitBlocks(text);
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
}

function splitBlocks(text: string) {
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
