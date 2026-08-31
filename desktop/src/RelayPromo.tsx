import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IconClose } from "./icons";
import type { Copy } from "./i18n";

export const RELAY_PROMO_URL = "https://xiaohaweb.com/";

const VISIBLE_MS = 9_000;
const FIRST_MIN = 50_000;
const FIRST_SPAN = 40_000;
const NEXT_MIN = 16 * 60_000;
const NEXT_SPAN = 14 * 60_000;

let shownOnce = false;
let nextAt = Date.now() + FIRST_MIN + Math.floor(Math.random() * FIRST_SPAN);
let hideAt = 0;
let timer = 0;
const listeners = new Set<(visible: boolean) => void>();

function nextGap() {
  return shownOnce ? NEXT_MIN + Math.floor(Math.random() * NEXT_SPAN) : FIRST_MIN + Math.floor(Math.random() * FIRST_SPAN);
}

function notify(visible: boolean) {
  listeners.forEach((fn) => fn(visible));
}

function armTimer() {
  window.clearTimeout(timer);
  const due = hideAt || nextAt;
  timer = window.setTimeout(() => {
    const now = Date.now();
    if (hideAt && now >= hideAt) {
      hideAt = 0;
      shownOnce = true;
      nextAt = now + nextGap();
      notify(false);
      armTimer();
      return;
    }
    if (!hideAt && now >= nextAt) {
      hideAt = now + VISIBLE_MS;
      notify(true);
    }
    armTimer();
  }, Math.max(400, due - Date.now()));
}

export async function openRelayPromo() {
  try {
    await openUrl(RELAY_PROMO_URL);
  } catch {
    window.open(RELAY_PROMO_URL, "_blank", "noopener,noreferrer");
  }
}

export function RelayPromoBanner({ copy }: { copy: Copy }) {
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const onChange = (next: boolean) => {
      if (next) {
        setLeaving(false);
        setVisible(true);
        return;
      }
      setLeaving(true);
      window.setTimeout(() => {
        setVisible(false);
        setLeaving(false);
      }, 420);
    };
    listeners.add(onChange);
    armTimer();
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className={`relay-promo${leaving ? " out" : ""}`} role="dialog" aria-label={copy.relayPromoTitle}>
      <button className="relay-promo-bar" type="button" onClick={() => void openRelayPromo()}>
        <strong>{copy.relayPromoBody}</strong>
        <span>{copy.relayPromoHint}</span>
      </button>
      <button
        className="relay-promo-close"
        type="button"
        title={copy.close}
        onClick={(event) => {
          event.stopPropagation();
          hideAt = 0;
          shownOnce = true;
          nextAt = Date.now() + nextGap();
          notify(false);
          armTimer();
        }}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}
