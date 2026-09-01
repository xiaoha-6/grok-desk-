import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IconClose } from "./icons";
import { fill, type Copy } from "./i18n";
import type { RelayQuota } from "./types";

export const RELAY_PROMO_URL = "https://xiaohaweb.com/";
export const RELAY_TOPUP_URL = RELAY_PROMO_URL;
export const RELAY_LOW_BALANCE = 3;

export type RelayQuotaLevel = "empty" | "low" | "ok" | "auth" | "unavailable" | "pending";

export function formatAmount(value: number) {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 100 || Number.isInteger(value)) return String(Math.round(value * 100) / 100);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function relayQuotaLevel(quota: RelayQuota | null | undefined): RelayQuotaLevel {
  if (!quota?.configured) return "pending";
  if (quota.errorKind === "auth") return "auth";
  if (quota.errorKind === "unavailable" || quota.errorKind === "parse" || quota.errorKind === "http") {
    return quota.remaining == null ? "unavailable" : relayBalanceLevel(quota.remaining);
  }
  if (quota.errorKind === "no_balance") return "empty";
  if (quota.remaining == null) return quota.error ? "unavailable" : "pending";
  return relayBalanceLevel(quota.remaining);
}

function relayBalanceLevel(remaining: number): RelayQuotaLevel {
  if (remaining < 0 || remaining >= 99_000_000) return "ok";
  if (remaining <= 0) return "empty";
  if (remaining < RELAY_LOW_BALANCE) return "low";
  return "ok";
}

export function relayQuotaNeedsAttention(quota: RelayQuota | null | undefined) {
  const level = relayQuotaLevel(quota);
  return level === "empty" || level === "low";
}

export function relayQuotaMessage(quota: RelayQuota | null | undefined, copy: Copy) {
  const level = relayQuotaLevel(quota);
  if (level === "empty") return copy.relayNoBalance;
  if (level === "low") {
    return fill(copy.relayLowBalance, {
      amount: formatAmount(quota?.remaining || 0),
      unit: quota?.unit || "USD",
    });
  }
  if (level === "auth") return copy.relayQuotaAuth;
  if (level === "unavailable") return copy.relayQuotaUnavailable;
  if (quota?.error && /HTTP\s*22|中转站接口 HTTP/i.test(quota.error)) return copy.relayNoBalance;
  if (quota?.error) return copy.relayQuotaFailed;
  return "";
}

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

export function RelayQuotaBanner({ quota, copy }: { quota: RelayQuota | null; copy: Copy }) {
  const [hidden, setHidden] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const level = relayQuotaLevel(quota);
  const visible = !hidden && (level === "empty" || level === "low");
  const message = relayQuotaMessage(quota, copy);

  useEffect(() => {
    setHidden(false);
    setLeaving(false);
  }, [level, quota?.remaining]);

  if (!visible || !message) return null;

  return (
    <div className={`relay-promo quota-banner${leaving ? " out" : ""} ${level}`} role="status" aria-label={message}>
      <button className="relay-promo-bar" type="button" onClick={() => void openRelayPromo()}>
        <strong>{message}</strong>
        <span>{copy.goRecharge}</span>
      </button>
      <button
        className="relay-promo-close"
        type="button"
        title={copy.close}
        onClick={(event) => {
          event.stopPropagation();
          setLeaving(true);
          window.setTimeout(() => {
            setHidden(true);
            setLeaving(false);
          }, 380);
        }}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}

export function RelayPromoBanner({ copy, suppressed = false }: { copy: Copy; suppressed?: boolean }) {
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

  if (suppressed || !visible) return null;

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
