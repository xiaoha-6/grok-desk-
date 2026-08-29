import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileKindIcon } from "./fileIcons";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCloud,
  IconDiff,
  IconPlus,
  IconRefresh,
  IconUndo,
} from "./icons";
import type { Copy } from "./i18n";
import { fill } from "./i18n";
import type { GithubIdentity, GitCommit, GitFile, GitReview, GitStatus, SshTarget } from "./types";

type Props = {
  cwd: string;
  ssh?: SshTarget | null;
  git: GitStatus | null;
  copy: Copy;
  busy?: boolean;
  autoCommit: boolean;
  autoPush: boolean;
  commitTemplate: string;
  onRefresh: () => Promise<void> | void;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string, staged?: boolean) => void;
  onBusy: (value: boolean) => void;
  onError: (message: string) => void;
  onLog?: (line: string) => void;
  onGitSettings?: (patch: { gitAutoCommit?: boolean; gitAutoPush?: boolean; gitAutoCommitMessage?: string }) => void;
  onAskAgent?: (text: string) => void;
  onWorkingTreeChanged?: (paths: string[] | null, reason: "discard" | "pull") => void;
};

function statusLetter(code: string) {
  const ch = (code || "").trim().slice(-1) || code;
  if (ch === "U" || code === "??" || code === "?") return "U";
  return (ch || "M").toUpperCase();
}

function statusClass(code: string) {
  const letter = statusLetter(code);
  if (letter === "U" || letter === "A" || letter === "R") return "add";
  if (letter === "D") return "del";
  return "mod";
}

function fileName(path: string) {
  return path.split("/").pop() || path;
}

function fileDir(path: string) {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

function parseRefs(raw: string) {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^HEAD\s*->\s*/, "").replace(/^tag:\s*/, ""));
}

function FileRow({
  file,
  copy,
  onOpen,
  onDiff,
  onDiscard,
  onStage,
  staged,
}: {
  file: GitFile;
  copy: Copy;
  staged?: boolean;
  onOpen: () => void;
  onDiff: () => void;
  onDiscard?: () => void;
  onStage: () => void;
}) {
  const letter = statusLetter(file.status);
  return (
    <div className="scm-file">
      <button type="button" className="scm-file-name" onClick={onDiff} title={file.path}>
        <FileKindIcon name={fileName(file.path)} isDir={false} size={16} />
        <span>{fileName(file.path)}</span>
        {fileDir(file.path) ? <small>{fileDir(file.path)}</small> : null}
      </button>
      <span className="scm-file-actions">
        <button type="button" title={copy.scmOpenFile} onClick={onOpen}>
          <IconDiff size={13} />
        </button>
        {onDiscard ? (
          <button type="button" title={copy.scmDiscard} onClick={onDiscard}>
            <IconUndo size={13} />
          </button>
        ) : null}
        <button type="button" title={staged ? copy.scmUnstage : copy.scmStage} onClick={onStage}>
          <IconPlus size={13} />
        </button>
      </span>
      <em className={`scm-status ${statusClass(file.status)}`}>{letter}</em>
    </div>
  );
}

export function SourceControlView({
  cwd,
  ssh,
  git,
  copy,
  busy,
  autoCommit,
  autoPush,
  commitTemplate,
  onRefresh,
  onOpenFile,
  onOpenDiff,
  onBusy,
  onError,
  onLog,
  onGitSettings,
  onAskAgent,
  onWorkingTreeChanged,
}: Props) {
  const [message, setMessage] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [accounts, setAccounts] = useState<GithubIdentity[]>([]);
  const [reviewBase, setReviewBase] = useState("main");
  const [openStaged, setOpenStaged] = useState(true);
  const [openChanges, setOpenChanges] = useState(true);
  const [openGraph, setOpenGraph] = useState(true);
  const remotes = git?.remotes || [];
  const origin = remotes[0]?.url || "";
  const staged = useMemo(() => (git?.files || []).filter((item) => item.staged), [git]);
  const changes = useMemo(() => (git?.files || []).filter((item) => !item.staged), [git]);

  const loadLog = useCallback(async () => {
    if (!cwd || !git?.available) {
      setCommits([]);
      return;
    }
    try {
      const next = await invoke<GitCommit[]>("git_log", { root: cwd, limit: 40, ssh: ssh || null });
      setCommits(Array.isArray(next) ? next : []);
    } catch {
      setCommits([]);
    }
  }, [cwd, git?.available, ssh]);

  useEffect(() => {
    void loadLog();
  }, [loadLog, git?.branch, git?.dirty]);

  useEffect(() => {
    void invoke<GithubIdentity[]>("git_github_accounts")
      .then((list) => setAccounts(Array.isArray(list) ? list : []))
      .catch(() => setAccounts([]));
  }, []);

  async function bindRemote(url: string) {
    const trimmed = url.trim();
    if (!cwd || !trimmed) return;
    if (!git?.available) {
      const ok = await run(() => invoke("git_init", { root: cwd, ssh: ssh || null }));
      if (ok == null) return;
    }
    const done = await run(
      () =>
        invoke("git_set_remote", {
          root: cwd,
          url: trimmed,
          name: remotes[0]?.name || "origin",
          ssh: ssh || null,
        }),
      copy.scmBound,
    );
    if (done != null) setRemoteUrl("");
  }

  function renderAccounts(allowBind = false) {
    if (!accounts.length) {
      return <p className="hint">{copy.scmGithubNone}</p>;
    }
    return (
      <div className="scm-gh">
        <strong>{copy.scmGithub}</strong>
        {accounts.map((account) => (
          <div key={`${account.source}-${account.login}`}>
            <p>
              {account.login}
              {account.name ? ` · ${account.name}` : ""}
              <em> {fill(copy.scmGithubHint, { source: account.source })}</em>
            </p>
            {allowBind && account.repos.length
              ? account.repos.map((repo) => (
                  <button
                    key={repo.url}
                    className="ghost compact"
                    type="button"
                    disabled={busy}
                    onClick={() => void bindRemote(repo.url)}
                  >
                    {copy.scmBindRepo} {repo.name}
                  </button>
                ))
              : allowBind
                ? <p className="hint">{copy.scmGithubEmptyRepos}</p>
                : null}
          </div>
        ))}
      </div>
    );
  }

  async function run<T>(work: () => Promise<T>, ok?: string, tree?: { paths: string[] | null; reason: "discard" | "pull" }) {
    onBusy(true);
    try {
      const result = await work();
      if (ok) onLog?.(ok);
      await onRefresh();
      await loadLog();
      if (tree) onWorkingTreeChanged?.(tree.paths, tree.reason);
      onError("");
      return result;
    } catch (err) {
      const text = String(err);
      onError(text);
      onLog?.(text);
      return null;
    } finally {
      onBusy(false);
    }
  }

  function commitKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void commit();
    }
  }

  async function commit() {
    const text = message.trim();
    if (!text || !cwd) return;
    const done = await run(
      () =>
        invoke<string>("git_commit", {
          root: cwd,
          message: text,
          ssh: ssh || null,
          all: staged.length ? false : true,
        }),
      text,
    );
    if (done != null) setMessage("");
  }

  function confirmDiscard(paths: string[]) {
    const hint = paths.length ? copy.scmDiscardConfirm : copy.scmDiscardAllConfirm;
    return window.confirm(hint);
  }

  async function findIssues() {
    if (!cwd) return;
    onBusy(true);
    try {
      const review = await invoke<GitReview>("git_review", { root: cwd, ssh: ssh || null });
      setReviewBase(review.base || "main");
      onLog?.(review.diff || copy.scmReviewEmpty);
      if (review.files[0]) onOpenDiff(review.files[0]);
      const body = review.diff.trim()
        ? review.diff.slice(0, 12000)
        : copy.scmReviewEmpty;
      onAskAgent?.(
        fill(copy.scmReviewPrompt, { base: review.base || "main" }) + "\n\n" + body,
      );
      onError("");
    } catch (err) {
      const text = String(err);
      onError(text);
      onLog?.(text);
    } finally {
      onBusy(false);
    }
  }

  const syncLabel = git?.behind ? copy.scmPull : git?.ahead ? copy.scmPush : copy.scmSync;

  return (
    <div className="scm-view">
      <header className="scm-head">
        <div className="scm-head-row">
          <strong>{copy.scmTitle}</strong>
          <span className="scm-head-actions">
            <button type="button" title={copy.refresh} disabled={busy} onClick={() => void run(async () => { await onRefresh(); await loadLog(); })}>
              <IconRefresh size={14} />
            </button>
            <button type="button" title={copy.gitCommit} disabled={busy || !message.trim() || !git?.dirty} onClick={() => void commit()}>
              <IconCheck size={14} />
            </button>
            <button type="button" title={copy.scmPull} disabled={busy || !origin} onClick={() => void run(() => invoke("git_pull", { root: cwd, ssh: ssh || null }), copy.scmPulled, { paths: null, reason: "pull" })}>
              <IconArrowDown size={14} />
            </button>
            <button type="button" title={copy.scmPush} disabled={busy || !origin} onClick={() => void run(() => invoke("git_push", { root: cwd, ssh: ssh || null }), copy.scmPushed)}>
              <IconArrowUp size={14} />
            </button>
            <button
              type="button"
              title={syncLabel}
              disabled={busy || !origin}
              onClick={() =>
                void run(async () => {
                  await invoke("git_fetch", { root: cwd, ssh: ssh || null });
                  if (git?.behind) await invoke("git_pull", { root: cwd, ssh: ssh || null });
                  if ((git?.ahead || 0) > 0) await invoke("git_push", { root: cwd, ssh: ssh || null });
                }, copy.scmSynced, git?.behind ? { paths: null, reason: "pull" } : undefined)
              }
            >
              <IconCloud size={14} />
            </button>
          </span>
        </div>
        <span>
          {git?.available
            ? `${git.branch || copy.gitBranch}${git.ahead ? ` ↑${git.ahead}` : ""}${git.behind ? ` ↓${git.behind}` : ""}`
            : copy.gitNotRepo}
        </span>
      </header>

      {!git?.available ? (
        <div className="scm-welcome">
          <p>{copy.scmWelcome}</p>
          <button
            className="primary"
            type="button"
            disabled={!cwd || busy}
            onClick={() => void run(() => invoke("git_init", { root: cwd, ssh: ssh || null }), copy.gitInitOk)}
          >
            {copy.scmInit}
          </button>
          <label>
            {copy.scmRemoteUrl}
            <input
              value={remoteUrl}
              placeholder={copy.scmRemoteHint}
              spellCheck={false}
              onChange={(event) => setRemoteUrl(event.target.value)}
            />
          </label>
          <button
            className="ghost"
            type="button"
            disabled={!cwd || busy || !remoteUrl.trim()}
            onClick={() => void bindRemote(remoteUrl)}
          >
            {copy.scmBindAction}
          </button>
          {renderAccounts(true)}
        </div>
      ) : (
        <>
          <div className="scm-commit">
            <textarea
              value={message}
              placeholder={copy.scmCommitHint}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={commitKey}
            />
            <button className="primary compact" type="button" disabled={busy || !message.trim() || !git.dirty} onClick={() => void commit()}>
              {copy.gitCommit}
            </button>
          </div>

          {staged.length ? (
            <section className="scm-group">
              <header>
                <button type="button" className="scm-twist" onClick={() => setOpenStaged((value) => !value)}>
                  {openStaged ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                  <strong>{copy.scmStaged}</strong>
                  <span>{staged.length}</span>
                </button>
                <button type="button" title={copy.scmOpenChanges} disabled={busy} onClick={() => onOpenDiff(staged[0].path, true)}>
                  <IconDiff size={13} />
                </button>
                <button
                  type="button"
                  title={copy.scmUnstageAll}
                  disabled={busy}
                  onClick={() => void run(() => invoke("git_unstage", { root: cwd, paths: staged.map((item) => item.path), ssh: ssh || null }))}
                >
                  <IconUndo size={13} />
                </button>
              </header>
              {openStaged
                ? staged.map((file) => (
                    <FileRow
                      key={`s-${file.path}`}
                      file={file}
                      copy={copy}
                      staged
                      onOpen={() => onOpenFile(file.path)}
                      onDiff={() => onOpenDiff(file.path, true)}
                      onStage={() => void run(() => invoke("git_unstage", { root: cwd, paths: [file.path], ssh: ssh || null }))}
                    />
                  ))
                : null}
            </section>
          ) : null}

          <section className="scm-group">
            <header>
              <button type="button" className="scm-twist" onClick={() => setOpenChanges((value) => !value)}>
                {openChanges ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                <strong>{copy.scmChanges}</strong>
                <span>{changes.length}</span>
              </button>
              {changes.length ? (
                <>
                  <button type="button" title={copy.scmOpenChanges} disabled={busy} onClick={() => onOpenDiff(changes[0].path)}>
                    <IconDiff size={13} />
                  </button>
                  <button
                    type="button"
                    title={copy.scmDiscardAll}
                    disabled={busy}
                    onClick={() => {
                      if (!confirmDiscard([])) return;
                      void run(() => invoke("git_discard", { root: cwd, paths: [], ssh: ssh || null }), copy.scmDiscarded, { paths: null, reason: "discard" });
                    }}
                  >
                    <IconUndo size={13} />
                  </button>
                  <button
                    type="button"
                    title={copy.scmStageAll}
                    disabled={busy}
                    onClick={() => void run(() => invoke("git_stage", { root: cwd, paths: [], ssh: ssh || null }))}
                  >
                    <IconPlus size={13} />
                  </button>
                </>
              ) : null}
            </header>
            {openChanges ? (
              changes.length ? (
                changes.map((file) => (
                  <FileRow
                    key={`c-${file.path}`}
                    file={file}
                    copy={copy}
                    onOpen={() => onOpenFile(file.path)}
                    onDiff={() => onOpenDiff(file.path)}
                    onDiscard={() => {
                      if (!confirmDiscard([file.path])) return;
                      void run(() => invoke("git_discard", { root: cwd, paths: [file.path], ssh: ssh || null }), copy.scmDiscarded, { paths: [file.path], reason: "discard" });
                    }}
                    onStage={() => void run(() => invoke("git_stage", { root: cwd, paths: [file.path], ssh: ssh || null }))}
                  />
                ))
              ) : (
                <p className="scm-empty">{copy.gitClean}</p>
              )
            ) : null}
          </section>

          <section className="scm-review">
            <strong>Agent Review</strong>
            <button className="run-start" type="button" disabled={!cwd || busy} onClick={() => void findIssues()}>
              {copy.scmFindIssues}
            </button>
            <p>{fill(copy.scmReviewHint, { base: reviewBase })}</p>
          </section>

          <section className="scm-graph">
            <header>
              <button type="button" className="scm-twist" onClick={() => setOpenGraph((value) => !value)}>
                {openGraph ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                <strong>{copy.scmGraph}</strong>
              </button>
              <button type="button" title={copy.refresh} disabled={busy} onClick={() => void loadLog()}>
                <IconRefresh size={13} />
              </button>
              <button type="button" title={copy.gitCommit} disabled={busy || !message.trim() || !git.dirty} onClick={() => void commit()}>
                <IconCheck size={13} />
              </button>
              <button type="button" title={copy.scmPull} disabled={busy || !origin} onClick={() => void run(() => invoke("git_pull", { root: cwd, ssh: ssh || null }), copy.scmPulled, { paths: null, reason: "pull" })}>
                <IconArrowDown size={13} />
              </button>
              <button type="button" title={copy.scmPush} disabled={busy || !origin} onClick={() => void run(() => invoke("git_push", { root: cwd, ssh: ssh || null }), copy.scmPushed)}>
                <IconCloud size={13} />
              </button>
            </header>
            {openGraph ? (
              <div className="scm-log">
                {commits.length ? (
                  commits.map((item, index) => {
                    const refs = parseRefs(item.refs);
                    return (
                      <div key={item.hash} className="scm-commit-row">
                        <span className={`scm-dot${index === 0 ? " head" : ""}`} />
                        <div>
                          <p>
                            {item.subject || item.short}
                            {refs.map((ref) => (
                              <em key={ref} className="scm-ref">
                                {ref}
                              </em>
                            ))}
                          </p>
                          <small>
                            {item.author}
                            {item.relTime ? ` · ${item.relTime}` : ""}
                          </small>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="scm-empty">{copy.scmGraphEmpty}</p>
                )}
              </div>
            ) : null}
          </section>

          <section className="scm-bind">
            {renderAccounts(true)}
            <strong>{copy.scmBind}</strong>
            <p>{origin ? fill(copy.scmRemoteCurrent, { url: origin }) : copy.scmNoRemote}</p>
            <input
              value={remoteUrl}
              placeholder={origin || (accounts[0]?.login ? `https://github.com/${accounts[0].login}/repo.git` : copy.scmRemoteHint)}
              spellCheck={false}
              onChange={(event) => setRemoteUrl(event.target.value)}
            />
            <div className="scm-bind-actions">
              <button
                className="ghost compact"
                type="button"
                disabled={busy || !remoteUrl.trim()}
                onClick={() => void bindRemote(remoteUrl)}
              >
                {copy.scmBindAction}
              </button>
              <button
                className="ghost compact"
                type="button"
                disabled={busy || !origin}
                onClick={() => void run(() => invoke("git_push", { root: cwd, ssh: ssh || null }), copy.scmPushed)}
              >
                {copy.scmPublish}
              </button>
            </div>
          </section>
        </>
      )}

      {onGitSettings ? (
        <section className="scm-auto">
          <strong>{copy.scmAutomation}</strong>
          <label className="scm-check">
            <input type="checkbox" checked={autoCommit} onChange={(event) => onGitSettings({ gitAutoCommit: event.target.checked })} />
            <span>
              {copy.scmAutoCommit}
              <em>{copy.scmAutoCommitDetail}</em>
            </span>
          </label>
          <label className="scm-check">
            <input type="checkbox" checked={autoPush} onChange={(event) => onGitSettings({ gitAutoPush: event.target.checked })} />
            <span>
              {copy.scmAutoPush}
              <em>{copy.scmAutoPushDetail}</em>
            </span>
          </label>
          <label>
            {copy.scmCommitTemplate}
            <input
              value={commitTemplate}
              placeholder="xiaoha: {title}"
              onChange={(event) => onGitSettings({ gitAutoCommitMessage: event.target.value })}
            />
          </label>
        </section>
      ) : null}
    </div>
  );
}
