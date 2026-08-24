import { useMemo } from "react";
import { Icon, addCollection } from "@iconify/react/offline";
import { icons as vscodeIcons } from "@iconify-json/vscode-icons";
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from "vscode-icons-js";

addCollection(vscodeIcons);

const DEFAULT_FILE = "default_file.svg";
const DEFAULT_FOLDER = "default_folder.svg";

const ICON_ALIASES: Record<string, string> = {
  "file-type-pdf": "file-type-pdf2",
  drawio: "file-type-drawio",
  "file-type-affectscript": "file-type-actionscript",
};

const SUFFIX_ICONS: Array<[RegExp, string]> = [
  [/\.sqlite(?:-shm|-wal|-journal)?$/i, "file-type-sqlite"],
  [/\.(?:db|sqlite3)$/i, "file-type-sqlite"],
  [/\.(?:dylib|so|dll|o|a|bin)$/i, "file-type-binary"],
  [/\.(?:dic|dict|aff)$/i, "file-type-text"],
  [/\.(?:strings|stringsdict|entitlements|plist)$/i, "file-type-xml"],
  [/\.(?:log|out)$/i, "file-type-log"],
  [/\.(?:mp4|mov|mkv|avi|webm|m4v)$/i, "file-type-video"],
  [/\.(?:png|jpe?g|gif|webp|bmp|tiff?|ico|heic|svg)$/i, "file-type-image"],
];

function baseName(path: string) {
  return (path.split(/[\\/]/).pop() || path).trim();
}

function svgToIconId(svg: string) {
  const id = svg.replace(/\.svg$/i, "").replace(/_/g, "-");
  return ICON_ALIASES[id] || id;
}

function extraFileIcon(name: string) {
  const lower = name.toLowerCase();
  for (const [pattern, icon] of SUFFIX_ICONS) {
    if (pattern.test(lower)) return icon;
  }
  return "";
}

function lookupFileIcon(name: string) {
  const exact = getIconForFile(name);
  if (exact && exact !== DEFAULT_FILE) return exact;
  const lower = name.toLowerCase();
  if (lower !== name) {
    const next = getIconForFile(lower);
    if (next && next !== DEFAULT_FILE) return next;
  }
  const extra = extraFileIcon(name);
  if (extra) return `${extra.replace(/^file-type-/, "file_type_")}.svg`;
  return exact || DEFAULT_FILE;
}

function lookupFolderIcon(name: string, open: boolean) {
  const pick = open ? getIconForOpenFolder : getIconForFolder;
  const exact = pick(name);
  const fallback = open ? "default_folder_opened.svg" : DEFAULT_FOLDER;
  if (exact && exact !== DEFAULT_FOLDER && exact !== fallback) return exact;
  const lower = name.toLowerCase();
  if (lower !== name) {
    const next = pick(lower);
    if (next) return next;
  }
  return exact || fallback;
}

function hasIcon(id: string) {
  return Boolean(vscodeIcons.icons?.[id] || vscodeIcons.aliases?.[id]);
}

function iconNameFor(name: string, isDir: boolean, isOpen: boolean) {
  const base = baseName(name) || (isDir ? "folder" : "file");
  const svg = isDir ? lookupFolderIcon(base, isOpen) : lookupFileIcon(base);
  const id = svgToIconId(svg);
  if (hasIcon(id)) return id;
  if (isDir) return isOpen ? "default-folder-opened" : "default-folder";
  return "default-file";
}

export function fileExtension(name: string) {
  const base = baseName(name) || name;
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index + 1).toLowerCase() : "";
}

export function fileBadge(name: string, language?: string) {
  const ext = fileExtension(name);
  if (ext) return ext.toUpperCase();
  if (language && language !== "text") return language.toUpperCase();
  return "FILE";
}

export function FileKindIcon({
  name,
  isDir,
  isOpen = false,
  size = 16,
}: {
  name: string;
  isDir: boolean;
  isOpen?: boolean;
  size?: number;
}) {
  const icon = useMemo(() => iconNameFor(name, isDir, isOpen), [name, isDir, isOpen]);
  return (
    <span className="ws-file-icon" style={{ width: size, height: size }}>
      <Icon icon={`vscode-icons:${icon}`} width={size} height={size} />
    </span>
  );
}
