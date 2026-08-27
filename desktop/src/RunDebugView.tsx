import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Copy } from "./i18n";
import { defaultLaunchJson, LAUNCH_PATH, parseLaunchConfigs, resolveLaunch, type LaunchConfig, type RunJob } from "./launch";
import type { SshTarget } from "./types";

type Props = {
  cwd: string;
  ssh?: SshTarget | null;
  copy: Copy;
  activeFile?: string;
  onOpenFile: (path: string) => void;
  onRun: (job: RunJob) => void;
  onLog?: (line: string) => void;
};

export function RunDebugView({ cwd, ssh, copy, activeFile, onOpenFile, onRun, onLog }: Props) {
  const [configs, setConfigs] = useState<LaunchConfig[]>([]);
  const [selected, setSelected] = useState(0);
  const [missing, setMissing] = useState(true);

  const load = useCallback(async () => {
    if (!cwd) {
      setConfigs([]);
      setMissing(true);
      return;
    }
    try {
      const file = await invoke<{ content: string }>("read_workspace_file", {
        root: cwd,
        path: LAUNCH_PATH,
        ssh: ssh || null,
      });
      const next = parseLaunchConfigs(file.content || "");
      setConfigs(next);
      setMissing(false);
      setSelected((index) => Math.min(index, Math.max(0, next.length - 1)));
    } catch {
      setConfigs([]);
      setMissing(true);
    }
  }, [cwd, ssh]);

  useEffect(() => {
    void load();
  }, [load]);

  async function ensureLaunch() {
    if (!cwd) return;
    const text = defaultLaunchJson(activeFile);
    await invoke("write_workspace_file", { root: cwd, path: LAUNCH_PATH, content: text, ssh: ssh || null });
    onLog?.(`${LAUNCH_PATH}`);
    await onOpenFile(LAUNCH_PATH);
    await load();
  }

  function start(config?: LaunchConfig) {
    const picked = config || configs[selected];
    if (!picked) {
      void ensureLaunch();
      return;
    }
    const resolved = resolveLaunch(picked, { workspaceFolder: cwd, file: activeFile });
    if (!resolved.argv.length || !resolved.argv[0]) {
      onLog?.(copy.runNoFile);
      return;
    }
    onRun({
      id: `run-${Date.now()}`,
      title: resolved.title,
      argv: resolved.argv,
      cwd: resolved.cwd,
    });
  }

  return (
    <div className="run-view">
      <header className="run-head">
        <strong>{copy.runTitle}</strong>
        {configs.length ? (
          <div className="run-picker">
            <select value={String(selected)} onChange={(event) => setSelected(Number(event.target.value))}>
              {configs.map((item, index) => (
                <option key={`${item.name}-${index}`} value={index}>
                  {item.name || `config ${index + 1}`}
                </option>
              ))}
            </select>
            <button className="primary compact" type="button" onClick={() => start()}>
              {copy.runAndDebug}
            </button>
          </div>
        ) : null}
      </header>
      <div className="run-welcome">
        <p>{copy.runWelcome}</p>
        <button className="run-start" type="button" disabled={!cwd} onClick={() => start()}>
          {copy.runAndDebug}
        </button>
        <p className="run-launch">
          {copy.runCreateLaunch.split("launch.json")[0]}
          <button type="button" disabled={!cwd} onClick={() => void ensureLaunch()}>
            launch.json
          </button>
          {copy.runCreateLaunch.split("launch.json")[1] || ""}
        </p>
        {missing && !activeFile ? <p className="hint">{copy.runNoFile}</p> : null}
      </div>
    </div>
  );
}
