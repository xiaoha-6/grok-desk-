import { useEffect, useMemo, useState } from "react";
import { fill, type Copy } from "./i18n";
import {
  COMMANDS,
  chordFromEvent,
  chordTokens,
  conflictFor,
  formatChord,
  isModifiedBinding,
  resolvedChord,
  serializeChord,
  type CommandCategory,
  type CommandId,
} from "./keybindings";

const CATEGORY_ORDER: CommandCategory[] = ["editor", "chat", "navigation", "view"];

export function KeybindingsEditor({
  copy,
  overrides,
  onChange,
}: {
  copy: Copy;
  overrides: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [error, setError] = useState("");

  const categoryLabel = (id: CommandCategory) => {
    if (id === "editor") return copy.kbCategoryEditor;
    if (id === "chat") return copy.kbCategoryChat;
    if (id === "navigation") return copy.kbCategoryNav;
    return copy.kbCategoryView;
  };

  const commandLabel = (id: CommandId) => {
    const map: Record<CommandId, string> = {
      saveFile: copy.cmdSaveFile,
      quickOpen: copy.cmdQuickOpen,
      projectSearch: copy.cmdProjectSearch,
      newChat: copy.cmdNewChat,
      openSettings: copy.cmdOpenSettings,
      toggleSidebar: copy.cmdToggleSidebar,
      toggleWorkspace: copy.cmdToggleWorkspace,
      toggleTerminal: copy.cmdToggleTerminal,
      sendMessage: copy.cmdSendMessage,
      newLine: copy.cmdNewLine,
    };
    return map[id];
  };

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return CATEGORY_ORDER.map((category) => {
      const items = COMMANDS.filter((item) => item.category === category).filter((item) => {
        if (!needle) return true;
        const chord = resolvedChord(item.id, overrides);
        return `${commandLabel(item.id)} ${item.id} ${formatChord(chord)} ${chord}`.toLowerCase().includes(needle);
      });
      return { category, items };
    }).filter((group) => group.items.length);
  }, [commandLabel, overrides, query]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        setError("");
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        onChange({ ...overrides, [recording]: "" });
        setRecording(null);
        setError("");
        return;
      }
      const stroke = chordFromEvent(event);
      if (!stroke) return;
      const chord = serializeChord(stroke);
      const other = conflictFor(chord, recording, { ...overrides, [recording]: chord });
      if (other) {
        setError(fill(copy.kbConflict, { name: commandLabel(other) }));
      } else {
        setError("");
      }
      const next = { ...overrides };
      const def = COMMANDS.find((item) => item.id === recording)?.defaultChord || "";
      if (chord === def) delete next[recording];
      else next[recording] = chord;
      if (other) next[other] = "";
      onChange(next);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [commandLabel, copy.kbConflict, onChange, overrides, recording]);

  const dirty = COMMANDS.some((item) => isModifiedBinding(item.id, overrides));

  return (
    <section className="group kb-page">
      <p className="kb-intro">{copy.kbPageDetail}</p>
      <div className="kb-toolbar">
        <input
          className="kb-search"
          value={query}
          placeholder={copy.kbSearch}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="ghost compact nowrap" type="button" disabled={!dirty} onClick={() => onChange({})}>
          {copy.kbResetAll}
        </button>
      </div>
      {error ? <p className="kb-error">{error}</p> : null}
      {groups.map((group) => (
        <div key={group.category} className="kb-group">
          <div className="kb-group-title">{categoryLabel(group.category)}</div>
          {group.items.map((item) => {
            const chord = resolvedChord(item.id, overrides);
            const tokens = chordTokens(chord);
            const custom = isModifiedBinding(item.id, overrides);
            const active = recording === item.id;
            return (
              <div key={item.id} className={`kb-row${active ? " recording" : ""}`}>
                <div className="kb-name">
                  <strong>{commandLabel(item.id)}</strong>
                  {custom ? <em>{copy.kbModified}</em> : null}
                </div>
                <div className="kb-actions">
                  <button
                    type="button"
                    className={`kb-bind${active ? " on" : ""}`}
                    onClick={() => {
                      setError("");
                      setRecording(item.id);
                    }}
                  >
                    {active ? (
                      <span className="kb-wait">{copy.kbRecord}</span>
                    ) : tokens.length ? (
                      tokens.map((token) => (
                        <kbd key={token}>{token}</kbd>
                      ))
                    ) : (
                      <span className="kb-empty">{copy.kbUnbound}</span>
                    )}
                  </button>
                  {custom ? (
                    <button
                      className="ghost compact nowrap"
                      type="button"
                      onClick={() => {
                        const next = { ...overrides };
                        delete next[item.id];
                        onChange(next);
                      }}
                    >
                      {copy.kbReset}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {recording ? <p className="row-detail">{copy.kbRecordHint}</p> : null}
    </section>
  );
}
