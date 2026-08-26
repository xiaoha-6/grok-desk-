import { useMemo, useState, type ReactNode } from "react";
import {
  IconArchive,
  IconBolt,
  IconBox,
  IconChevronLeft,
  IconGear,
  IconHand,
  IconPerson,
  IconPencil,
  IconPlan,
  IconRelay,
  IconShield,
  IconSliders,
  IconSpark,
  IconTerminal,
} from "./icons";
import type { Copy } from "./i18n";
import { ModelPicker } from "./ModelPicker";
import { Select } from "./Select";
import {
  EFFORTS,
  PERMISSION_MODES,
  mergeModelOptions,
  type AccountRecord,
  type AppSettings,
  type CatalogModel,
  type Lang,
  type RelayImport,
  type RelayQuota,
  type RuntimeStatus,
  type SettingsPage,
  type SkillRecord,
  type SshTarget,
  type Theme,
} from "./types";

export function SettingsRow({
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

function ModelSelect({
  value,
  options,
  onChange,
  onRefresh,
  loading,
  refreshLabel,
  allowCustom,
  searchPlaceholder,
  emptyLabel,
}: {
  value: string;
  options: CatalogModel[];
  onChange: (value: string) => void;
  onRefresh?: () => void;
  loading?: boolean;
  refreshLabel?: string;
  allowCustom?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
}) {
  const current = options.some((item) => item.id === value) ? value : options[0]?.id || value;
  return (
    <div className="model-pick">
      <ModelPicker
        value={current}
        options={options}
        onChange={onChange}
        disabled={loading}
        variant="field"
        align="end"
        allowCustom={allowCustom}
        searchPlaceholder={searchPlaceholder}
        emptyLabel={emptyLabel}
        customPlaceholder="grok-4.5"
      />
      {onRefresh ? (
        <button className="ghost compact" type="button" disabled={loading} onClick={onRefresh}>
          {refreshLabel}
        </button>
      ) : null}
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

export function SettingsView(props: {
  t: Copy;
  lang: Lang;
  theme: Theme;
  setLang: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  sidebarWidth: number;
  beginResize: (event: React.PointerEvent<HTMLDivElement>) => void;
  settingsPage: SettingsPage;
  setSettingsPage: (page: SettingsPage) => void;
  onBack: () => void;
  settings: AppSettings;
  patchSettings: (patch: Partial<AppSettings>) => void;
  model: string;
  setModel: (model: string) => void;
  availableModels: CatalogModel[];
  modelsLoading: boolean;
  modelsError: string;
  modelsMessage: string;
  onRefreshModels: (fromForm?: boolean) => void;
  cwd: string;
  applyCwd: (path: string, ssh?: SshTarget | null) => void;
  onPickWorkspace?: () => void;
  onConnectSsh?: () => void;
  ssh?: SshTarget | null;
  sshHosts?: SshTarget[];
  status: RuntimeStatus | null;
  statusError: string;
  installing: boolean;
  installLog: string;
  installError: string;
  installOfficial: () => void;
  refreshRuntime: () => void;
  form: RelayImport;
  setForm: (form: RelayImport) => void;
  importing: boolean;
  importMessage: string;
  importError: string;
  applyImport: (form: RelayImport) => void;
  accounts: AccountRecord[];
  setAccounts: (accounts: AccountRecord[]) => void;
  loginLog: string;
  addingAccount: boolean;
  refreshingQuota: boolean;
  onAddAccount: (name: string) => void;
  onLogin: (account: AccountRecord) => void;
  onRefreshQuotas: () => void;
  relayQuota: RelayQuota | null;
  relayQuotaText: string;
  onOpenAccount: (account: AccountRecord) => void;
  onRemoveAccount: (id: string) => void;
  routedAccountId?: string;
  skills: SkillRecord[];
  skillsQuery: string;
  setSkillsQuery: (value: string) => void;
  onRefreshSkills: () => void;
  selectedSkill: SkillRecord | null;
  setSelectedSkill: (skill: SkillRecord | null) => void;
  archived: { id: string; title: string; cwd: string }[];
  onDeleteArchived: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const copy = props.t;
  const items: Array<{ id: SettingsPage; title: string; icon: ReactNode }> = [
    { id: "general", title: copy.general, icon: <IconGear /> },
    { id: "runtime", title: copy.runtime, icon: <IconTerminal /> },
    { id: "relay", title: copy.relay, icon: <IconRelay /> },
    { id: "ssh", title: copy.ssh, icon: <IconTerminal /> },
    { id: "agent", title: copy.agent, icon: <IconSpark size={15} /> },
    { id: "compatibility", title: copy.compatibility, icon: <IconSliders /> },
    { id: "skills", title: copy.skills, icon: <IconBox /> },
    { id: "accounts", title: copy.accounts, icon: <IconPerson /> },
    { id: "archived", title: copy.archived, icon: <IconArchive /> },
  ];
  const visible = items.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase()));
  const title = items.find((item) => item.id === props.settingsPage)?.title || copy.settings;
  const routingHint =
    props.settings.routingMode === "sequential"
      ? copy.routingSequentialHint
      : props.settings.routingMode === "roundRobin"
        ? copy.routingRoundRobinHint
        : props.settings.routingMode === "fixed"
          ? copy.routingFixedHint
          : copy.routingQuotaHint;
  const modelOptions = mergeModelOptions(props.availableModels, props.model || props.form.model);
  const filteredSkills = useMemo(() => {
    const q = props.skillsQuery.trim().toLowerCase();
    if (!q) return props.skills;
    return props.skills.filter((skill) =>
      `${skill.displayName || ""} ${skill.name} ${skill.description} ${skill.scope}`.toLowerCase().includes(q),
    );
  }, [props.skills, props.skillsQuery]);

  return (
    <div className="app settings-app">
      <aside className="sidebar settings-nav" style={{ width: props.sidebarWidth }}>
        <button className="back-row" type="button" onClick={props.onBack}>
          <IconChevronLeft />
          <span>{copy.back}</span>
        </button>
        <input
          className="settings-search"
          value={query}
          placeholder={copy.searchSettings}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="section-label">{copy.settings}</div>
        {visible.map((item) => (
          <button
            key={item.id}
            className={props.settingsPage === item.id ? "nav-item on" : "nav-item"}
            type="button"
            onClick={() => props.setSettingsPage(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.title}
          </button>
        ))}
      </aside>
      <div className="resize" onPointerDown={props.beginResize} />
      <main className="settings-main">
        <div className="settings-canvas">
          <h1>{title}</h1>

          {props.settingsPage === "general" && (
            <>
              <section className="group">
                <SettingsRow title={copy.appearance} detail={copy.appearanceDetail}>
                  <Select
                    variant="field"
                    align="end"
                    ariaLabel={copy.appearance}
                    value={props.theme}
                    onChange={(value) => props.setTheme(value as Theme)}
                    options={[
                      { id: "system", label: copy.followSystem },
                      { id: "light", label: copy.light },
                      { id: "dark", label: copy.dark },
                    ]}
                  />
                </SettingsRow>
                <SettingsRow title={copy.language} detail={copy.languageDetail}>
                  <Select
                    variant="field"
                    align="end"
                    ariaLabel={copy.language}
                    value={props.lang}
                    onChange={(value) => props.setLang(value as Lang)}
                    options={[
                      { id: "zh", label: "简体中文" },
                      { id: "en", label: "English" },
                    ]}
                  />
                </SettingsRow>
              </section>
              <section className="group">
                <SettingsRow title={copy.model} detail={copy.modelDetail}>
                  <ModelSelect
                    value={props.model}
                    options={modelOptions}
                    onChange={props.setModel}
                    onRefresh={() => props.onRefreshModels(false)}
                    loading={props.modelsLoading}
                    refreshLabel={props.modelsLoading ? copy.fetchingModels : copy.fetchModels}
                    searchPlaceholder={copy.searchModels}
                    emptyLabel={copy.noMatchingModels}
                  />
                </SettingsRow>
                <SettingsRow title={copy.workspace} detail={copy.workspaceDetail}>
                  <div className="model-pick">
                    <input value={props.cwd} spellCheck={false} onChange={(event) => props.applyCwd(event.target.value)} />
                    {props.onPickWorkspace ? (
                      <button className="ghost compact" type="button" onClick={props.onPickWorkspace}>
                        {copy.localFolder}
                      </button>
                    ) : null}
                    {props.onConnectSsh ? (
                      <button className="ghost compact" type="button" onClick={props.onConnectSsh}>
                        {copy.remoteFolder}
                      </button>
                    ) : null}
                  </div>
                </SettingsRow>
                <SettingsRow title={copy.effort} detail={copy.modelDetail}>
                  <Select
                    variant="field"
                    align="end"
                    ariaLabel={copy.effort}
                    value={props.settings.reasoningEffort}
                    onChange={(value) => props.patchSettings({ reasoningEffort: value })}
                    options={EFFORTS.map((item) => ({ id: item.id, label: item.label }))}
                  />
                </SettingsRow>
              </section>
            </>
          )}

          {props.settingsPage === "ssh" && (
            <>
              <section className="group">
                <SettingsRow title={copy.ssh} detail={copy.sshDetail}>
                  {props.onConnectSsh ? (
                    <button className="ghost compact nowrap" type="button" onClick={props.onConnectSsh}>
                      {copy.sshConnectAction}
                    </button>
                  ) : null}
                </SettingsRow>
                <SettingsRow
                  title={copy.workspace}
                  detail={props.ssh ? `${props.ssh.user}@${props.ssh.host}:${props.ssh.remotePath}` : copy.workspaceDetail}
                />
                <div className="settings-note">
                  <p>{copy.sshWindowsLinux}</p>
                  <p>{copy.sshNeedGrok}</p>
                </div>
                {(props.sshHosts || []).length ? (
                  <div className="ssh-recent">
                    <div className="row-title">{copy.sshRecent}</div>
                    {(props.sshHosts || []).map((item) => (
                      <div key={`${item.user}@${item.host}:${item.port}/${item.remotePath}`} className="hint left">
                        {item.alias || `${item.user}@${item.host}:${item.port}`} {item.remotePath}
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            </>
          )}

          {props.settingsPage === "runtime" && (
            <>
              <section className="group">
                <SettingsRow title="Grok Build" detail={props.status?.installed ? copy.installed : copy.missing}>
                  <span className={props.status?.installed ? "pill ok" : "pill warn"}>
                    {props.status?.installed ? copy.installed : copy.missing}
                  </span>
                </SettingsRow>
                <SettingsRow title={copy.path} detail={props.status?.path || "—"} />
                <SettingsRow title={copy.version} detail={props.status?.version || "—"} />
                <SettingsRow title={copy.dataDir} detail={props.status?.grokHome || "—"} />
                <SettingsRow title={copy.connection} detail={copy.connectionDetail}>
                  <span className="pill ok">ACP</span>
                </SettingsRow>
                <SettingsRow title={copy.contextWindow} detail={copy.contextWindowDetail}>
                  <input
                    type="number"
                    min={16000}
                    value={props.settings.contextWindowTokens}
                    onChange={(event) =>
                      props.patchSettings({
                        contextWindowTokens: Math.max(16000, Number(event.target.value) || 500000),
                      })
                    }
                  />
                </SettingsRow>
                <SettingsRow title={copy.autoCompact} detail={copy.autoCompactDetail}>
                  <input
                    type="number"
                    min={50}
                    max={99}
                    value={props.settings.autoCompactThresholdPercent}
                    onChange={(event) =>
                      props.patchSettings({
                        autoCompactThresholdPercent: Math.min(
                          99,
                          Math.max(50, Number(event.target.value) || 85),
                        ),
                      })
                    }
                  />
                </SettingsRow>
              </section>
              <p className="hint left">{props.status?.os === "windows" ? copy.windowsHint : copy.unixHint}</p>
              {props.installLog ? <pre className="log">{props.installLog}</pre> : null}
              {props.installError || props.statusError ? (
                <p className="error">{props.installError || props.statusError}</p>
              ) : null}
              <div className="actions">
                {!props.status?.installed ? (
                  <button
                    className="primary"
                    type="button"
                    disabled={props.installing}
                    onClick={props.installOfficial}
                  >
                    {props.installing ? copy.installing : copy.install}
                  </button>
                ) : null}
                <button className="ghost" type="button" disabled={props.installing} onClick={props.refreshRuntime}>
                  {copy.redetect}
                </button>
              </div>
            </>
          )}

          {props.settingsPage === "relay" && (
            <>
              <p className="lede">{copy.relayHint}</p>
              <section className="group stacked">
                <label>
                  {copy.endpoint}
                  <input
                    value={props.form.endpoint}
                    spellCheck={false}
                    placeholder="https://api.xiaohaweb.com/v1"
                    onChange={(event) => props.setForm({ ...props.form, endpoint: event.target.value })}
                  />
                </label>
                <label>
                  {copy.apiKey}
                  <input
                    type="password"
                    value={props.form.apiKey}
                    spellCheck={false}
                    placeholder="sk-..."
                    onChange={(event) => props.setForm({ ...props.form, apiKey: event.target.value })}
                  />
                </label>
                <div className="two">
                  <label>
                    {copy.model}
                    <ModelSelect
                      value={props.form.model || props.model}
                      options={modelOptions}
                      onChange={props.setModel}
                      onRefresh={() => props.onRefreshModels(true)}
                      loading={props.modelsLoading}
                      refreshLabel={props.modelsLoading ? copy.fetchingModels : copy.fetchModels}
                      allowCustom
                      searchPlaceholder={copy.searchModels}
                      emptyLabel={copy.noMatchingModels}
                    />
                  </label>
                  <label>
                    {copy.name}
                    <input
                      value={props.form.name}
                      onChange={(event) => props.setForm({ ...props.form, name: event.target.value })}
                    />
                  </label>
                </div>
              </section>
              {props.modelsMessage ? <p className="ok-text">{props.modelsMessage}</p> : null}
              {props.modelsError ? <p className="error">{props.modelsError}</p> : null}
              {props.importMessage ? <p className="ok-text">{props.importMessage}</p> : null}
              {props.importError ? <p className="error">{props.importError}</p> : null}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  disabled={props.importing || !props.form.endpoint || !props.form.apiKey}
                  onClick={() => props.applyImport(props.form)}
                >
                  {props.importing ? copy.importing : copy.import}
                </button>
              </div>
              {props.relayQuota?.configured ? (
                <section className="group">
                  <SettingsRow title={copy.relayQuota} detail={props.relayQuota.endpoint || props.form.endpoint}>
                    <span className="pill ok">{props.relayQuotaText || copy.quotaPending}</span>
                  </SettingsRow>
                  {props.relayQuota.planName ? (
                    <SettingsRow title={copy.name} detail={props.relayQuota.planName} />
                  ) : null}
                  {props.relayQuota.error ? <p className="error">{props.relayQuota.error}</p> : null}
                  <div className="actions">
                    <button className="ghost" type="button" disabled={props.refreshingQuota} onClick={props.onRefreshQuotas}>
                      {props.refreshingQuota ? copy.refreshing : copy.refreshQuota}
                    </button>
                  </div>
                </section>
              ) : null}
            </>
          )}

          {props.settingsPage === "agent" && (
            <section className="group">
              <SettingsRow title={copy.permissionMode} detail={copy.permissionDetail}>
                <Select
                  variant="field"
                  align="end"
                  ariaLabel={copy.permissionMode}
                  value={props.settings.permissionMode}
                  onChange={(value) => props.patchSettings({ permissionMode: value })}
                  options={PERMISSION_MODES.map((item) => ({
                    id: item.id,
                    label: props.lang === "en" ? item.labelEn : item.labelZh,
                    hint: props.lang === "en" ? item.hintEn : item.hintZh,
                    icon:
                      item.id === "acceptEdits" ? (
                        <IconPencil size={14} />
                      ) : item.id === "plan" ? (
                        <IconPlan size={14} />
                      ) : item.id === "auto" ? (
                        <IconBolt size={14} />
                      ) : item.id === "bypassPermissions" ? (
                        <IconShield size={14} />
                      ) : (
                        <IconHand size={14} />
                      ),
                  }))}
                />
              </SettingsRow>
              <SettingsRow title={copy.memory} detail={copy.memoryDetail}>
                <Toggle
                  value={props.settings.enableMemory}
                  onChange={(value) => props.patchSettings({ enableMemory: value })}
                />
              </SettingsRow>
              <SettingsRow title={copy.webFetch} detail={copy.webFetchDetail}>
                <Toggle
                  value={props.settings.enableWebSearch}
                  onChange={(value) => props.patchSettings({ enableWebSearch: value })}
                />
              </SettingsRow>
              <SettingsRow title={copy.subagents} detail={copy.subagentsDetail}>
                <Toggle
                  value={props.settings.enableSubagents}
                  onChange={(value) => props.patchSettings({ enableSubagents: value })}
                />
              </SettingsRow>
            </section>
          )}

          {props.settingsPage === "compatibility" && (
            <section className="group">
              <SettingsRow title={copy.maxTurns} detail={copy.maxTurnsDetail}>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={props.settings.maxTurns}
                  onChange={(event) =>
                    props.patchSettings({ maxTurns: Math.min(500, Math.max(1, Number(event.target.value) || 50)) })
                  }
                />
              </SettingsRow>
              <SettingsRow title={copy.extraArgs} detail={copy.extraArgsDetail}>
                <input
                  value={props.settings.extraArguments}
                  onChange={(event) => props.patchSettings({ extraArguments: event.target.value })}
                />
              </SettingsRow>
            </section>
          )}

          {props.settingsPage === "skills" && (
            <>
              <div className="skills-head">
                <p className="lede">{copy.skillsHint}</p>
                <button className="ghost" type="button" onClick={props.onRefreshSkills}>
                  {copy.refresh}
                </button>
              </div>
              <input
                className="settings-search skills-search"
                value={props.skillsQuery}
                placeholder={copy.searchSkills}
                onChange={(event) => props.setSkillsQuery(event.target.value)}
              />
              {filteredSkills.length === 0 ? (
                <p className="hint left">{copy.skillsEmpty}</p>
              ) : (
                <div className="skill-grid">
                  {filteredSkills.map((skill) => (
                    <button
                      key={skill.id}
                      className="skill-card"
                      type="button"
                      onClick={() => props.setSelectedSkill(skill)}
                    >
                      <span className="skill-ico">
                        <IconBox />
                      </span>
                      <span className="skill-meta">
                        <span className="skill-title">
                          {skill.displayName || skill.name}
                          <em>{skill.scope}</em>
                        </span>
                        <span className="skill-desc">{skill.shortDescription || skill.description}</span>
                      </span>
                      <span className={skill.enabled ? "dot on" : "dot"} />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {props.settingsPage === "accounts" && (
            <>
              <div className="accounts-head">
                <p className="lede">{copy.accountsHint}</p>
                <button className="ghost" type="button" disabled={props.refreshingQuota} onClick={props.onRefreshQuotas}>
                  {props.refreshingQuota ? copy.refreshing : copy.refreshQuota}
                </button>
              </div>
              <section className="group stacked">
                <div className="settings-row bare">
                  <div>
                    <div className="row-title">{copy.routing}</div>
                    <div className="row-detail">{routingHint}</div>
                  </div>
                  <Select
                    variant="field"
                    align="end"
                    ariaLabel={copy.routing}
                    value={props.settings.routingMode}
                    onChange={(value) => props.patchSettings({ routingMode: value })}
                    options={[
                      { id: "quota", label: copy.routingQuota },
                      { id: "sequential", label: copy.routingSequential },
                      { id: "roundRobin", label: copy.routingRoundRobin },
                      { id: "fixed", label: copy.routingFixed },
                    ]}
                  />
                </div>
                {props.settings.routingMode === "fixed" ? (
                  <div className="settings-row bare">
                    <div className="row-title">{copy.preferredAccount}</div>
                    <Select
                      variant="field"
                      align="end"
                      ariaLabel={copy.preferredAccount}
                      value={props.settings.preferredAccountId || ""}
                      onChange={(value) => props.patchSettings({ preferredAccountId: value || null })}
                      options={[
                        { id: "", label: copy.autoFallback },
                        ...props.accounts
                          .filter((account) => account.enabled)
                          .map((account) => ({ id: account.id, label: account.name })),
                      ]}
                    />
                  </div>
                ) : null}
              </section>
              <div className="account-grid">
                {props.accounts.map((account) => (
                  <article key={account.id} className="account-card">
                    <header>
                      <span className={account.loggedIn ? "dot on" : "dot"} />
                      <input
                        className="account-rename"
                        value={account.name}
                        onChange={(event) =>
                          props.setAccounts(
                            props.accounts.map((item) =>
                              item.id === account.id ? { ...item, name: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <Toggle
                        value={account.enabled}
                        onChange={(value) =>
                          props.setAccounts(
                            props.accounts.map((item) =>
                              item.id === account.id ? { ...item, enabled: value } : item,
                            ),
                          )
                        }
                      />
                    </header>
                    {!account.enabled ? (
                      <p className="hint left">{copy.accountDisabled}</p>
                    ) : account.quota?.weeklyRemainingPercent != null ? (
                      <div className="quota">
                        <div className="quota-row">
                          <span>{copy.weeklyLeft}</span>
                          <strong>{account.quota.weeklyRemainingPercent.toFixed(1)}%</strong>
                        </div>
                        <div className="quota-bar">
                          <i
                            style={{
                              width: `${Math.min(100, Math.max(0, account.quota.weeklyRemainingPercent))}%`,
                            }}
                          />
                        </div>
                      </div>
                    ) : (
                      <p className={account.quota?.error ? "error" : "hint left"}>
                        {account.quota?.error || (account.loggedIn ? copy.loggedInWait : copy.notLoggedIn)}
                      </p>
                    )}
                    <footer>
                      <button className="ghost compact" type="button" onClick={() => props.onLogin(account)}>
                        {account.loggedIn ? copy.reLogin : copy.login}
                      </button>
                      {account.loggedIn ? (
                        <button className="ghost compact" type="button" onClick={() => props.onOpenAccount(account)}>
                          {copy.startChat}
                        </button>
                      ) : null}
                      {account.id !== "local" ? (
                        <button className="ghost compact danger" type="button" onClick={() => props.onRemoveAccount(account.id)}>
                          {copy.deleteChat}
                        </button>
                      ) : null}
                      {props.routedAccountId === account.id ? (
                        <span className="pill ok">{copy.routePreferred}</span>
                      ) : null}
                    </footer>
                  </article>
                ))}
              </div>
              <div className="add-account">
                <input
                  value={newName}
                  placeholder={copy.accountName}
                  onChange={(event) => setNewName(event.target.value)}
                />
                <button
                  className="primary"
                  type="button"
                  disabled={props.addingAccount}
                  onClick={() => {
                    props.onAddAccount(newName);
                    setNewName("");
                  }}
                >
                  {props.addingAccount ? copy.waitingLogin : copy.addAccountBtn}
                </button>
              </div>
              {props.loginLog ? (
                <details className="log-wrap">
                  <summary>{copy.loginLog}</summary>
                  <pre className="log">{props.loginLog}</pre>
                </details>
              ) : null}
            </>
          )}

          {props.settingsPage === "archived" && (
            <>
              {props.archived.length === 0 ? (
                <p className="hint left">{copy.noArchive}</p>
              ) : (
                <div className="archive-list">
                  {props.archived.map((item) => (
                    <div key={item.id} className="archive-row">
                      <div>
                        <div className="row-title">{item.title}</div>
                        <div className="row-detail">{item.cwd}</div>
                      </div>
                      <button className="ghost compact" type="button" onClick={() => props.onDeleteArchived(item.id)}>
                        {copy.deleteChat}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {props.selectedSkill ? (
        <div className="overlay" onClick={() => props.setSelectedSkill(null)}>
          <div className="modal wide" onClick={(event) => event.stopPropagation()}>
            <h3>
              {props.selectedSkill.displayName || props.selectedSkill.name}{" "}
              <span className="muted">/{props.selectedSkill.name}</span>
            </h3>
            <p>{props.selectedSkill.description}</p>
            <pre className="log skill-body">{props.selectedSkill.content}</pre>
            <div className="actions">
              <button className="ghost" type="button" onClick={() => props.setSelectedSkill(null)}>
                {copy.cancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
