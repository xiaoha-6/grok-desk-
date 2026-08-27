import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { IconClose, IconOutput, IconPlus, IconPorts, IconTerminal, IconWarning } from "./icons";
import type { Copy } from "./i18n";
import { fill } from "./i18n";
import type { RunJob } from "./launch";
import type { SshTarget, Theme } from "./types";

export type { RunJob };

export type PanelChannel = "problems" | "output" | "debug" | "terminal" | "ports";

export type DetectedShell = {
  id: string;
  name: string;
  executable: string;
  args: string[];
  preferred?: boolean;
};

export type AgentTermJob = {
  id: string;
  title: string;
  command: string;
  output: string;
  status: string;
};

type TermTab = {
  id: string;
  title: string;
  cwd: string;
  shell?: string;
  kind: "shell" | "agent" | "run";
  argv?: string[];
};

type PtyPayload = {
  id: string;
  data?: string;
  code?: number | null;
};

function uid() {
  return crypto.randomUUID();
}

function folderName(cwd: string, fallback: string) {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || fallback;
}

function decodeChunk(data: string) {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return data;
  }
}

function jobFinished(status?: string) {
  return /complete|success|fail|error|cancel/i.test(status || "");
}

function clipFeed(text: string, max = 4000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}

function toTermText(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

function xtermTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) {
    return {
      background: "#111111",
      foreground: "#D6D6D6",
      cursor: "#D6D6D6",
      cursorAccent: "#1A1A1A",
      selectionBackground: "#264F7888",
      black: "#1A1A1A",
      red: "#F85149",
      green: "#3FB950",
      yellow: "#D29922",
      blue: "#58A6FF",
      magenta: "#BC8CFF",
      cyan: "#39D0D6",
      white: "#D6D6D6",
      brightBlack: "#6E6E6E",
      brightRed: "#FF7B72",
      brightGreen: "#56D364",
      brightYellow: "#E3B341",
      brightBlue: "#79C0FF",
      brightMagenta: "#D2A8FF",
      brightCyan: "#56D4DD",
      brightWhite: "#F0F0F0",
    };
  }
  return {
    background: "#FBFBFC",
    foreground: "#111214",
    cursor: "#111214",
    cursorAccent: "#FFFFFF",
    selectionBackground: "#264F7844",
    black: "#1A1A1A",
    red: "#C62828",
    green: "#188038",
    yellow: "#B06000",
    blue: "#1967D2",
    magenta: "#7A3E9D",
    cyan: "#0F766E",
    white: "#5C5F66",
    brightBlack: "#8B8E96",
    brightRed: "#E24A4A",
    brightGreen: "#1E8E3E",
    brightYellow: "#C07800",
    brightBlue: "#1A73E8",
    brightMagenta: "#9334E6",
    brightCyan: "#0D9488",
    brightWhite: "#111214",
  };
}

function XtermView({
  id,
  cwd,
  shell,
  ssh,
  theme,
  active,
  kind,
  feed,
  argv,
}: {
  id: string;
  cwd: string;
  shell?: string;
  ssh?: SshTarget | null;
  theme: Theme;
  active: boolean;
  kind: "shell" | "agent" | "run";
  feed?: string;
  argv?: string[];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const openedRef = useRef(false);
  const writtenRef = useRef("");

  const fitAndResize = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host || host.clientWidth < 40 || host.clientHeight < 24) return;
    fit.fit();
    if (kind === "agent" || !openedRef.current) return;
    const cols = Math.max(20, term.cols);
    const rows = Math.max(8, term.rows);
    void invoke("pty_resize", { id, cols, rows }).catch(() => undefined);
  }, [id, kind]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: kind !== "agent",
      disableStdin: kind === "agent",
      fontSize: 12.5,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace',
      lineHeight: 1.28,
      scrollback: 5000,
      theme: xtermTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    const unlisten: UnlistenFn[] = [];
    let cancelled = false;

    void (async () => {
      if (kind === "agent") {
        fit.fit();
        return;
      }
      const output = await listen<PtyPayload>("pty-output", (event) => {
        if (event.payload.id !== id) return;
        if (event.payload.data) term.write(decodeChunk(event.payload.data));
      });
      const exit = await listen<PtyPayload>("pty-exit", (event) => {
        if (event.payload.id !== id) return;
        term.write("\r\n");
      });
      unlisten.push(output, exit);
      if (cancelled) return;
      fit.fit();
      const cols = Math.max(20, term.cols || 80);
      const rows = Math.max(8, term.rows || 24);
      try {
        await invoke("pty_open", {
          id,
          cwd: cwd || null,
          cols,
          rows,
          shell: ssh ? null : shell || null,
          ssh: ssh || null,
          argv: argv?.length ? argv : null,
        });
        openedRef.current = true;
      } catch (error) {
        term.write(`\r\n${String(error)}\r\n`);
      }
    })();

    const onData = term.onData((data) => {
      if (kind === "agent") return;
      void invoke("pty_write", { id, data }).catch(() => undefined);
    });
    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(host);

    return () => {
      cancelled = true;
      onData.dispose();
      observer.disconnect();
      unlisten.forEach((stop) => stop());
      if (openedRef.current) {
        void invoke("pty_close", { id }).catch(() => undefined);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id, cwd, shell, ssh, kind, argv, fitAndResize]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (kind !== "agent") return;
    const term = termRef.current;
    if (!term) return;
    const next = toTermText(feed || "");
    if (next.startsWith(writtenRef.current)) {
      const delta = next.slice(writtenRef.current.length);
      if (delta) term.write(delta);
    } else {
      term.reset();
      if (next) term.write(next);
    }
    writtenRef.current = next;
    term.scrollToBottom();
  }, [feed, kind]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (kind !== "agent") termRef.current?.focus();
      fitAndResize();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, fitAndResize, kind]);

  return <div ref={hostRef} className={`term-xterm${active ? " on" : ""}`} />;
}

export function TerminalPanel({
  cwd,
  ssh,
  theme,
  copy,
  height,
  agentJobs,
  channel = "terminal",
  onChannel,
  outputLines,
  runJob,
  ports,
  onResize,
  onClose,
}: {
  cwd: string;
  ssh?: SshTarget | null;
  theme: Theme;
  copy: Copy;
  height: number;
  agentJobs?: AgentTermJob[];
  channel?: PanelChannel;
  onChannel?: (next: PanelChannel) => void;
  outputLines?: string[];
  runJob?: RunJob | null;
  ports?: Array<{ port: number; label?: string }>;
  onResize: (next: number) => void;
  onClose: () => void;
}) {
  const [shells, setShells] = useState<DetectedShell[]>([]);
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeId, setActiveId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [agentLogOpen, setAgentLogOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const setChannel = onChannel || (() => undefined);

  useEffect(() => {
    void invoke<DetectedShell[]>("pty_detect")
      .then((list) => setShells(Array.isArray(list) ? list : []))
      .catch(() => setShells([]))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const addTab = useCallback(
    (shell?: DetectedShell) => {
      const picked = shell || shells.find((item) => item.preferred) || shells[0];
      const tab: TermTab = {
        id: uid(),
        title: ssh ? `${ssh.user}@${ssh.host}` : picked?.name || folderName(cwd, copy.terminal),
        cwd,
        shell: ssh ? undefined : picked?.id,
        kind: "shell",
      };
      setTabs((current) => [...current, tab]);
      setActiveId(tab.id);
      setMenuOpen(false);
    },
    [copy.terminal, cwd, shells, ssh],
  );

  const sshKey = ssh ? `${ssh.user}@${ssh.host}:${ssh.port}:${ssh.remotePath}` : "";
  useEffect(() => {
    setTabs([]);
    setActiveId("");
  }, [cwd, sshKey]);

  useEffect(() => {
    if (!ready || tabs.length) return;
    addTab();
  }, [addTab, ready, tabs.length]);

  useEffect(() => {
    if (!runJob) return;
    const id = runJob.id.startsWith("run-") ? runJob.id : `run-${runJob.id}`;
    setTabs((current) => {
      const existing = current.find((tab) => tab.id === id);
      if (existing) {
        if (existing.title === runJob.title) return current;
        return current.map((tab) => (tab.id === id ? { ...tab, title: runJob.title } : tab));
      }
      return [
        ...current,
        {
          id,
          title: runJob.title,
          cwd: runJob.cwd || cwd,
          kind: "run",
          argv: runJob.argv,
        },
      ];
    });
    setActiveId(id);
  }, [cwd, runJob]);

  useEffect(() => {
    if (channel !== "debug") return;
    const run = [...tabs].reverse().find((tab) => tab.kind === "run");
    if (run && run.id !== activeId) setActiveId(run.id);
  }, [activeId, channel, tabs]);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((current) => {
        const next = current.filter((item) => item.id !== id);
        if (id === activeId) {
          const shell = [...next].reverse().find((tab) => tab.kind === "shell");
          setActiveId(shell?.id || next[next.length - 1]?.id || "");
        }
        return next;
      });
    },
    [activeId],
  );

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    const start = height;
    const origin = event.clientY;
    const move = (next: PointerEvent) => {
      onResize(Math.min(520, Math.max(140, start - (next.clientY - origin))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const channels: Array<{ id: PanelChannel; label: string; icon: typeof IconTerminal }> = [
    { id: "problems", label: copy.panelProblems, icon: IconWarning },
    { id: "output", label: copy.panelOutput, icon: IconOutput },
    { id: "debug", label: copy.panelDebug, icon: IconTerminal },
    { id: "terminal", label: copy.panelTerminal, icon: IconTerminal },
    { id: "ports", label: copy.panelPorts, icon: IconPorts },
  ];
  const showTerm = channel === "terminal" || (channel === "debug" && tabs.some((tab) => tab.kind === "run"));
  const visibleTabs = channel === "debug" ? tabs.filter((tab) => tab.kind === "run") : tabs;
  const logs = outputLines || [];

  return (
    <section className="term-pane" style={{ height }}>
      <div className="term-resize" onPointerDown={beginResize} />
      <div className="panel-channels">
        {channels.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={`panel-channel${channel === item.id ? " on" : ""}`}
              type="button"
              onClick={() => setChannel(item.id)}
            >
              <Icon size={13} />
              <span>{item.label}</span>
            </button>
          );
        })}
        <span className="term-tabs-spacer" />
        <button className="icon-btn" type="button" title={copy.hideTerminal} onClick={onClose}>
          <IconClose size={14} />
        </button>
      </div>
      {channel === "terminal" ? (
        <div className="term-tabs">
          <div className="term-tab-scroll">
          {tabs.map((tab) => {
            const job = tab.kind === "agent" ? agentJobs?.find((item) => `agent-${item.id}` === tab.id) : undefined;
            const busy = Boolean(job && /in_progress|pending|running/i.test(job.status)) || tab.kind === "run";
            return (
              <button
                key={tab.id}
                className={`term-tab${tab.id === activeId ? " on" : ""}${busy ? " busy" : ""}`}
                type="button"
                onClick={() => setActiveId(tab.id)}
              >
                {busy && tab.kind === "agent" ? <span className="term-tab-dot" /> : <IconTerminal size={13} />}
                <span>{tab.title}</span>
                <span
                  className="term-tab-x"
                  role="button"
                  tabIndex={0}
                  title={copy.close}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeTab(tab.id);
                    }
                  }}
                >
                  <IconClose size={11} />
                </span>
              </button>
            );
          })}
          </div>
          <div className="term-add-wrap" ref={menuRef}>
            <button
              className="term-add"
              type="button"
              title={copy.newTerminal}
              onClick={() => {
                if (!ssh && shells.length > 1) setMenuOpen((value) => !value);
                else addTab();
              }}
            >
              <IconPlus size={13} />
            </button>
            {menuOpen ? (
              <div className="term-shell-menu">
                {shells.map((item) => (
                  <button key={item.id} type="button" onClick={() => addTab(item)}>
                    {item.name}
                    {item.preferred ? <em>{copy.defaultShell}</em> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {channel === "terminal" && (agentJobs?.length || 0) > 0 ? (
        <div className="agent-run-log">
          <button
            className="agent-run-toggle"
            type="button"
            onClick={() => setAgentLogOpen((value) => !value)}
          >
            <span className={`agent-run-dot${(agentJobs || []).some((job) => !jobFinished(job.status)) ? " live" : ""}`} />
            <strong>{copy.agentRunLog}</strong>
            <em>{fill(copy.agentRunCount, { n: agentJobs?.length || 0 })}</em>
            <span className="agent-run-caret">{agentLogOpen ? "▾" : "▸"}</span>
          </button>
          {agentLogOpen ? (
            <div className="agent-run-body">
              {(agentJobs || []).map((job) => {
                const running = /in_progress|pending|running/i.test(job.status);
                const failed = /fail|error/i.test(job.status);
                return (
                  <details key={job.id} className={`agent-run-item${failed ? " bad" : running ? " run" : ""}`} open={running}>
                    <summary>
                      <span className="agent-run-cmd">{job.command || job.title}</span>
                      {job.status ? <span>{job.status}</span> : null}
                    </summary>
                    {job.output ? <pre>{job.output}</pre> : null}
                  </details>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={`term-body${showTerm ? "" : " hidden"}`}>
        {tabs.map((tab) => {
          const job = tab.kind === "agent" ? agentJobs?.find((item) => `agent-${item.id}` === tab.id) : undefined;
          const feed = job
            ? clipFeed(
                `$ ${job.command}${job.output ? `\n${job.output}` : ""}${job.status && !/in_progress|pending|running/i.test(job.status) ? `\n[${job.status}]` : ""}`,
              )
            : "";
          const inDebug = channel === "debug" && tab.kind === "run";
          const inTerm = channel === "terminal";
          return (
            <XtermView
              key={tab.id}
              id={tab.id}
              cwd={tab.cwd}
              shell={tab.shell}
              ssh={tab.kind === "agent" ? null : ssh}
              theme={theme}
              active={(inTerm || inDebug) && tab.id === activeId && visibleTabs.some((item) => item.id === tab.id)}
              kind={tab.kind}
              feed={feed}
              argv={tab.argv}
            />
          );
        })}
      </div>
      {channel === "problems" ? <div className="panel-empty">{copy.problemsEmpty}</div> : null}
      {channel === "output" ? (
        <div className="panel-log">
          {logs.length ? logs.map((line, index) => <pre key={`${index}-${line.slice(0, 24)}`}>{line}</pre>) : <p>{copy.outputEmpty}</p>}
        </div>
      ) : null}
      {channel === "debug" && !tabs.some((tab) => tab.kind === "run") ? (
        <div className="panel-empty">
          <p>{copy.debugEmpty}</p>
          <p className="hint">{copy.debugHint}</p>
        </div>
      ) : null}
      {channel === "ports" ? (
        <div className="panel-empty">
          {ports?.length ? (
            ports.map((item) => (
              <p key={item.port}>
                {item.label || "localhost"}:{item.port}
              </p>
            ))
          ) : (
            <p>{copy.portsEmpty}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
