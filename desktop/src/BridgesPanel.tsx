import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Select } from "./Select";
import { BRIDGE_CATALOG, mergeBridgesConfig, type BridgeMeta } from "./bridgeCatalog";
import type { Copy, Lang } from "./i18n";
import type { BridgeChannel, BridgeKind, BridgePairing, BridgesConfig, BridgesStatus } from "./types";

function SettingsRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div>
        <div className="row-title">{title}</div>
        {detail ? <div className="row-detail">{detail}</div> : null}
      </div>
      {children ? <div className="row-control">{children}</div> : null}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      className={value ? "switch on" : "switch"}
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
    >
      <span />
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="bridge-field">
      <span>
        {label}
        {hint ? <em>{hint}</em> : null}
      </span>
      {children}
    </label>
  );
}

function localized(meta: BridgeMeta, lang: Lang, key: "name" | "hint" | "targetHint") {
  if (lang === "en") return meta[key].en;
  if (lang === "zh-Hant") return meta[key].hant;
  return meta[key].zh;
}

function ChannelCard({
  meta,
  channel,
  live,
  open,
  busy,
  copy,
  lang,
  onToggle,
  onPatch,
  onTest,
  onProbe,
}: {
  meta: BridgeMeta;
  channel: BridgeChannel;
  live?: BridgesStatus["channels"][number];
  open: boolean;
  busy: boolean;
  copy: Copy;
  lang: Lang;
  onToggle: () => void;
  onPatch: (next: Partial<BridgeChannel>) => void;
  onTest: () => void;
  onProbe: () => void;
}) {
  return (
    <section className={`group bridge-card${channel.enabled ? " on" : ""}`}>
      <button className="bridge-card-head" type="button" onClick={onToggle}>
        <span className="bridge-card-copy">
          <strong>{localized(meta, lang, "name")}</strong>
          <span className="bridge-card-hint">{localized(meta, lang, "hint")}</span>
        </span>
        <span className={live?.running ? "pill ok" : channel.enabled ? "pill warn" : "pill"}>
          {live?.running ? copy.bridgesRunning : channel.enabled ? copy.bridgesIdle : copy.bridgesOff}
        </span>
      </button>
      {open ? (
        <div className="bridge-fields">
          <SettingsRow title={copy.bridgesEnable} detail={copy.bridgesChannelEnable}>
            <Toggle value={channel.enabled} onChange={(value) => onPatch({ enabled: value })} />
          </SettingsRow>
          <SettingsRow title={copy.bridgesMirror} detail={copy.bridgesMirrorDetail}>
            <Toggle value={channel.mirrorOutbound} onChange={(value) => onPatch({ mirrorOutbound: value })} />
          </SettingsRow>
          <SettingsRow title={copy.bridgesInbound} detail={copy.bridgesInboundDetail}>
            <Toggle value={channel.acceptInbound} onChange={(value) => onPatch({ acceptInbound: value })} />
          </SettingsRow>
          {meta.fields.includes("token") && meta.id !== "sms" ? (
            <Field label={copy.bridgeToken} hint={copy.bridgeTokenHint}>
              <input
                type="password"
                value={channel.token}
                spellCheck={false}
                onChange={(event) => onPatch({ token: event.target.value })}
              />
            </Field>
          ) : null}
          {meta.fields.includes("verify") ? (
            <Field label={copy.bridgeVerifyToken} hint={copy.bridgeVerifyTokenHint}>
              <input
                type="password"
                value={channel.verificationToken}
                spellCheck={false}
                onChange={(event) => onPatch({ verificationToken: event.target.value })}
              />
            </Field>
          ) : null}
          {meta.id === "feishu" ? (
            <SettingsRow title={copy.bridgeConnectionMode} detail={copy.bridgeConnectionHint}>
              <Select
                variant="field"
                align="end"
                value={channel.connectionMode || "websocket"}
                onChange={(value) => onPatch({ connectionMode: value as BridgeChannel["connectionMode"] })}
                options={[
                  { id: "websocket", label: copy.bridgeConnectionWs },
                  { id: "webhook", label: copy.bridgeConnectionWebhook },
                ]}
              />
            </SettingsRow>
          ) : null}
          {meta.fields.includes("encrypt") ? (
            <Field label={copy.bridgeEncryptKey} hint={copy.bridgeEncryptKeyHint}>
              <input
                type="password"
                value={channel.encryptKey}
                spellCheck={false}
                onChange={(event) => onPatch({ encryptKey: event.target.value })}
              />
            </Field>
          ) : null}
          {meta.fields.includes("app") ? (
            <>
              <Field label={meta.id === "sms" ? "Account SID" : meta.id === "whatsapp" ? "Phone Number ID" : "App ID"}>
                <input
                  value={channel.appId}
                  spellCheck={false}
                  onChange={(event) => onPatch({ appId: event.target.value })}
                />
              </Field>
              {meta.id !== "whatsapp" && meta.id !== "sms" ? (
                <Field label="App Secret">
                  <input
                    type="password"
                    value={channel.appSecret}
                    spellCheck={false}
                    onChange={(event) => onPatch({ appSecret: event.target.value })}
                  />
                </Field>
              ) : null}
              {meta.id === "sms" ? (
                <Field label="Auth Token">
                  <input
                    type="password"
                    value={channel.token}
                    spellCheck={false}
                    onChange={(event) => onPatch({ token: event.target.value })}
                  />
                </Field>
              ) : null}
            </>
          ) : null}
          {meta.fields.includes("from") ? (
            <Field label={copy.bridgeFrom} hint={copy.bridgeFromHint}>
              <input
                value={channel.appSecret}
                spellCheck={false}
                onChange={(event) => onPatch({ appSecret: event.target.value })}
              />
            </Field>
          ) : null}
          {meta.fields.includes("domain") ? (
            <Field label={meta.id === "matrix" ? copy.bridgeHomeserver : copy.bridgeDomain}>
              {meta.id === "feishu" ? (
                <Select
                  variant="field"
                  align="end"
                  value={channel.domain || "feishu"}
                  onChange={(value) => onPatch({ domain: value })}
                  options={[
                    { id: "feishu", label: copy.bridgeFeishuCn },
                    { id: "lark", label: "Lark" },
                  ]}
                />
              ) : (
                <input
                  value={channel.domain}
                  spellCheck={false}
                  placeholder="https://matrix.org"
                  onChange={(event) => onPatch({ domain: event.target.value })}
                />
              )}
            </Field>
          ) : null}
          {meta.fields.includes("target") ? (
            <Field label={copy.bridgeTarget} hint={localized(meta, lang, "targetHint")}>
              <input
                value={channel.defaultTarget}
                spellCheck={false}
                onChange={(event) => onPatch({ defaultTarget: event.target.value })}
              />
            </Field>
          ) : null}
          {meta.fields.includes("webhook") ? (
            <Field label={copy.bridgeWebhookUrl} hint={copy.bridgeWebhookOptional}>
              <input
                value={channel.webhookUrl}
                spellCheck={false}
                onChange={(event) => onPatch({ webhookUrl: event.target.value })}
              />
            </Field>
          ) : null}
          <Field label={copy.bridgeAllowFrom} hint={copy.bridgeAllowFromHint}>
            <input
              value={channel.allowFrom}
              spellCheck={false}
              onChange={(event) => onPatch({ allowFrom: event.target.value })}
            />
          </Field>
          <SettingsRow title={copy.bridgeDmPolicy} detail={copy.bridgeDmPolicyHint}>
            <Select
              variant="field"
              align="end"
              value={channel.dmPolicy}
              onChange={(value) => onPatch({ dmPolicy: value as BridgeChannel["dmPolicy"] })}
              options={[
                { id: "allowlist", label: copy.bridgePolicyAllowlist },
                { id: "open", label: copy.bridgePolicyOpen },
                { id: "pairing", label: copy.bridgePolicyPairing },
                { id: "disabled", label: copy.bridgePolicyDisabled },
              ]}
            />
          </SettingsRow>
          <SettingsRow title={copy.bridgeRequireMention} detail={copy.bridgeRequireMentionHint}>
            <Toggle value={channel.requireMention} onChange={(value) => onPatch({ requireMention: value })} />
          </SettingsRow>
          {live?.error ? <p className="error">{live.error}</p> : null}
          <div className="actions">
            <button className="ghost compact" type="button" disabled={busy || !channel.enabled} onClick={onTest}>
              {copy.bridgesTest}
            </button>
            <button className="ghost compact" type="button" disabled={busy} onClick={onProbe}>
              {copy.bridgeProbe}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function BridgesPanel({ copy, lang }: { copy: Copy; lang: Lang }) {
  const [config, setConfig] = useState<BridgesConfig>(mergeBridgesConfig());
  const [status, setStatus] = useState<BridgesStatus | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<BridgeKind>("telegram");

  const refresh = () => {
    void invoke<BridgesConfig>("bridges_load")
      .then((next) => setConfig(mergeBridgesConfig(next)))
      .catch((err) => setError(String(err)));
    void invoke<BridgesStatus>("bridges_status")
      .then(setStatus)
      .catch(() => undefined);
  };

  useEffect(() => {
    refresh();
    let gone = false;
    let unlisten: (() => void) | undefined;
    void listen<BridgePairing[]>("bridge-pairing", () => {
      if (!gone) refresh();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  const groups = useMemo(
    () => [
      { id: "core" as const, title: copy.bridgeGroupCore },
      { id: "work" as const, title: copy.bridgeGroupWork },
      { id: "more" as const, title: copy.bridgeGroupMore },
    ],
    [copy],
  );

  const patch = (patch: Partial<BridgesConfig>) => setConfig((current) => ({ ...current, ...patch }));
  const patchChannel = (kind: BridgeKind, next: Partial<BridgeChannel>) =>
    setConfig((current) => ({
      ...current,
      channels: {
        ...current.channels,
        [kind]: { ...(current.channels[kind] || mergeBridgesConfig().channels[kind]), ...next },
      },
    }));

  const apply = () => {
    setBusy(true);
    setMessage("");
    setError("");
    void invoke<BridgesStatus>("bridges_apply", { config })
      .then((next) => {
        setStatus(next);
        setMessage(copy.bridgesSaved);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const test = (kind: BridgeKind) => {
    setBusy(true);
    setMessage("");
    setError("");
    void invoke<string>("bridges_test", { kind })
      .then((out) => setMessage(out || copy.bridgesTestOk))
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const probe = (kind: BridgeKind) => {
    setBusy(true);
    setMessage("");
    setError("");
    void invoke<string>("bridges_probe", { kind })
      .then((out) => setMessage(out || copy.bridgeProbeOk))
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const decide = (kind: string, sender: string, accept: boolean) => {
    setBusy(true);
    setError("");
    void invoke<BridgePairing[]>("bridges_pairing_decide", { kind, sender, accept })
      .then(() => refresh())
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const pairings = status?.pairings || [];

  return (
    <>
      <p className="lede">{copy.bridgesHint}</p>
      <section className="group">
        <SettingsRow title={copy.bridgesEnable} detail={copy.bridgesEnableDetail}>
          <Toggle value={config.enabled} onChange={(value) => patch({ enabled: value })} />
        </SettingsRow>
        <SettingsRow title={copy.bridgesWebhook} detail={status?.webhook || "http://127.0.0.1:18791/bridge/{channel}"} />
      </section>
      <section className="group">
        <div className="settings-row">
          <div>
            <div className="row-title">{copy.bridgePairingTitle}</div>
            <div className="row-detail">{copy.bridgePairingHint}</div>
          </div>
        </div>
        {pairings.length === 0 ? (
          <div className="settings-row">
            <div className="row-detail">{copy.bridgePairingEmpty}</div>
          </div>
        ) : null}
        {pairings.map((item) => (
          <div key={`${item.kind}-${item.sender}`} className="bridge-pairing">
            <div>
              <strong>{item.kind}</strong>
              <span>
                {item.sender} · {item.code}
              </span>
              {item.preview ? <em>{item.preview}</em> : null}
            </div>
            <div className="actions">
              <button className="ghost compact" type="button" disabled={busy} onClick={() => decide(item.kind, item.sender, true)}>
                {copy.bridgePairingApprove}
              </button>
              <button className="ghost compact" type="button" disabled={busy} onClick={() => decide(item.kind, item.sender, false)}>
                {copy.bridgePairingDeny}
              </button>
            </div>
          </div>
        ))}
      </section>
      {groups.map((group) => (
        <div key={group.id} className="bridge-group">
          <div className="section-label">{group.title}</div>
          {BRIDGE_CATALOG.filter((item) => item.group === group.id).map((meta) => {
            const channel = config.channels[meta.id] || mergeBridgesConfig().channels[meta.id];
            return (
              <ChannelCard
                key={meta.id}
                meta={meta}
                channel={channel}
                live={status?.channels.find((item) => item.id === meta.id)}
                open={open === meta.id}
                busy={busy}
                copy={copy}
                lang={lang}
                onToggle={() => setOpen(open === meta.id ? "" : meta.id)}
                onPatch={(next) => patchChannel(meta.id, next)}
                onTest={() => test(meta.id)}
                onProbe={() => probe(meta.id)}
              />
            );
          })}
        </div>
      ))}
      {message ? <p className="ok-text">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="actions">
        <button className="primary" type="button" disabled={busy} onClick={apply}>
          {busy ? copy.bridgesSaving : copy.bridgesApply}
        </button>
      </div>
    </>
  );
}
