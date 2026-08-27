export type LaunchConfig = {
  name?: string;
  type?: string;
  request?: string;
  program?: string;
  cwd?: string;
  args?: string[] | string;
  runtimeExecutable?: string;
  command?: string;
  env?: Record<string, string>;
  console?: string;
};

export type LaunchFile = {
  version?: string;
  configurations?: LaunchConfig[];
};

export const LAUNCH_PATH = ".vscode/launch.json";

export function stripJsonNoise(text: string) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseLaunchConfigs(text: string): LaunchConfig[] {
  try {
    const json = JSON.parse(stripJsonNoise(text)) as LaunchFile;
    return Array.isArray(json.configurations) ? json.configurations.filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function guessLaunchType(file?: string) {
  const ext = (file || "").split(".").pop()?.toLowerCase() || "";
  if (["js", "mjs", "cjs", "ts", "tsx", "jsx"].includes(ext)) return "node";
  if (ext === "py") return "python";
  if (ext === "go") return "go";
  if (ext === "rs") return "cargo";
  return "";
}

const NOT_RUNNABLE = /\.(json|jsonc|md|txt|zip|png|jpe?g|gif|webp|pdf|css|html|svg|xml|yml|yaml|toml|lock)$/i;

export function isRunnableProgram(path?: string) {
  const value = (path || "").split("?")[0].replace(/\\/g, "/");
  if (!value || value.endsWith("/")) return false;
  if (value.endsWith("launch.json") || value.includes("/.vscode/")) return false;
  return !NOT_RUNNABLE.test(value);
}

export function defaultLaunchJson(file?: string) {
  const runnable = isRunnableProgram(file);
  const type = (runnable ? guessLaunchType(file) : "") || "node";
  const program = runnable && file ? `\${workspaceFolder}/${file.replace(/^\/+/, "")}` : "${file}";
  const config: LaunchConfig = {
    type,
    request: "launch",
    name: type === "node" ? "Launch Program" : type === "python" ? "Python: Current File" : "Run",
    program,
    cwd: "${workspaceFolder}",
    console: "integratedTerminal",
  };
  return `${JSON.stringify({ version: "0.2.0", configurations: [config] }, null, 2)}\n`;
}

function subst(value: string, vars: Record<string, string>) {
  return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => vars[key] ?? "");
}

export type RunJob = {
  id: string;
  title: string;
  argv: string[];
  cwd: string;
};

export function resolveLaunch(
  config: LaunchConfig,
  opts: { workspaceFolder: string; file?: string },
): { argv: string[]; cwd: string; title: string; ports: number[] } {
  const file = (opts.file || "").replace(/^\/+/, "");
  const fileAbs = file ? `${opts.workspaceFolder.replace(/\/$/, "")}/${file}` : opts.workspaceFolder;
  const slash = fileAbs.lastIndexOf("/");
  const vars: Record<string, string> = {
    workspaceFolder: opts.workspaceFolder,
    file: fileAbs,
    fileBasename: slash >= 0 ? fileAbs.slice(slash + 1) : fileAbs,
    fileDirname: slash >= 0 ? fileAbs.slice(0, slash) : opts.workspaceFolder,
    fileExtname: file.includes(".") ? `.${file.split(".").pop()}` : "",
  };
  const cwd = subst(config.cwd || "${workspaceFolder}", vars) || opts.workspaceFolder;
  const program = subst(config.program || (file ? fileAbs : ""), vars);
  const args = Array.isArray(config.args)
    ? config.args.map((item) => subst(String(item), vars))
    : config.args
      ? subst(String(config.args), vars).split(/\s+/).filter(Boolean)
      : [];
  const command = config.command ? subst(config.command, vars) : "";
  const runtime = subst(config.runtimeExecutable || "", vars);
  const type = (config.type || guessLaunchType(file) || "node").toLowerCase();
  let argv: string[] = [];
  if (command) {
    argv = ["/bin/sh", "-c", command];
  } else if (!isRunnableProgram(program) && type !== "cargo") {
    argv = [];
  } else if (type === "python" || type === "debugpy") {
    argv = [runtime || "python3", program, ...args];
  } else if (type === "node" || type === "pwa-node") {
    argv = [runtime || "node", program, ...args];
  } else if (type === "go") {
    argv = [runtime || "go", "run", program, ...args];
  } else if (type === "cargo" || (type === "lldb" && program.includes("cargo"))) {
    argv = [runtime || "cargo", "run", ...args];
  } else if (program && isRunnableProgram(program)) {
    argv = [runtime || program, ...(runtime ? [program, ...args] : args)];
  }
  const ports: number[] = [];
  for (const value of Object.values(config.env || {})) {
    const num = Number(value);
    if (Number.isInteger(num) && num > 0 && num < 65536) ports.push(num);
  }
  return {
    argv,
    cwd,
    title: config.name || "Run",
    ports,
  };
}
