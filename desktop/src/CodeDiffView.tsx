import { annotateDiff, diffStats, fileLabel } from "./diff";
import { fileBadge } from "./fileIcons";
import { fill, t as translate } from "./i18n";
import type { FileDiff, Lang, TokenSpan } from "./types";

export function CodeDiffView({ diff, lang }: { diff: FileDiff; lang: Lang }) {
  const copy = translate(lang);
  const oldText = diff.oldText.length > 8000 ? `${diff.oldText.slice(0, 8000)}\n…` : diff.oldText;
  const newText = diff.newText.length > 8000 ? `${diff.newText.slice(0, 8000)}\n…` : diff.newText;
  const lines = annotateDiff(oldText, newText);
  const stats = diffStats(oldText, newText);
  const path = fileLabel(diff.path);
  return (
    <div className="code-diff cursor-diff">
      <div className="diff-path">
        <span className="diff-path-name">{path || copy.editedFile}</span>
        {diff.path ? <em>{fileBadge(diff.path)}</em> : null}
        <span className="diff-stats">
          {stats.added ? <b className="add">+{stats.added}</b> : null}
          {stats.removed ? <b className="del">−{stats.removed}</b> : null}
        </span>
      </div>
      <div className="diff-body">
        {lines.length ? (
          lines.map((line, index) =>
            line.kind === "collapse" ? (
              <div key={`collapse-${index}`} className="diff-line collapse">
                <span className="diff-collapse-rule" />
                <span className="diff-collapse-label">{fill(copy.unchangedLines, { n: line.text })}</span>
                <span className="diff-collapse-rule" />
              </div>
            ) : (
              <div key={`${line.kind}-${index}`} className={`diff-line ${line.kind}`}>
                <span className="diff-gutter">
                  <span className="diff-no">{line.kind === "add" ? "" : line.oldNo ?? ""}</span>
                  <span className="diff-no">{line.kind === "del" ? "" : line.newNo ?? ""}</span>
                </span>
                <span className="diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                <span className="diff-text">
                  {line.tokens?.length ? renderTokens(line.tokens) : line.text || " "}
                </span>
              </div>
            ),
          )
        ) : (
          <div className="diff-line eq">
            <span className="diff-text">{copy.noChanges}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function renderTokens(tokens: TokenSpan[]) {
  return tokens.map((token, index) =>
    token.kind === "eq" ? (
      <span key={index}>{token.text}</span>
    ) : (
      <span key={index} className={`diff-token ${token.kind}`}>
        {token.text}
      </span>
    ),
  );
}
