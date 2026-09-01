import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import "./monacoSetup";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { Tree, type NodeRendererProps, type TreeApi } from "react-arborist";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { diffStats, fileLabel, applyHunk, diffHunks, type DiffHunk } from "./diff";
import { FileKindIcon, fileBadge, fileExtension } from "./fileIcons";
import { HunkOverlay } from "./HunkOverlay";
import { IconCheck, IconChevronRight, IconClose, IconCodePane, IconDebug, IconDownload, IconExpand, IconFiles, IconGit, IconPanelLeft, IconSave, IconUndo } from "./icons";
import type { Copy } from "./i18n";
import { fill } from "./i18n";
import { chordsMatch, toMonacoKeybinding, withShortcut } from "./keybindings";
import { MarkdownPreview } from "./MarkdownPreview";
import { MONACO_THEME_DARK, MONACO_THEME_LIGHT } from "./monacoTheme";
import { RunDebugView } from "./RunDebugView";
import { SourceControlView } from "./SourceControlView";
import type { PanelChannel } from "./TerminalPanel";
import type { RunJob } from "./launch";
import type { FileDiff, GitStatus, ProjectRules, SshTarget, WorkspaceEntry } from "./types";
import type { editor as MonacoNs } from "monaco-editor";  

export type { WorkspaceEntry };

export type WorkspaceFile = {
  path: string;
  language: string;
  content: string;
  truncated: boolean;
  size: number;
  previewSrc?: string;
};

type WorkspaceImage = {
  path: string;
  mimeType: string;
  data: string;
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
  side?: "left" | "right";
  onClose: () => void;
  onMoveSide?: () => void;
  onPickFolder?: () => void;
  onConnectSsh?: () => void;
  width?: number;
  restoreTick?: number;
  saveChord?: string;
  gitAutoCommit?: boolean;
  gitAutoPush?: boolean;
  gitAutoCommitMessage?: string;
  onGitSettings?: (patch: { gitAutoCommit?: boolean; gitAutoPush?: boolean; gitAutoCommitMessage?: string }) => void;
  onRun?: (job: RunJob) => void;
  onOpenPanel?: (channel: PanelChannel) => void;
  onLog?: (line: string) => void;
  onAskAgent?: (text: string) => void;
};

export function WorkspacePanel({ cwd, ssh, changedPaths, diffs, focusPath, focusTick = 0, restoreTick = 0, saveChord = "mod+s", copy, side = "right", onClose, onMoveSide, onPickFolder, onConnectSsh, width, gitAutoCommit = false, gitAutoPush = false, gitAutoCommitMessage = "xiaoha: {title}", onGitSettings, onRun, onOpenPanel, onLog, onAskAgent }: Props) {
  const [expanded, setExpanded] = useState<Record<string, WorkspaceEntry[]>>({});
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState("");
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"file" | "diff">("file");
  const [sideBySide, setSideBySide] = useState(false);
  const [mdMode, setMdMode] = useState<"preview" | "source" | "split">("preview");
  const [reviews, setReviews] = useState<Record<string, { incoming: string; oldText: string; newText: string }>>({});
  const [reviewEditor, setReviewEditor] = useState<MonacoNs.IStandaloneCodeEditor | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [git, setGit] = useState<GitStatus | null>(null);
  const [activity, setActivity] = useState<"files" | "scm" | "run">("files");
  const [gitBusy, setGitBusy] = useState(false);
  const [scmDiffs, setScmDiffs] = useState<Record<string, FileDiff>>({});
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rules, setRules] = useState<ProjectRules | null>(null);
  const [rulesDraft, setRulesDraft] = useState("");
  const [pendingClose, setPendingClose] = useState<{ kind: "tab" | "panel"; path?: string } | null>(null);
  const filesRef = useRef<Record<string, WorkspaceFile>>({});
  const openTabsRef = useRef<OpenTab[]>([]);
  const activePathRef = useRef("");
  const cwdRef = useRef(cwd);
  const draftsRef = useRef<Record<string, string>>({});
  const scmDiffsRef = useRef<Record<string, FileDiff>>({});
  const saveFileRef = useRef<(rel?: string) => Promise<boolean>>(async () => false);
  const fileEditorRef = useRef<MonacoNs.IStandaloneCodeEditor | null>(null);
  const saveChordRef = useRef(saveChord);
  saveChordRef.current = saveChord;
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<TreeApi<TreeNode> | undefined>(undefined);
  const expandedRef = useRef(expanded);
  const pendingReveal = useRef<{ rel: string; folders: string[] } | null>(null);
  const staleEchoRef = useRef<Record<string, string>>({});
  const incomingSigRef = useRef("");
  const externalReloadTimerRef = useRef(0);
  const rulesRef = useRef(rules);
  const rulesDraftRef = useRef(rulesDraft);
  rulesRef.current = rules;
  rulesDraftRef.current = rulesDraft;
  expandedRef.current = expanded;
  openTabsRef.current = openTabs;
  activePathRef.current = activePath;
  cwdRef.current = cwd;
  draftsRef.current = drafts;
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
    for (const [rel, diff] of Object.entries(scmDiffs)) {
      map.set(rel, diff);
    }
    return map;
  }, [cwd, diffs, scmDiffs]);

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
    setMdMode("preview");
    setReviews({});
    setReviewEditor(null);
    setDrafts({});
    staleEchoRef.current = {};
    incomingSigRef.current = "";
    setScmDiffs({});
    scmDiffsRef.current = {};
    setGit(null);
    setActivity("files");
    setRulesOpen(false);
    setPendingClose(null);
    void loadDir("", true);
  }, [cwd, loadDir]);

  const dropDraft = useCallback((rel: string, echo?: string) => {
    if (echo != null) staleEchoRef.current[rel] = echo;
    setDrafts((current) => {
      if (current[rel] == null) return current;
      const next = { ...current };
      delete next[rel];
      return next;
    });
  }, []);

  const loadFile = useCallback(
    async (rel: string, options?: { dropDraft?: boolean }) => {
      if (!cwd || !rel) return;
      try {
        if (isWorkspaceImagePath(rel)) {
          const image = await invoke<WorkspaceImage>("read_workspace_image", { root: cwd, path: rel, ssh: ssh || null });
          if (cwdRef.current !== cwd) return;
          const next: WorkspaceFile = {
            path: rel,
            language: "image",
            content: "",
            truncated: false,
            size: image.size,
            previewSrc: `data:${image.mimeType || "image/png"};base64,${image.data}`,
          };
          filesRef.current[rel] = next;
          dropDraft(rel);
          if (activePathRef.current === rel) {
            setFile(next);
            setError("");
          }
          return;
        }
        const loaded = await invoke<WorkspaceFile>("read_workspace_file", { root: cwd, path: rel, ssh: ssh || null });
        if (cwdRef.current !== cwd) return;
        const next = isBinaryFile(rel, loaded.content) ? { ...loaded, language: "binary", content: "", truncated: true } : loaded;
        const prev = filesRef.current[rel]?.content;
        const draft = draftsRef.current[rel];
        filesRef.current[rel] = next;
        const diskChanged = prev != null && prev !== next.content;
        const echoDraft = draft == null || draft === prev || draft === next.content;
        if (options?.dropDraft || (diskChanged && echoDraft)) {
          if (draft != null && draft !== next.content) staleEchoRef.current[rel] = draft;
          else if (prev != null && prev !== next.content) staleEchoRef.current[rel] = prev;
          dropDraft(rel);
          if (activePathRef.current === rel && fileEditorRef.current && fileEditorRef.current.getValue() !== next.content) {
            fileEditorRef.current.setValue(next.content);
          }
        }
        const rulesFile = rulesRef.current;
        if (
          rulesFile &&
          (rel === rulesFile.path || /(^|\/)AGENTS\.md$/i.test(rel)) &&
          rulesDraftRef.current === (rulesFile.content || "")
        ) {
          setRules({ ...rulesFile, content: next.content, path: rulesFile.path || rel });
          setRulesDraft(next.content);
        }
        if (activePathRef.current === rel) {
          setFile(next);
          setError("");
        }
      } catch (err) {
        if (cwdRef.current !== cwd) return;
        if (isFolderError(err)) {
          delete filesRef.current[rel];
          setOpenTabs((current) => {
            const nextTabs = current.filter((item) => item.path !== rel);
            openTabsRef.current = nextTabs;
            return nextTabs;
          });
          if (activePathRef.current === rel) {
            setFile(null);
            setError("");
            setActivePath("");
            activePathRef.current = "";
          }
          setActivity("files");
          void loadDir(rel);
          return;
        }
        delete filesRef.current[rel];
        if (activePathRef.current === rel) {
          setFile(null);
          const text = String(err);
          setError(/太大|too large/i.test(text) && isWorkspaceImagePath(rel) ? copy.workspaceImageTooLarge : text);
        }
      }
    },
    [copy.workspaceImageTooLarge, cwd, dropDraft, loadDir, ssh],
  );

  const showTab = useCallback(
    (item: OpenTab) => {
      const view = item.view === "diff" && (diffByPath.has(item.path) || Boolean(scmDiffsRef.current[item.path])) ? "diff" : "file";
      activePathRef.current = item.path;
      setActivePath(item.path);
      setTab(view);
      const cached = filesRef.current[item.path];
      setFile(cached || null);
      const draft = draftsRef.current[item.path];
      const dirty = draft != null && draft !== (cached?.content ?? "");
      if (!cached || !dirty) void loadFile(item.path);
    },
    [diffByPath, loadFile],
  );

  const openFile = useCallback(
    async (rel: string, preferDiff = false) => {
      if (!cwd || !rel) return;
      const normalized = rel.replace(/\/+$/, "");
      const listed = Object.values(expandedRef.current)
        .flat()
        .find((item) => item.path === rel || item.path === normalized);
      if (listed?.isDir || rel.endsWith("/")) {
        setActivity("files");
        void loadDir(normalized);
        return;
      }
      const existing = openTabsRef.current.find((item) => item.path === rel);
      const view: "file" | "diff" =
        preferDiff && (diffByPath.has(rel) || Boolean(scmDiffsRef.current[rel])) ? "diff" : existing ? existing.view : "file";
      const nextTab = { path: rel, view };
      const nextTabs = existing
        ? openTabsRef.current.map((item) => (item.path === rel ? nextTab : item))
        : [...openTabsRef.current, nextTab];
      openTabsRef.current = nextTabs;
      setOpenTabs(nextTabs);
      showTab(nextTab);
      await loadFile(rel);
    },
    [cwd, diffByPath, loadDir, loadFile, showTab],
  );

  const openGitDiff = useCallback(
    async (rel: string, staged = false) => {
      if (!cwd || !rel) return;
      try {
        const diff = await invoke<{ path: string; oldText: string; newText: string }>("git_file_diff", {
          root: cwd,
          path: rel,
          staged,
          ssh: ssh || null,
        });
        const next = { path: rel, oldText: diff.oldText || "", newText: diff.newText || "" };
        scmDiffsRef.current = { ...scmDiffsRef.current, [rel]: next };
        setScmDiffs(scmDiffsRef.current);
        await openFile(rel, next.oldText !== next.newText);
      } catch (err) {
        setError(String(err));
        await openFile(rel);
      }
    },
    [cwd, openFile, ssh],
  );

  const isDirty = useCallback((rel: string) => {
    const draft = draftsRef.current[rel];
    if (draft == null) return false;
    return draft !== (filesRef.current[rel]?.content ?? "");
  }, []);

  const closeTab = useCallback(
    (rel: string, force = false) => {
      if (!force && isDirty(rel)) {
        setPendingClose({ kind: "tab", path: rel });
        return;
      }
      setDrafts((current) => {
        const next = { ...current };
        delete next[rel];
        return next;
      });
      const current = openTabsRef.current;
      const index = current.findIndex((item) => item.path === rel);
      if (index < 0) return;
      const nextTabs = current.filter((item) => item.path !== rel);
      openTabsRef.current = nextTabs;
      setOpenTabs(nextTabs);
      delete filesRef.current[rel];
      if (pendingClose?.path === rel) setPendingClose(null);
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
    [isDirty, pendingClose?.path, showTab],
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

  const adoptExternalFiles = useCallback(
    async (rels: string[], force = false) => {
      if (!rels.length) return;
      const known = [
        ...openTabsRef.current.map((item) => item.path),
        ...Object.keys(filesRef.current),
        activePathRef.current,
      ].filter(Boolean);
      const open = new Set(openTabsRef.current.map((item) => item.path));
      if (activePathRef.current) open.add(activePathRef.current);
      const mapped = [...new Set(rels.map((rel) => matchOpenRel(rel, known)))];
      for (const rel of mapped) {
        if (open.has(rel)) await loadFile(rel, { dropDraft: force });
        else delete filesRef.current[rel];
      }
    },
    [loadFile],
  );

  useEffect(() => {
    const rels = new Set<string>();
    for (const path of changedPaths) {
      const rel = toRelative(cwd, path);
      if (rel) rels.add(rel);
    }
    for (const diff of diffs) {
      const rel = toRelative(cwd, diff.path || "");
      if (rel) rels.add(rel);
    }
    const sig = [
      ...[...rels].sort(),
      ...diffs.map((item) => `${toRelative(cwd, item.path || "")}:${item.newText.length}`),
    ].join("|");
    if (sig === incomingSigRef.current) return;
    window.clearTimeout(externalReloadTimerRef.current);
    externalReloadTimerRef.current = window.setTimeout(() => {
      incomingSigRef.current = sig;
      void adoptExternalFiles([...rels]);
    }, 200);
    return () => window.clearTimeout(externalReloadTimerRef.current);
  }, [adoptExternalFiles, changedPaths, cwd, diffs]);

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
  const incomingKey = activeDiff
    ? `${activeDiff.oldText.length}:${activeDiff.newText.length}:${activeDiff.oldText.slice(0, 48)}:${activeDiff.newText.slice(0, 48)}`
    : "";
  const review = activeRel && activeDiff
    ? reviews[activeRel]?.incoming === incomingKey
      ? reviews[activeRel]
      : { incoming: incomingKey, oldText: activeDiff.oldText, newText: activeDiff.newText }
    : null;
  const hunks = review ? diffHunks(review.oldText, review.newText) : [];
  const showDiff = tab === "diff" && Boolean(review) && hunks.length > 0;
  const language = monacoLanguage(file?.language || "", file?.path || activeRel);
  const isMd = isMarkdownPath(activeRel, file?.language || language);
  const isImage = isWorkspaceImagePath(activeRel) || file?.language === "image";
  const previewText = review?.newText ?? drafts[activeRel] ?? file?.content ?? "";
  const showPreview = isMd && (mdMode === "preview" || mdMode === "split");
  const showImage = isImage && !showDiff;
  const showCode = !showImage && (!isMd || mdMode !== "preview" || showDiff);
  const stats = review ? diffStats(review.oldText, review.newText) : null;
  const diffOptions = useMemo(() => monacoDiffOptions(sideBySide, hunks.length > 0), [sideBySide, hunks.length]);
  const editorOptions = useMemo(() => monacoFileOptions(Boolean(file?.truncated), hunks.length > 0), [file?.truncated, hunks.length]);
  const hasOpenTabs = openTabs.length > 0;

  useEffect(() => {
    setReviewEditor(null);
    setMdMode(isMarkdownPath(activeRel) ? "preview" : "source");
  }, [activeRel]);

  const writeActive = useCallback(
    async (rel: string, content: string) => {
      await invoke("write_workspace_file", { root: cwd, path: rel, content, ssh: ssh || null });
      const prev = filesRef.current[rel];
      const next: WorkspaceFile = {
        path: rel,
        language: prev?.language || "text",
        content,
        truncated: false,
        size: content.length,
      };
      filesRef.current[rel] = next;
      setDrafts((current) => {
        if (current[rel] == null) return current;
        const copyDraft = { ...current };
        delete copyDraft[rel];
        return copyDraft;
      });
      if (activePathRef.current === rel) setFile(next);
    },
    [cwd, ssh],
  );

  const refreshGit = useCallback(async () => {
    if (!cwd) {
      setGit(null);
      return;
    }
    try {
      const next = await invoke<GitStatus>("git_status", { root: cwd, ssh: ssh || null });
      setGit(next);
    } catch {
      setGit(null);
    }
  }, [cwd, ssh]);

  const saveFile = useCallback(
    async (rel?: string) => {
      const path = rel || activePathRef.current;
      if (!path) return false;
      const live = path === activePathRef.current ? fileEditorRef.current?.getValue() : undefined;
      const content = live ?? draftsRef.current[path];
      if (content == null) return false;
      const echo = staleEchoRef.current[path];
      if (echo != null && content === echo) {
        setDrafts((current) => {
          if (current[path] == null) return current;
          const next = { ...current };
          delete next[path];
          return next;
        });
        delete staleEchoRef.current[path];
        return false;
      }
      const saved = filesRef.current[path]?.content ?? "";
      if (content === saved) {
        setDrafts((current) => {
          if (current[path] == null) return current;
          const next = { ...current };
          delete next[path];
          return next;
        });
        delete staleEchoRef.current[path];
        return false;
      }
      if (!isDirty(path) && live == null) return false;
      try {
        await writeActive(path, content);
        delete staleEchoRef.current[path];
        setError("");
        void refreshGit();
        return true;
      } catch (err) {
        setError(String(err));
        return false;
      }
    },
    [isDirty, refreshGit, writeActive],
  );
  saveFileRef.current = saveFile;

  const requestClosePanel = useCallback(() => {
    const dirtyTab = openTabsRef.current.find((item) => isDirty(item.path));
    if (dirtyTab) {
      setPendingClose({ kind: "panel", path: dirtyTab.path });
      showTab(dirtyTab);
      return;
    }
    onClose();
  }, [isDirty, onClose, showTab]);

  useEffect(() => {
    void refreshGit();
  }, [refreshGit, restoreTick]);

  useEffect(() => {
    if (activity !== "scm" || !cwd) return;
    const tick = () => {
      if (document.hidden) return;
      void refreshGit();
    };
    const timer = window.setInterval(tick, 8000);
    const onVis = () => {
      if (!document.hidden) void refreshGit();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [activity, cwd, refreshGit]);

  useEffect(() => {
    if (!restoreTick) return;
    setDrafts({});
    staleEchoRef.current = {};
    for (const tab of openTabsRef.current) void loadFile(tab.path);
  }, [loadFile, restoreTick]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!chordsMatch(event, saveChordRef.current)) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && !target.closest(".workspace")) return;
      event.preventDefault();
      event.stopPropagation();
      void saveFileRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const applyReview = useCallback(
    async (action: "accept" | "reject", hunk?: DiffHunk) => {
      if (!activeRel || !review) return;
      const next = hunk
        ? applyHunk(review.oldText, review.newText, hunk, action)
        : action === "accept"
          ? { oldText: review.newText, newText: review.newText }
          : { oldText: review.oldText, newText: review.oldText };
      setReviews((current) => ({
        ...current,
        [activeRel]: { incoming: incomingKey, ...next },
      }));
      try {
        if (hunk || action === "reject") {
          await writeActive(activeRel, next.newText);
        } else {
          await loadFile(activeRel, { dropDraft: true });
        }
        setError("");
      } catch (err) {
        setError(String(err));
      }
      if (next.oldText === next.newText) setTab("file");
    },
    [activeRel, incomingKey, loadFile, review, writeActive],
  );

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
        cwd={cwd}
        remote={Boolean(ssh)}
        dirty={changed.has(props.node.data.path) || diffByPath.has(props.node.data.path) || isDirty(props.node.data.path)}
      />
    ),
    [changed, cwd, diffByPath, isDirty, ssh],
  );

  return (
    <aside className={`workspace${side === "left" ? " side-left" : ""}`} style={width ? { width, minWidth: width, flex: "0 0 auto" } : undefined}>
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
          <button className="ghost compact nowrap" type="button" title={copy.projectRules} onClick={() => {
            setRulesOpen((value) => !value);
            if (!rules) {
              void invoke<ProjectRules | null>("read_project_rules", { root: cwd, ssh: ssh || null })
                .then((next) => {
                  setRules(next);
                  setRulesDraft(next?.content || "");
                })
                .catch(() => {
                  setRules(null);
                  setRulesDraft("");
                });
            }
          }}>
            {copy.projectRules}
          </button>
          {cwd ? (
            <button
              className={`ghost compact nowrap${git?.dirty ? " warn" : ""}${activity === "scm" ? " on" : ""}`}
              type="button"
              title={git?.available ? (git.dirty ? fill(copy.gitChanges, { count: new Set(git.files.map((item) => item.path)).size }) : copy.gitClean) : copy.gitNotRepo}
              onClick={() => {
                setActivity("scm");
                setRulesOpen(false);
                void refreshGit();
              }}
            >
              {git?.available ? `${git.branch || copy.gitBranch}${git.dirty ? ` · ${new Set(git.files.map((item) => item.path)).size}` : ""}` : copy.scmTitle}
            </button>
          ) : null}
          {onMoveSide ? (
            <button
              className="icon-btn"
              type="button"
              title={side === "left" ? copy.workspaceMoveRight : copy.workspaceMoveLeft}
              onClick={onMoveSide}
            >
              {side === "left" ? <IconCodePane /> : <IconPanelLeft />}
            </button>
          ) : null}
          <button className="icon-btn" type="button" onClick={requestClosePanel} title={copy.close}>
            <IconClose />
          </button>
        </div>
      </header>
      {rulesOpen ? (
        <div className="workspace-popover">
          <div className="workspace-popover-head">
            <strong>{copy.projectRules}</strong>
            <span>{rules?.path || "AGENTS.md"}</span>
          </div>
          <textarea
            className="workspace-rules"
            value={rulesDraft}
            placeholder={copy.projectRulesPlaceholder}
            onChange={(event) => setRulesDraft(event.target.value)}
          />
          <div className="workspace-git-commit">
            <button
              className="primary compact"
              type="button"
              disabled={!cwd}
              onClick={() => {
                void invoke<ProjectRules>("write_project_rules", { root: cwd, content: rulesDraft, ssh: ssh || null })
                  .then((next) => {
                    setRules(next);
                    setRulesDraft(next.content);
                    setError("");
                  })
                  .catch((err) => setError(String(err)));
              }}
            >
              {copy.saveRules}
            </button>
          </div>
        </div>
      ) : null}
      <div className="workspace-main">
      <nav className="ws-activity" aria-label={copy.codeWorkspace}>
        <button className={activity === "files" ? "on" : ""} type="button" title={copy.explorer} onClick={() => setActivity("files")}>
          <IconFiles size={16} />
        </button>
        <button className={activity === "scm" ? "on" : ""} type="button" title={copy.scmTitle} onClick={() => { setActivity("scm"); void refreshGit(); }}>
          <IconGit size={16} />
        </button>
        <button className={activity === "run" ? "on" : ""} type="button" title={copy.runTitle} onClick={() => setActivity("run")}>
          <IconDebug size={16} />
        </button>
      </nav>
      <Group
        className="workspace-split"
        id="grokdesk.workspace.split.v1"
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <Panel id="tree" defaultSize="34%" minSize="160px" maxSize="58%" className="workspace-tree">
          {activity === "scm" ? (
            <SourceControlView
              cwd={cwd}
              ssh={ssh}
              git={git}
              copy={copy}
              busy={gitBusy}
              autoCommit={gitAutoCommit}
              autoPush={gitAutoPush}
              commitTemplate={gitAutoCommitMessage}
              onRefresh={refreshGit}
              onOpenFile={(path) => void openFile(path)}
              onOpenDiff={(path, staged) => void openGitDiff(path, staged)}
              onBusy={setGitBusy}
              onError={setError}
              onLog={onLog}
              onGitSettings={onGitSettings}
              onAskAgent={onAskAgent}
              onWorkingTreeChanged={(paths, reason) => {
                const known = [
                  ...openTabsRef.current.map((item) => item.path),
                  activePathRef.current,
                ].filter(Boolean);
                const rels = paths?.length
                  ? paths.map((path) => matchOpenRel(toRelative(cwd, path), known)).filter(Boolean)
                  : known;
                void adoptExternalFiles(rels, reason === "discard");
              }}
            />
          ) : activity === "run" ? (
            <RunDebugView
              cwd={cwd}
              ssh={ssh}
              copy={copy}
              activeFile={activePath}
              onOpenFile={(path) => void openFile(path)}
              onRun={(job) => {
                onOpenPanel?.("debug");
                onRun?.(job);
              }}
              onLog={onLog}
            />
          ) : (
            <>
          <span className="kicker">{copy.explorer}</span>
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
            ) : (
              <Tree
                key={cwd}
                ref={treeRef}
                data={treeData}
                width={treeHost.width || "100%"}
                height={Math.max(treeHost.height, 160)}
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
            )}
          </div>
            </>
          )}
        </Panel>
        <Separator className="resize workspace-resize" />
        <Panel id="editor" minSize="220px" className="workspace-editor">
          {hasOpenTabs ? (
            <>
              {pendingClose ? (
                <div className="unsaved-banner">
                  <div>
                    <strong>{copy.unsavedConfirm}</strong>
                    <span>{copy.unsavedCloseHint}</span>
                  </div>
                  <button className="ghost compact" type="button" onClick={() => setPendingClose(null)}>
                    {copy.cancel}
                  </button>
                  <button
                    className="ghost compact"
                    type="button"
                    onClick={() => {
                      const target = pendingClose;
                      setPendingClose(null);
                      if (target.kind === "tab" && target.path) closeTab(target.path, true);
                      else onClose();
                    }}
                  >
                    {copy.discardChanges}
                  </button>
                  <button
                    className="primary compact"
                    type="button"
                    onClick={() => {
                      void (async () => {
                        const target = pendingClose;
                        if (target.kind === "panel") {
                          for (const tab of openTabsRef.current) {
                            if (!isDirty(tab.path)) continue;
                            const ok = await saveFile(tab.path);
                            if (!ok) return;
                          }
                          setPendingClose(null);
                          onClose();
                          return;
                        }
                        const ok = await saveFile(target.path);
                        if (!ok) return;
                        setPendingClose(null);
                        if (target.path) closeTab(target.path, true);
                      })();
                    }}
                  >
                    {copy.saveAndClose}
                  </button>
                </div>
              ) : null}
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
                    const dirty = changed.has(item.path) || diffByPath.has(item.path) || isDirty(item.path);
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
                  {isDirty(activeRel) ? (
                    <button className="ghost compact nowrap" type="button" title={withShortcut(copy.saveFile, saveChord)} onClick={() => void saveFile(activeRel)}>
                      {copy.saveFile}
                    </button>
                  ) : null}
                  {file?.truncated ? <em>{copy.fileTruncated}</em> : null}
                  {activeRel ? <em className="ws-lang">{fileBadge(file?.path || activeRel, file?.language)}</em> : null}
                  {stats && (showDiff || hunks.length) ? (
                    <span className="diff-stats workspace-diff-stats">
                      {stats.added ? <b className="add">+{stats.added}</b> : null}
                      {stats.removed ? <b className="del">−{stats.removed}</b> : null}
                    </span>
                  ) : null}
                  {isMd ? (
                    <div className="workspace-tabs">
                      <button className={mdMode === "preview" ? "on" : ""} type="button" onClick={() => { setMdMode("preview"); setActiveView("file"); }}>
                        {copy.mdPreview}
                      </button>
                      <button className={mdMode === "source" && !showDiff ? "on" : ""} type="button" onClick={() => { setMdMode("source"); setActiveView("file"); }}>
                        {copy.mdSource}
                      </button>
                      <button className={mdMode === "split" ? "on" : ""} type="button" onClick={() => { setMdMode("split"); setActiveView("file"); }}>
                        {copy.mdSplit}
                      </button>
                    </div>
                  ) : null}
                  {hunks.length ? (
                    <>
                      <div className="workspace-tabs">
                        <button className={tab === "file" && mdMode !== "preview" ? "on" : ""} type="button" onClick={() => { setActiveView("file"); if (isMd) setMdMode("source"); }}>
                          {copy.fileTab}
                        </button>
                        <button className={tab === "diff" ? "on" : ""} type="button" onClick={() => { setActiveView("diff"); if (isMd) setMdMode("source"); }}>
                          {copy.diffTab}
                        </button>
                      </div>
                      <div className="workspace-hunk-actions">
                        <button type="button" className="hunk-keep" title={copy.keepAll} onClick={() => void applyReview("accept")}>
                          <IconCheck size={12} />
                          {copy.keepAll}
                        </button>
                        <button type="button" className="hunk-undo" title={copy.undoAll} onClick={() => void applyReview("reject")}>
                          <IconUndo size={12} />
                          {copy.undoAll}
                        </button>
                      </div>
                    </>
                  ) : null}
                  {showDiff ? (
                    <div className="workspace-tabs">
                      <button className={!sideBySide ? "on" : ""} type="button" onClick={() => setSideBySide(false)}>
                        {copy.diffInline}
                      </button>
                      <button className={sideBySide ? "on" : ""} type="button" onClick={() => setSideBySide(true)}>
                        {copy.diffSplit}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className={`workspace-monaco${showPreview && showCode ? " split-md" : ""}`}>
                {showDiff && review ? (
                  <div className="workspace-monaco-code">
                    <DiffEditor
                      key={`${activeRel}-${sideBySide ? "split" : "inline"}-${review.newText.length}`}
                      original={review.oldText}
                      modified={review.newText}
                      language={language}
                      theme={editorTheme}
                      height="100%"
                      originalModelPath={`original/${activeRel}`}
                      modifiedModelPath={`modified/${activeRel}`}
                      options={diffOptions}
                      onMount={(instance) => setReviewEditor(instance.getModifiedEditor())}
                      loading={<p className="hint">{copy.pickFile}</p>}
                    />
                    {hunks.length ? (
                      <HunkOverlay
                        editor={reviewEditor}
                        hunks={hunks}
                        copy={copy}
                        onKeep={(hunk) => void applyReview("accept", hunk)}
                        onUndo={(hunk) => void applyReview("reject", hunk)}
                      />
                    ) : null}
                  </div>
                ) : showImage && file?.previewSrc ? (
                  <WorkspaceImagePreview src={file.previewSrc} name={fileLabel(activeRel) || activeRel} copy={copy} />
                ) : showCode && file?.language === "binary" ? (
                  <p className="hint">{copy.binaryFile}</p>
                ) : showCode && file ? (
                  <div className="workspace-monaco-code">
                    <Editor
                      path={file.path}
                      value={drafts[activeRel] ?? file.content}
                      language={language}
                      theme={editorTheme}
                      height="100%"
                      options={editorOptions}
                      onMount={(instance, monacoApi) => {
                        fileEditorRef.current = instance;
                        setReviewEditor(instance);
                        instance.updateOptions({
                          readOnly: Boolean(file.truncated),
                          domReadOnly: Boolean(file.truncated),
                        });
                        const save = () => {
                          void saveFileRef.current();
                        };
                        const monacoKey = toMonacoKeybinding(saveChordRef.current, monacoApi);
                        if (monacoKey != null) instance.addCommand(monacoKey, save);
                      }}
                      onChange={(value) => {
                        if (!activeRel || file.truncated) return;
                        const next = value ?? "";
                        const live = fileEditorRef.current?.getValue();
                        if (live != null && next !== live) return;
                        const saved = filesRef.current[activeRel]?.content ?? file.content;
                        if (staleEchoRef.current[activeRel] != null && next === staleEchoRef.current[activeRel] && next !== saved) {
                          return;
                        }
                        if (next === saved) delete staleEchoRef.current[activeRel];
                        setDrafts((current) => {
                          if (next === saved) {
                            if (current[activeRel] == null) return current;
                            const copyDraft = { ...current };
                            delete copyDraft[activeRel];
                            return copyDraft;
                          }
                          if (current[activeRel] === next) return current;
                          return { ...current, [activeRel]: next };
                        });
                      }}
                      loading={<p className="hint">{copy.pickFile}</p>}
                    />
                    {hunks.length ? (
                      <HunkOverlay
                        editor={reviewEditor}
                        hunks={hunks}
                        copy={copy}
                        onKeep={(hunk) => void applyReview("accept", hunk)}
                        onUndo={(hunk) => void applyReview("reject", hunk)}
                      />
                    ) : null}
                  </div>
                ) : !showPreview ? (
                  <p className="hint">{error || copy.pickFile}</p>
                ) : null}
                {showPreview ? <MarkdownPreview text={previewText} /> : null}
              </div>
            </>
          ) : (
            <p className="hint">{error || copy.pickFile}</p>
          )}
        </Panel>
      </Group>
      </div>
    </aside>
  );
}

function WorkspaceTreeNode({
  node,
  style,
  dragHandle,
  dirty,
  cwd,
  remote,
}: NodeRendererProps<TreeNode> & { dirty: boolean; cwd: string; remote: boolean }) {
  return (
    <div
      ref={dragHandle}
      style={style}
      className={`ws-row${node.isSelected ? " on" : ""}${dirty ? " changed" : ""}`}
      draggable
      onDragStart={(event) => {
        const rel = node.data.path;
        const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
        const abs = remote || !root ? "" : rel && rel !== "." ? `${root}/${rel.replace(/^\/+/, "")}` : root;
        event.dataTransfer.setData(
          "application/x-grokdesk-file",
          JSON.stringify({
            mention: rel,
            name: node.data.name,
            isDir: node.data.isDir,
            path: abs,
          }),
        );
        event.dataTransfer.setData("text/plain", `@${rel}`);
        event.dataTransfer.effectAllowed = "copy";
      }}
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

function isWorkspaceImagePath(path: string) {
  return /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|svg|heic|heif)$/i.test(path);
}

function isBinaryFile(path: string, content?: string) {
  if (isWorkspaceImagePath(path)) return false;
  if (/\.(zip|pdf|dmg|exe|wasm|mp4|mov|gz|7z|rar)$/i.test(path)) return true;
  const head = (content || "").slice(0, 800);
  if (!head) return false;
  if (head.startsWith("PK")) return true;
  return head.includes("\0");
}

function WorkspaceImagePreview({ src, name, copy }: { src: string; name: string; copy: Copy }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const data = src.startsWith("data:") ? src.replace(/^data:[^;]+;base64,/, "") : "";
  useEffect(() => {
    setFailed(false);
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, src]);
  const saveAs = () => {
    void invoke("save_image_as", { path: null, data: data || undefined, name }).catch(() => undefined);
  };
  const download = () => {
    const link = document.createElement("a");
    link.href = src;
    link.download = name || "image.png";
    link.click();
  };
  if (failed) {
    return <p className="hint">{copy.workspaceImageFailed}</p>;
  }
  return (
    <div className="workspace-image-preview">
      <img src={src} alt={name} onClick={() => setOpen(true)} onError={() => setFailed(true)} />
      <div className="workspace-image-actions">
        <button type="button" className="ghost compact" onClick={() => setOpen(true)}>
          <IconExpand size={13} />
          {copy.openImage}
        </button>
        <button type="button" className="ghost compact" onClick={download}>
          <IconDownload size={13} />
          {copy.downloadImage}
        </button>
        <button type="button" className="ghost compact" onClick={saveAs}>
          <IconSave size={13} />
          {copy.saveImageAs}
        </button>
      </div>
      {open
        ? createPortal(
            <div className="chat-image-lightbox" onClick={() => setOpen(false)} role="dialog" aria-modal="true">
              <div className="chat-image-lightbox-inner" onClick={(event) => event.stopPropagation()}>
                <img src={src} alt={name} />
                <div className="chat-image-lightbox-bar">
                  <button type="button" title={copy.downloadImage} onClick={download}>
                    <IconDownload size={16} />
                    <span>{copy.downloadImage}</span>
                  </button>
                  <button type="button" title={copy.saveImageAs} onClick={saveAs}>
                    <IconSave size={16} />
                    <span>{copy.saveImageAs}</span>
                  </button>
                  <button type="button" title={copy.closeImage} onClick={() => setOpen(false)}>
                    <IconClose size={16} />
                    <span>{copy.closeImage}</span>
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function isFolderError(err: unknown) {
  const text = String(err);
  return /文件夹|資料夾|folder/i.test(text);
}

function useElementSize() {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!node) return;
    const update = () => {
      setSize({
        width: Math.max(0, Math.floor(node.clientWidth)),
        height: Math.max(0, Math.floor(node.clientHeight)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return { ref: setNode, ...size };
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
  const dark = mode === "dark" || (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return dark ? MONACO_THEME_DARK : MONACO_THEME_LIGHT;
}

function isMarkdownPath(path: string, language?: string) {
  return language === "markdown" || /\.mdx?$/i.test(path);
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
    mdx: "markdown",
    lua: "lua",
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
  if (root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return path.slice(root.length + 1);
  return path.replace(/^\.\//, "");
}

function matchOpenRel(rel: string, known: string[]) {
  if (!rel) return rel;
  if (known.includes(rel)) return rel;
  const normalized = rel.replace(/\\/g, "/");
  return known.find((item) => item && (normalized.endsWith(`/${item}`) || normalized === item)) || rel;
}

const MONACO_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  lineHeight: 20,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  renderLineHighlight: "line" as const,
  padding: { top: 10, bottom: 18 },
  smoothScrolling: true,
  automaticLayout: true,
  glyphMargin: false,
  folding: true,
  lineNumbers: "on" as const,
  renderWhitespace: "selection" as const,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  roundedSelection: true,
  cursorBlinking: "smooth" as const,
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
};

function monacoFileOptions(truncated: boolean, reviewing = false) {
  return {
    ...MONACO_OPTIONS,
    readOnly: truncated,
    domReadOnly: truncated,
    glyphMargin: reviewing,
  };
}

function monacoDiffOptions(sideBySide: boolean, reviewing: boolean) {
  return {
    ...MONACO_OPTIONS,
    glyphMargin: reviewing,
    renderSideBySide: sideBySide,
    useInlineViewWhenSpaceIsLimited: true,
    compactMode: !sideBySide,
    renderIndicators: true,
    originalEditable: false,
    readOnly: true,
    ignoreTrimWhitespace: false,
    renderMarginRevertIcon: false,
    renderGutterMenu: false,
    renderOverviewRuler: false,
    enableSplitViewResizing: sideBySide,
    diffAlgorithm: "advanced" as const,
    diffWordWrap: "on" as const,
    hideUnchangedRegions: {
      enabled: true,
      contextLineCount: 3,
      minimumLineCount: 4,
      revealLineCount: 8,
    },
    experimental: {
      useTrueInlineView: !sideBySide,
      showMoves: true,
      showEmptyDecorations: true,
    },
  };
}
