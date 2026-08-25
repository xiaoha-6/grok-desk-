import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./monacoSetup";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { Tree, type NodeRendererProps, type TreeApi } from "react-arborist";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { fileLabel } from "./diff";
import { FileKindIcon, fileBadge, fileExtension } from "./fileIcons";
import { IconChevronRight, IconClose } from "./icons";
import type { Copy } from "./i18n";
import type { FileDiff, SshTarget, WorkspaceEntry } from "./types";

export type { WorkspaceEntry };

export type WorkspaceFile = {
  path: string;
  language: string;
  content: string;
  truncated: boolean;
  size: number;
};

type TreeNode = {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
};

type OpenTab = {
  path: string;
  view: "file" | "diff";
};

type Props = {
  cwd: string;
  ssh?: SshTarget | null;
  changedPaths: string[];
  diffs: FileDiff[];
  focusPath?: string;
  focusTick?: number;
  copy: Copy;
  onClose: () => void;
  onPickFolder?: () => void;
  onConnectSsh?: () => void;
  width?: number;
};

export function WorkspacePanel({ cwd, ssh, changedPaths, diffs, focusPath, focusTick = 0, copy, onClose, onPickFolder, onConnectSsh, width }: Props) {
  const [expanded, setExpanded] = useState<Record<string, WorkspaceEntry[]>>({});
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState("");
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"file" | "diff">("file");
  const filesRef = useRef<Record<string, WorkspaceFile>>({});
  const openTabsRef = useRef<OpenTab[]>([]);
  const activePathRef = useRef("");
  const cwdRef = useRef(cwd);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<TreeApi<TreeNode> | undefined>(undefined);
  const expandedRef = useRef(expanded);
  const pendingReveal = useRef<{ rel: string; folders: string[] } | null>(null);
  expandedRef.current = expanded;
  openTabsRef.current = openTabs;
  activePathRef.current = activePath;
  cwdRef.current = cwd;
  const treeHost = useElementSize();
  const editorTheme = useEditorTheme();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "grokdesk.workspace.split.v1",
    storage: localStorage,
  });

  const changed = useMemo(
    () => new Set(changedPaths.map((item) => toRelative(cwd, item)).filter(Boolean)),
    [changedPaths, cwd],
  );
  const diffByPath = useMemo(() => {
    const map = new Map<string, FileDiff>();
    for (const diff of diffs) {
      const rel = toRelative(cwd, diff.path || "");
      if (rel) map.set(rel, diff);
    }
    return map;
  }, [cwd, diffs]);

  const loadDir = useCallback(
    async (rel: string, force = false) => {
      if (!cwd) return;
      if (!force && expandedRef.current[rel]) return;
      try {
        const entries = await invoke<WorkspaceEntry[]>("list_workspace", { root: cwd, path: rel || null, ssh: ssh || null });
        setExpanded((current) => ({ ...current, [rel]: entries }));
      } catch (err) {
        setError(String(err));
      }
    },
    [cwd, ssh],
  );

  useEffect(() => {
    setExpanded({});
    setOpenTabs([]);
    setActivePath("");
    setFile(null);
    filesRef.current = {};
    openTabsRef.current = [];
    activePathRef.current = "";
    setError("");
    setTab("file");
    void loadDir("", true);
  }, [cwd, loadDir]);

  const loadFile = useCallback(
    async (rel: string) => {
      if (!cwd || !rel) return;
      try {
        const next = await invoke<WorkspaceFile>("read_workspace_file", { root: cwd, path: rel, ssh: ssh || null });
        if (cwdRef.current !== cwd) return;
        filesRef.current[rel] = next;
        if (activePathRef.current === rel) {
          setFile(next);
          setError("");
        }
      } catch (err) {
        if (cwdRef.current !== cwd) return;
        delete filesRef.current[rel];
        if (activePathRef.current === rel) {
          setFile(null);
          setError(String(err));
        }
      }
    },
    [cwd, ssh],
  );

  const showTab = useCallback(
    (item: OpenTab) => {
      const view = item.view === "diff" && diffByPath.has(item.path) ? "diff" : "file";
      activePathRef.current = item.path;
      setActivePath(item.path);
      setTab(view);
      const cached = filesRef.current[item.path];
      setFile(cached || null);
      if (!cached) void loadFile(item.path);
    },
    [diffByPath, loadFile],
  );

  const openFile = useCallback(
    async (rel: string, preferDiff = false) => {
      if (!cwd || !rel) return;
      const existing = openTabsRef.current.find((item) => item.path === rel);
      const view: "file" | "diff" =
        preferDiff && diffByPath.has(rel) ? "diff" : existing ? existing.view : "file";
      const nextTab = { path: rel, view };
      const nextTabs = existing
        ? openTabsRef.current.map((item) => (item.path === rel ? nextTab : item))
        : [...openTabsRef.current, nextTab];
      openTabsRef.current = nextTabs;
      setOpenTabs(nextTabs);
      showTab(nextTab);
      await loadFile(rel);
    },
    [cwd, diffByPath, loadFile, showTab],
  );

  const closeTab = useCallback(
    (rel: string) => {
      const current = openTabsRef.current;
      const index = current.findIndex((item) => item.path === rel);
      if (index < 0) return;
      const nextTabs = current.filter((item) => item.path !== rel);
      openTabsRef.current = nextTabs;
      setOpenTabs(nextTabs);
      delete filesRef.current[rel];
      if (activePathRef.current !== rel) return;
      const neighbor = nextTabs[index] || nextTabs[index - 1];
      if (!neighbor) {
        activePathRef.current = "";
        setActivePath("");
        setFile(null);
        setError("");
        setTab("file");
        return;
      }
      showTab(neighbor);
    },
    [showTab],
  );

  const setActiveView = useCallback((view: "file" | "diff") => {
    setTab(view);
    const nextTabs = openTabsRef.current.map((item) =>
      item.path === activePathRef.current ? { ...item, view } : item,
    );
    openTabsRef.current = nextTabs;
    setOpenTabs(nextTabs);
  }, []);

  const revealPath = useCallback(
    async (raw: string, preferDiff = false) => {
      const rel = toRelative(cwd, raw);
      if (!rel) return;
      const parts = rel.split("/");
      const folders: string[] = [];
      let acc = "";
      for (const part of parts.slice(0, -1)) {
        acc = acc ? `${acc}/${part}` : part;
        folders.push(acc);
      }
      pendingReveal.current = { rel, folders };
      await loadDir("");
      for (const folder of folders) await loadDir(folder);
      void openFile(rel, preferDiff);
    },
    [cwd, loadDir, openFile],
  );

  const revealPathRef = useRef(revealPath);
  revealPathRef.current = revealPath;

  useEffect(() => {
    if (!focusPath) return;
    void revealPathRef.current(focusPath, true);
  }, [focusPath, focusTick]);

  useEffect(() => {
    filesRef.current = {};
    if (activePathRef.current) void loadFile(activePathRef.current);
  }, [changedPaths, diffs, loadFile]);

  const treeData = useMemo(() => {
    const build = (parent: string): TreeNode[] =>
      (expanded[parent] || []).map((entry) => ({
        id: entry.path,
        name: entry.name,
        path: entry.path,
        isDir: entry.isDir,
        children: entry.isDir ? build(entry.path) : undefined,
      }));
    return build("");
  }, [expanded]);

  useEffect(() => {
    const pending = pendingReveal.current;
    if (!pending) return;
    if (!expanded[""] || !pending.folders.every((folder) => Boolean(expanded[folder]))) return;
    const api = treeRef.current;
    if (!api) return;
    pendingReveal.current = null;
    for (const folder of pending.folders) api.open(folder);
    api.select(pending.rel);
    void api.scrollTo(pending.rel);
  }, [expanded, treeData, treeHost.height]);

  const changedList = useMemo(() => {
    const names = new Set<string>();
    const list: string[] = [];
    for (const path of [...changed, ...diffByPath.keys()]) {
      if (!path || names.has(path)) continue;
      names.add(path);
      list.push(path);
    }
    return list.sort((a, b) => a.localeCompare(b));
  }, [changed, diffByPath]);

  const activeRel = toRelative(cwd, activePath || file?.path || "");
  const activeDiff = diffByPath.get(activeRel);
  const showDiff = tab === "diff" && Boolean(activeDiff);
  const language = monacoLanguage(file?.language || "", file?.path || activeRel);
  const hasOpenTabs = openTabs.length > 0;

  useEffect(() => {
    const host = tabStripRef.current;
    if (!host || !activeRel) return;
    const el = host.querySelector<HTMLElement>(`[data-tab-path="${cssEscape(activeRel)}"]`);
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeRel, openTabs]);

  const TreeNodeRow = useCallback(
    (props: NodeRendererProps<TreeNode>) => (
      <WorkspaceTreeNode
        {...props}
        dirty={changed.has(props.node.data.path) || diffByPath.has(props.node.data.path)}
      />
    ),
    [changed, diffByPath],
  );

  return (
    <aside className="workspace" style={width ? { width, minWidth: width, flex: "0 0 auto" } : undefined}>
      <header className="workspace-head">
        <div className="workspace-head-title">
          <strong>{copy.codeWorkspace}</strong>
          <em>{ssh ? `${ssh.user}@${ssh.host}:${cwd}` : cwd || copy.chooseFolder}</em>
        </div>
        <div className="workspace-head-actions">
          {onConnectSsh ? (
            <button className="ghost compact nowrap" type="button" title={copy.sshConnect} onClick={onConnectSsh}>
              {copy.sshShort}
            </button>
          ) : null}
          {onPickFolder ? (
            <button className="ghost compact nowrap" type="button" title={copy.localFolder} onClick={onPickFolder}>
              {copy.localShort}
            </button>
          ) : null}
          <button className="icon-btn" type="button" onClick={onClose} title={copy.close}>
            <IconClose />
          </button>
        </div>
      </header>
      <Group
        className="workspace-split"
        id="grokdesk.workspace.split.v1"
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <Panel id="tree" defaultSize="34%" minSize="160px" maxSize="58%" className="workspace-tree">
          {changedList.length ? (
            <div className="workspace-changed">
              <span className="kicker">{copy.unsavedEdit}</span>
              {changedList.map((path) => (
                <button
                  key={path}
                  type="button"
                  className={`ws-row changed${activePath === path ? " on" : ""}`}
                  onClick={() => void revealPath(path, true)}
                >
                  <FileKindIcon name={fileLabel(path) || path} isDir={false} />
                  <span className="ws-name">{fileLabel(path) || path}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="workspace-tree-host" ref={treeHost.ref}>
            {!cwd ? (
              <div className="workspace-empty">
                <p className="hint">{copy.workspaceHomeHint}</p>
                {onPickFolder ? (
                  <button className="ghost compact nowrap" type="button" onClick={onPickFolder}>
                    {copy.localShort}
                  </button>
                ) : null}
                {onConnectSsh ? (
                  <button className="ghost compact nowrap" type="button" onClick={onConnectSsh}>
                    {copy.sshShort}
                  </button>
                ) : null}
              </div>
            ) : treeHost.height > 0 ? (
              <Tree
                key={cwd}
                ref={treeRef}
                data={treeData}
                width={treeHost.width || "100%"}
                height={treeHost.height}
                indent={12}
                rowHeight={26}
                padding={4}
                openByDefault={false}
                disableDrag
                disableDrop
                disableEdit
                disableMultiSelection
                selection={activePath}
                onToggle={(id) => {
                  void loadDir(id);
                }}
                onActivate={(node) => {
                  if (node.data.isDir) {
                    node.toggle();
                    void loadDir(node.data.path);
                    return;
                  }
                  void openFile(node.data.path, diffByPath.has(node.data.path));
                }}
              >
                {TreeNodeRow}
              </Tree>
            ) : null}
          </div>
        </Panel>
        <Separator className="resize workspace-resize" />
        <Panel id="editor" minSize="220px" className="workspace-editor">
          {hasOpenTabs ? (
            <>
              <div className="workspace-filebar">
                <div
                  className="workspace-opentabs"
                  ref={tabStripRef}
                  role="tablist"
                  aria-label={copy.codeWorkspace}
                  onWheel={(event) => {
                    const el = event.currentTarget;
                    if (el.scrollWidth <= el.clientWidth || event.deltaY === 0) return;
                    el.scrollLeft += event.deltaY;
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    if (!openTabs.length) return;
                    event.preventDefault();
                    const index = Math.max(0, openTabs.findIndex((item) => item.path === activeRel));
                    const delta = event.key === "ArrowRight" ? 1 : -1;
                    const next = openTabs[(index + delta + openTabs.length) % openTabs.length];
                    if (next) showTab(next);
                  }}
                >
                  {openTabs.map((item) => {
                    const dirty = changed.has(item.path) || diffByPath.has(item.path);
                    const on = item.path === activeRel;
                    return (
                      <div
                        key={item.path}
                        role="tab"
                        aria-selected={on}
                        tabIndex={on ? 0 : -1}
                        data-tab-path={item.path}
                        title={item.path}
                        className={`workspace-opentab${on ? " on" : ""}${dirty ? " changed" : ""}`}
                        onMouseDown={(event) => {
                          if (event.button === 1) {
                            event.preventDefault();
                            return;
                          }
                          if (event.button === 0) showTab(item);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            showTab(item);
                          }
                        }}
                        onAuxClick={(event) => {
                          if (event.button === 1) {
                            event.preventDefault();
                            closeTab(item.path);
                          }
                        }}
                      >
                        <FileKindIcon name={item.path} isDir={false} size={16} />
                        <span className="workspace-opentab-name">{tabCaption(item.path, openTabs)}</span>
                        {dirty ? <i className="workspace-opentab-dot" aria-hidden /> : null}
                        <button
                          type="button"
                          className="workspace-opentab-close"
                          title={copy.closeFile}
                          aria-label={copy.closeFile}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            closeTab(item.path);
                          }}
                        >
                          <IconClose size={9} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="workspace-filemeta">
                  {file?.truncated ? <em>{copy.fileTruncated}</em> : null}
                  {activeRel ? <em className="ws-lang">{fileBadge(file?.path || activeRel, file?.language)}</em> : null}
                  {activeDiff ? (
                    <div className="workspace-tabs">
                      <button className={tab === "file" ? "on" : ""} type="button" onClick={() => setActiveView("file")}>
                        {copy.fileTab}
                      </button>
                      <button className={tab === "diff" ? "on" : ""} type="button" onClick={() => setActiveView("diff")}>
                        {copy.diffTab}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="workspace-monaco">
                {showDiff && activeDiff ? (
                  <DiffEditor
                    original={activeDiff.oldText}
                    modified={activeDiff.newText}
                    language={language}
                    theme={editorTheme}
                    height="100%"
                    originalModelPath={`original/${activeRel}`}
                    modifiedModelPath={`modified/${activeRel}`}
                    options={MONACO_DIFF_OPTIONS}
                    loading={<p className="hint">{copy.pickFile}</p>}
                  />
                ) : file ? (
                  <Editor
                    path={file.path}
                    value={file.content}
                    language={language}
                    theme={editorTheme}
                    height="100%"
                    options={MONACO_OPTIONS}
                    loading={<p className="hint">{copy.pickFile}</p>}
                  />
                ) : (
                  <p className="hint">{error || copy.pickFile}</p>
                )}
              </div>
            </>
          ) : (
            <p className="hint">{error || copy.pickFile}</p>
          )}
        </Panel>
      </Group>
    </aside>
  );
}

function WorkspaceTreeNode({ node, style, dragHandle, dirty }: NodeRendererProps<TreeNode> & { dirty: boolean }) {
  return (
    <div
      ref={dragHandle}
      style={style}
      className={`ws-row${node.isSelected ? " on" : ""}${dirty ? " changed" : ""}`}
    >
      <span
        className={node.data.isDir && node.isOpen ? "chevron open" : "chevron"}
        onClick={(event) => {
          event.stopPropagation();
          if (node.data.isDir) node.toggle();
        }}
      >
        {node.data.isDir ? <IconChevronRight size={11} /> : null}
      </span>
      <FileKindIcon name={node.data.name} isDir={node.data.isDir} isOpen={node.isOpen} />
      <span className="ws-name">{node.data.name}</span>
    </div>
  );
}

function useElementSize() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setSize({
        width: Math.max(0, Math.floor(el.clientWidth)),
        height: Math.max(0, Math.floor(el.clientHeight)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}

function useEditorTheme() {
  const [theme, setTheme] = useState(() => editorThemeFromDom());
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setTheme(editorThemeFromDom());
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", sync);
    };
  }, []);
  return theme;
}

function editorThemeFromDom() {
  const mode = document.documentElement.dataset.theme;
  if (mode === "dark") return "vs-dark";
  if (mode === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "light";
}

function monacoLanguage(language: string, path: string) {
  const ext = fileExtension(path);
  const raw = language && language !== "text" ? language : ext;
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    rs: "rust",
    py: "python",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    zsh: "shell",
    bash: "shell",
    toml: "ini",
    kt: "kotlin",
    kts: "kotlin",
    cs: "csharp",
    cpp: "cpp",
    cc: "cpp",
    h: "cpp",
    hpp: "cpp",
    mm: "objective-c",
    m: "objective-c",
  };
  return map[raw] || raw || "plaintext";
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function tabCaption(path: string, tabs: OpenTab[]) {
  const name = fileLabel(path) || path;
  const duplicates = tabs.filter((item) => (fileLabel(item.path) || item.path) === name).length > 1;
  if (!duplicates) return name;
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
  return parent ? `${name} — ${parent}` : name;
}

function toRelative(cwd: string, raw: string) {
  const path = String(raw || "").replace(/\\/g, "/");
  const root = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!path) return "";
  if (root && (path === root || path.startsWith(`${root}/`))) return path.slice(root.length + 1);
  if (path.startsWith("/")) {
    const parts = path.split("/").filter(Boolean);
    return parts.slice(Math.max(0, parts.length - 4)).join("/");
  }
  return path.replace(/^\.\//, "");
}

const MONACO_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 12,
  lineHeight: 18,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  renderLineHighlight: "line" as const,
  padding: { top: 8, bottom: 16 },
  smoothScrolling: true,
  automaticLayout: true,
  glyphMargin: false,
  folding: true,
  lineNumbers: "on" as const,
  renderWhitespace: "selection" as const,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
};

const MONACO_DIFF_OPTIONS = {
  ...MONACO_OPTIONS,
  renderSideBySide: false,
  renderIndicators: true,
  originalEditable: false,
  ignoreTrimWhitespace: false,
};
