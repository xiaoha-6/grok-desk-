import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ThinkingOrb } from "thinking-orbs";
import type { Copy } from "./i18n";
import { IconClose, IconDownload, IconExpand, IconRefresh, IconSave } from "./icons";
import { MessageBody } from "./markdown";
import { isImageGenEvent } from "./timeline";
import type { ChatMessage, MessageMedia, PromptAttachment, TimelineEvent } from "./types";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;

export function isImageGenActive(event: TimelineEvent) {
  if (!isImageGenEvent(event)) return false;
  const status = (event.status || "pending").toLowerCase();
  return !/complete|success|fail|error|cancel/.test(status);
}

export function isImageGenBusy(message?: ChatMessage, prevUserText = "") {
  if (!message || message.role !== "assistant") return false;
  if (!wantsImageGen(prevUserText)) return false;
  if ((message.events || []).some(isImageGenActive)) return true;
  if ((message.media || []).some(isShowableImage)) return false;
  return Boolean(message.streaming);
}

const CODING_OR_REVIEW =
  /改代码|修改文件|修复|修復|实现|實作|refactor|\bbug\b|\bfix\b|函数|函式|组件|元件|按钮|按鈕|\bhover\b|报错|報錯|为什么|為什麼|\.lua\b|\.tsx\b|\.jsx\b|\.css\b|\.html\b|\.js\b|\.ts\b|工作区|工作區|根据.{0,8}截图|根據.{0,8}截圖|从截图|從截圖|界面|頁面|页面|layout|screenshot|插件|\bplugin\b|检查|檢查|看看|帮我看|幫我看|帮我改|幫我改|代码|代碼|程式|fxmanifest|\breview\b|\bdebug\b|\binspect\b|\bcheck\b|有没有问题|有沒有問題|是否有需要/;

const PROJECT_ASSET_HINT =
  /素材|图标|圖標|\bicons?\b|\blogos?\b|\bassets?\b|配图|配圖|封面图|封面圖|背景图|背景圖|占位图|佔位圖|favicon|images\/|assets\/|public\/|(?:写进|寫進|保存到|存到|放到).{0,16}(?:图|圖|png|jpe?g|webp|项目|專案|目录|目錄)/i;

function looksLikeImageIntent(text: string) {
  return /(?:生成|画|畫|绘制|繪製).{0,12}(?:图|圖|照片|插画|插畫)|一张图|一張圖|(?<![产產])生图|(?<![产產])生圖|(?<![列找提])出图|(?<![列找提])出圖|文生图|文生圖|帮我画|幫我畫|(?:^|[\n\s])imagine(?:\s+(?:a|an|me)\b|\s*:)|image\s*gen|(?:draw|make|create|generate)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|illustration)\b(?!\s*(?:component|element|tag|url|path|asset|slider|src|file|icon))/i.test(
    text,
  );
}

function looksLikeAssetMake(text: string) {
  return /(?:生成|画|畫|做|出|准备|準備).{0,12}(?:素材|图标|圖標|配图|配圖|封面|背景|logo|icon|asset)/i.test(text);
}

export function wantsImageGen(text: string) {
  const value = text.trim();
  if (!value) return false;
  if (!looksLikeImageIntent(value)) return false;
  // Mixed coding / review prompts stay on Grok. "帮我画一下这个界面" is UI work, not Imagine.
  return !CODING_OR_REVIEW.test(value) && !PROJECT_ASSET_HINT.test(value);
}

/** Coding task that needs files on disk, not a picture in the transcript. */
export function wantsProjectImageAsset(text: string) {
  const value = text.trim();
  if (!value || wantsImageGen(value)) return false;
  if (!looksLikeImageIntent(value) && !looksLikeAssetMake(value)) return false;
  return CODING_OR_REVIEW.test(value) || PROJECT_ASSET_HINT.test(value);
}

export function allowsImageGenTool(text: string) {
  return wantsImageGen(text) || wantsProjectImageAsset(text);
}

/** Bypass ACP only for short, image-only prompts. Coding / screenshot-to-UI stays on Grok. */
export function isDirectImagePrompt(text: string, hasAttachments = false) {
  if (hasAttachments) return false;
  const value = text.trim();
  if (!value || value.length > 280) return false;
  return wantsImageGen(value);
}

export function isGeneratedImageProbe(command: string) {
  const text = command.toLowerCase().replace(/\\/g, "/");
  if (!text.trim()) return false;
  const touchesImageFile = /(?:^|[/\s"'=])(?:.*\/)?images\/[^ \n"']+\.(?:png|jpe?g|gif|webp|bmp|heic)/.test(text);
  const encodesImage = /b64encode|data:image|base64.*jpe?g|pathlib/.test(text) && /\.(?:png|jpe?g|gif|webp)\b/.test(text);
  const sessionImage = /(?:grokdesk-relay|\.grok)\/.*\/images\//.test(text);
  return touchesImageFile || encodesImage || sessionImage;
}

export function isImageProbeEvent(event: TimelineEvent) {
  return isGeneratedImageProbe(`${event.title}\n${event.input || ""}\n${event.output || ""}`);
}

export function friendlyImageError(raw: string, copy: Copy) {
  const text = String(raw || "").trim();
  if (/没有配置图片生成|還沒有設定圖片|not configured|no.*image.*model|image gen.*model/i.test(text)) {
    return copy.imageGenNotConfigured;
  }
  if (/\b403\b|forbidden|unauthorized|没有权限|沒有權限/i.test(text)) {
    return copy.imageGenForbidden;
  }
  if (/timeout|timed out|超时|超時|逾時/i.test(text)) {
    return copy.imageGenTimeout;
  }
  if (/context_too_large|context too large|请求内容过大|上下文.{0,16}(过大|太长|超限|爆了)|maximum context|too many tokens|prompt is too long/i.test(text)) {
    return copy.contextTooLarge;
  }
  return text || copy.imageGenFailed;
}

export function imageGenFailure(message?: ChatMessage) {
  if (!message) return "";
  const failed = (message.events || []).find((event) => {
    if (!isImageGenEvent(event)) return false;
    return /fail|error/.test((event.status || "").toLowerCase());
  });
  return failed?.output || failed?.title || message.error || "";
}

export function isShowableImage(item: MessageMedia) {
  const type = (item.type || "").toLowerCase();
  const mime = (item.mimeType || "").toLowerCase();
  const name = `${item.name || ""} ${item.uri || ""}`.toLowerCase();
  if (type === "image" || type === "imagegen" || mime.startsWith("image/")) return true;
  if ((type === "resource_link" || type === "file") && IMAGE_EXT.test(name)) return true;
  return Boolean(item.data && (mime.startsWith("image/") || type === "image"));
}

function filePathFromUri(uri: string) {
  const value = uri.trim();
  if (!value) return "";
  if (value.startsWith("file://")) {
    let path = decodeURIComponent(value.replace(/^file:\/\/(localhost)?/i, ""));
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    return path;
  }
  return value;
}

function isHttpLike(uri: string) {
  return /^(data:|blob:|https?:|asset:|tauri:)/i.test(uri);
}

export function mediaSrc(item?: MessageMedia | null) {
  if (!item) return "";
  if (item.data) return `data:${item.mimeType || "image/png"};base64,${item.data}`;
  const uri = (item.uri || "").trim();
  if (!uri) return "";
  if (isHttpLike(uri)) return uri;
  try {
    return convertFileSrc(filePathFromUri(uri));
  } catch {
    return uri;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(rec: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function looksLikeImagePath(value: string) {
  return IMAGE_EXT.test(value.split("?")[0] || "");
}

function looksLikeImage(rec: Record<string, unknown>, path: string, name: string) {
  const type = String(rec.type || rec.variant || "").toLowerCase();
  const mime = stringField(rec, "mimeType", "mime_type").toLowerCase();
  if (type === "image" || type === "imagegen" || type === "image_gen" || type === "resource_link") {
    return Boolean(path || rec.data);
  }
  if (mime.startsWith("image/")) return true;
  return looksLikeImagePath(`${name} ${path}`);
}

function pushImage(out: MessageMedia[], rec: Record<string, unknown>, path: string, at: number) {
  const data = stringField(rec, "data", "b64_json", "b64");
  const uri = path || stringField(rec, "uri", "url");
  if (!data && !uri) return;
  out.push({
    id: `img-${out.length}-${Math.random().toString(36).slice(2, 8)}`,
    type: "image",
    mimeType: stringField(rec, "mimeType", "mime_type") || undefined,
    data: data || undefined,
    uri: uri || undefined,
    name: stringField(rec, "name", "filename", "file_name") || uri.split("/").pop(),
    at,
  });
}

function parseMaybeJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[" && trimmed[0] !== "\"")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function extractMessageMedia(value: unknown, at = 0): MessageMedia[] {
  const out: MessageMedia[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth = 0) => {
    if (node == null || depth > 8) return;
    if (typeof node === "string") {
      const parsed = parseMaybeJson(node);
      if (parsed != null) {
        walk(parsed, depth + 1);
        return;
      }
      const pathMatch = node.match(
        /(?:^|[\s"'=])((?:\/(?:Users|home|root|var)[^\s"'\\]+|(?:\.\/)?images\/[^\s"'\\]+)\.(?:png|jpe?g|gif|webp|bmp|heic))/i,
      );
      if (pathMatch?.[1] && looksLikeImagePath(pathMatch[1])) {
        pushImage(out, { path: pathMatch[1] }, pathMatch[1], at);
      }
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    const rec = asRecord(node);
    if (!rec) return;
    const path = stringField(rec, "uri", "url", "path", "filePath", "file_path", "localPath", "local_path");
    const name = stringField(rec, "name", "filename", "file_name");
    if (looksLikeImage(rec, path, name) && (rec.data || path)) {
      pushImage(out, rec, path, at);
    }
    for (const key of ["content", "contents", "output", "rawOutput", "raw_output", "embeddedContent", "images", "text", "message"]) {
      if (rec[key] != null) walk(rec[key], depth + 1);
    }
  };
  walk(value);
  return out;
}

export function mediaFromEvents(events: TimelineEvent[] | undefined, at = 0) {
  return extractMessageMedia(
    (events || []).flatMap((event) => [event.output, event.input]),
    at,
  );
}

export function resolveMediaUri(uri: string, sessionDir?: string) {
  const value = uri.trim();
  if (!value) return "";
  if (isHttpLike(value) || value.startsWith("file:")) return value;
  if (/^\/(?!\/)/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return value;
  if (!sessionDir) return value;
  const relative = value.replace(/^\.\//, "").replace(/^\\/, "");
  const base = sessionDir.replace(/[/\\]+$/, "");
  return `${base}/${relative}`.replace(/\\/g, "/");
}

export function hydrateHistoryMedia(
  events: TimelineEvent[] | undefined,
  text = "",
  sessionDir?: string,
  at = 0,
) {
  const incoming = mergeMessageMedia(
    extractMessageMedia((events || []).flatMap((event) => [event.output, event.input]), at),
    extractMessageMedia(text, at),
    at,
  );
  return incoming.map((item) =>
    item.uri ? { ...item, uri: resolveMediaUri(item.uri, sessionDir) } : item,
  );
}

export function mergeMessageMedia(current: MessageMedia[], incoming: MessageMedia[], at = 0) {
  const next = [...current];
  for (const item of incoming) {
    const dup = next.some((existing) => {
      if (existing.uri && item.uri && existing.uri === item.uri) return true;
      if (existing.data && item.data && existing.data.slice(0, 120) === item.data.slice(0, 120)) return true;
      return false;
    });
    if (!dup) next.push({ ...item, at: item.at ?? at });
  }
  return next;
}

export function stripImageDumpText(text: string, hasImage: boolean) {
  if (!text) return "";
  let next = text;
  if (hasImage) {
    next = next.replace(/```(?:json)?\s*[\s\S]*?(?:filePath|file_path|"path"|filename)[\s\S]*?```/gi, "");
    next = next.replace(/(?:图片路径|圖片路徑|image path)\s*[:：]\s*`?[^`\n]+`?/gi, "");
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}

export function aspectFromEvents(events: TimelineEvent[] | undefined) {
  for (const event of events || []) {
    const match = `${event.input || ""}`.match(/aspect_ratio["']?\s*[:=]\s*["']?(\d+)\s*:\s*(\d+)/i);
    if (match) return `${match[1]} / ${match[2]}`;
  }
  return "16 / 9";
}

async function downloadImage(src: string, name?: string) {
  try {
    const response = await fetch(src);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name || "grok-image.png";
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    const link = document.createElement("a");
    link.href = src;
    link.download = name || "grok-image.png";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.click();
  }
}

async function saveImageAs(src: string, item?: MessageMedia | null) {
  const uri = (item?.uri || "").trim();
  const path = uri && !isHttpLike(uri) ? filePathFromUri(uri) : "";
  const data = item?.data || (src.startsWith("data:") ? src.replace(/^data:[^;]+;base64,/, "") : "");
  await invoke<string | null>("save_image_as", {
    path: path || undefined,
    data: path ? undefined : data || undefined,
    name: item?.name || "grok-image.png",
  });
}

function ImageLightbox({
  src,
  name,
  copy,
  onClose,
  onSaveAs,
  onRedraw,
}: {
  src: string;
  name?: string;
  copy: Copy;
  onClose: () => void;
  onSaveAs?: () => void;
  onRedraw?: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="chat-image-lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <div className="chat-image-lightbox-inner" onClick={(event) => event.stopPropagation()}>
        <img src={src} alt={name || ""} />
        <div className="chat-image-lightbox-bar">
          <button type="button" title={copy.downloadImage} onClick={() => void downloadImage(src, name)}>
            <IconDownload size={16} />
            <span>{copy.downloadImage}</span>
          </button>
          {onSaveAs ? (
            <button type="button" title={copy.saveImageAs} onClick={onSaveAs}>
              <IconSave size={16} />
              <span>{copy.saveImageAs}</span>
            </button>
          ) : null}
          {onRedraw ? (
            <button type="button" title={copy.redrawImage} onClick={onRedraw}>
              <IconRefresh size={16} />
              <span>{copy.redrawImage}</span>
            </button>
          ) : null}
          <button type="button" title={copy.closeImage} onClick={onClose}>
            <IconClose size={16} />
            <span>{copy.closeImage}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function GeneratingField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    let raf = 0;
    let live = true;
    let lastPaint = 0;
    const frameMs = 50;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const blobs = [
      { phase: 0.2, speed: 0.22, radius: 0.3, ampX: 0.22, ampY: 0.18 },
      { phase: 2.1, speed: 0.16, radius: 0.24, ampX: 0.2, ampY: 0.2 },
      { phase: 4.0, speed: 0.28, radius: 0.18, ampX: 0.16, ampY: 0.14 },
    ];

    const paint = (now: number) => {
      if (!live) return;
      if (document.hidden) {
        raf = 0;
        return;
      }
      if (!reduced && lastPaint && now - lastPaint < frameMs) {
        raf = requestAnimationFrame(paint);
        return;
      }
      lastPaint = now;
      const parent = canvas.parentElement;
      const width = Math.max(1, parent?.clientWidth || 420);
      const height = Math.max(1, parent?.clientHeight || 236);
      const dpr = Math.min(1.25, window.devicePixelRatio || 1);
      const pixelW = Math.floor(width * dpr);
      const pixelH = Math.floor(height * dpr);
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#101010";
      ctx.fillRect(0, 0, width, height);

      const time = reduced ? 0 : now / 1000;
      const centers = blobs.map((blob, index) => ({
        x: 0.5 + Math.cos(time * blob.speed * 2.2 + blob.phase) * blob.ampX + (index === 1 ? 0.04 : 0),
        y: 0.48 + Math.sin(time * blob.speed * 1.7 + blob.phase * 0.85) * blob.ampY,
        r: blob.radius,
      }));

      const gap = 16;
      for (let y = gap * 0.55; y < height + gap; y += gap) {
        for (let x = gap * 0.55; x < width + gap; x += gap) {
          const nx = x / width;
          const ny = y / height;
          let light = 0.1;
          for (const center of centers) {
            const dx = nx - center.x;
            const dy = ny - center.y;
            const dist = Math.sqrt(dx * dx + dy * dy) / center.r;
            light += Math.exp(-dist * dist * 2.35) * 0.95;
          }
          const twinkle = reduced ? 1 : 0.82 + 0.18 * Math.sin(x * 0.33 + y * 0.29 + time * 1.55);
          const alpha = Math.min(1, light * twinkle);
          ctx.fillStyle = `rgba(255,255,255,${0.06 + alpha * 0.78})`;
          ctx.beginPath();
          ctx.arc(x, y, 1.05 + alpha * 0.42, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (!reduced) raf = requestAnimationFrame(paint);
    };

    const resume = () => {
      if (!live || raf || document.hidden || reduced) return;
      raf = requestAnimationFrame(paint);
    };
    paint(performance.now());
    const observer = new ResizeObserver(() => {
      lastPaint = 0;
      resume();
    });
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    document.addEventListener("visibilitychange", resume);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);

  return <canvas className="chat-image-field" ref={canvasRef} aria-hidden />;
}

export function ChatGeneratedImage({
  item,
  generating,
  error,
  copy,
  aspect,
  onRedraw,
}: {
  item?: MessageMedia;
  generating?: boolean;
  error?: string;
  copy: Copy;
  aspect?: string;
  onRedraw?: () => void;
}) {
  const fallbackSrc = mediaSrc(item);
  const [src, setSrc] = useState(item?.data ? fallbackSrc : "");
  const [loadedSrc, setLoadedSrc] = useState("");
  const [open, setOpen] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const ready = Boolean(src) && loadedSrc === src;
  const failed = Boolean(error) && !ready;

  useEffect(() => {
    let cancelled = false;
    const uri = (item?.uri || "").trim();
    if (item?.data) {
      setSrc(`data:${item.mimeType || "image/png"};base64,${item.data}`);
      return;
    }
    if (!uri) {
      setSrc("");
      return;
    }
    if (isHttpLike(uri)) {
      setSrc(uri);
      return;
    }
    const path = filePathFromUri(uri);
    void invoke<PromptAttachment>("read_image_file", { path })
      .then((file) => {
        if (cancelled || !file?.data) return;
        setSrc(`data:${file.mimeType || "image/jpeg"};base64,${file.data}`);
      })
      .catch(() => {
        if (!cancelled) setSrc(fallbackSrc);
      });
    return () => {
      cancelled = true;
    };
  }, [item?.data, item?.mimeType, item?.uri, fallbackSrc]);

  useLayoutEffect(() => {
    const node = imgRef.current;
    if (src && node?.complete && node.naturalWidth) setLoadedSrc(src);
  }, [src]);

  if (!src && !generating && !failed) {
    if (item?.uri || item?.name) {
      return (
        <a className="media-link" href={item.uri} target="_blank" rel="noreferrer">
          {item.name || item.uri}
        </a>
      );
    }
    return null;
  }

  const showField = Boolean((generating && !ready) || (failed && !ready));
  const style = showField ? ({ aspectRatio: aspect || "16 / 9" } as CSSProperties) : undefined;

  return (
    <>
      <figure
        className={`chat-image-card ${ready ? "is-ready" : failed ? "is-failed" : "generating"}`}
        style={style}
      >
        {showField ? (
          <>
            <GeneratingField />
            {failed ? (
              <div className="chat-image-fail">
                <strong>{copy.imageGenFailed}</strong>
                <span>{error}</span>
                {onRedraw ? (
                  <button type="button" onClick={onRedraw}>
                    <IconRefresh size={14} />
                    {copy.retryImage}
                  </button>
                ) : null}
              </div>
            ) : (
              <span className="chat-image-badge">
                <ThinkingOrb state="shaping" size={20} theme="dark" />
                {copy.generatingImage}
              </span>
            )}
          </>
        ) : null}
        {src ? (
          <img
            ref={imgRef}
            src={src}
            alt={item?.name || ""}
            className={ready ? "is-ready" : ""}
            onLoad={() => setLoadedSrc(src)}
            onClick={() => {
              if (ready) setOpen(true);
            }}
          />
        ) : null}
        {ready ? (
          <div className="chat-image-actions">
            <button type="button" title={copy.openImage} onClick={() => setOpen(true)}>
              <IconExpand size={15} />
            </button>
            <button type="button" title={copy.downloadImage} onClick={() => void downloadImage(src, item?.name)}>
              <IconDownload size={15} />
            </button>
            <button type="button" title={copy.saveImageAs} onClick={() => void saveImageAs(src, item)}>
              <IconSave size={15} />
            </button>
            {onRedraw ? (
              <button type="button" title={copy.redrawImage} onClick={onRedraw}>
                <IconRefresh size={15} />
              </button>
            ) : null}
          </div>
        ) : null}
      </figure>
      {open && ready ? (
        <ImageLightbox
          src={src}
          name={item?.name}
          copy={copy}
          onClose={() => setOpen(false)}
          onSaveAs={() => void saveImageAs(src, item)}
          onRedraw={onRedraw}
        />
      ) : null}
    </>
  );
}

export const ChatMessageMedia = memo(function ChatMessageMedia({
  message,
  copy,
  expectImage,
  allowImageUi = true,
  sessionDir,
  onRedraw,
}: {
  message: ChatMessage;
  copy: Copy;
  expectImage?: boolean;
  allowImageUi?: boolean;
  sessionDir?: string;
  onRedraw?: () => void;
}) {
  const images = allowImageUi
    ? mergeMessageMedia(
        (message.media || []).map((item) =>
          item.uri ? { ...item, uri: resolveMediaUri(item.uri, sessionDir) } : item,
        ),
        mediaFromEvents(message.events, 0).map((item) =>
          item.uri ? { ...item, uri: resolveMediaUri(item.uri, sessionDir) } : item,
        ),
      ).filter(isShowableImage)
    : [];
  const imageEvents = allowImageUi ? message.events || [] : [];
  let pending = imageEvents.filter(isImageGenActive).length;
  if (expectImage && allowImageUi && !images.length && message.streaming) pending = Math.max(pending, 1);
  const rawFail = allowImageUi ? imageGenFailure(message) : "";
  const failText = rawFail ? friendlyImageError(rawFail, copy) : "";
  const failed = Boolean(!images.length && !message.streaming && rawFail);
  const placeholders = Math.max(0, pending - images.length);
  const others = (message.media || []).filter((item) => !isShowableImage(item));
  const text = stripImageDumpText(
    allowImageUi ? message.text || "" : (message.text || "").replace(/!\[[^\]]*\]\([^)]+\)/g, ""),
    images.length > 0 || placeholders > 0 || failed || !allowImageUi,
  );
  const aspect = aspectFromEvents(message.events);
  if (!text && !images.length && !placeholders && !others.length && !failed) return null;

  const nodes: ReactNode[] = [];
  const ordered = [...images].sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
  ordered.forEach((item, index) => {
    nodes.push(
      <ChatGeneratedImage
        key={item.id || `img-${index}`}
        item={item}
        generating={message.streaming && !item.data && !item.uri}
        copy={copy}
        aspect={aspect}
        onRedraw={onRedraw}
      />,
    );
  });
  for (let index = 0; index < placeholders; index += 1) {
    nodes.push(<ChatGeneratedImage key={`gen-${index}`} generating copy={copy} aspect={aspect} />);
  }
  if (failed && !placeholders) {
    nodes.push(
      <ChatGeneratedImage
        key="gen-failed"
        error={failText || copy.imageGenFailed}
        copy={copy}
        aspect={aspect}
        onRedraw={onRedraw}
      />,
    );
  }
  if (text) {
    nodes.push(
      <MessageBody
        key="text-end"
        text={text}
        streaming={message.streaming && Boolean(text)}
      />,
    );
  }
  others.forEach((item) => {
    nodes.push(
      <a key={item.id} className="media-link" href={item.uri} target="_blank" rel="noreferrer">
        {item.name || item.uri || item.type}
      </a>,
    );
  });
  return <div className="chat-media-flow">{nodes}</div>;
});
