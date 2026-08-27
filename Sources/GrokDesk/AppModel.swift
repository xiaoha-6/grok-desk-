import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var accounts: [GrokAccount]
    @Published var conversations: [Conversation]
    @Published var selectedConversationID: UUID? {
        didSet {
            guard selectedConversationID != oldValue, let selectedConversationID else { return }
            // A background session is refreshed at a lower cadence. Flush it
            // immediately when the user opens that chat so its transcript is
            // current before SwiftUI renders the newly selected conversation.
            flushACPUpdates(for: selectedConversationID)
        }
    }
    @Published var settings: AppSettings
    @Published var sidebarSection: SidebarSection = .chat
    @Published var settingsPage = "通用"
    @Published var workspaceMode: WorkspaceMode = .modern
    /// Every conversation owns its own turn lifecycle. ACP runtimes are already
    /// isolated by conversation, so the UI state must preserve that same
    /// boundary instead of globally blocking unrelated chats.
    @Published private(set) var runningConversationIDs: Set<UUID> = []
    @Published var isRefreshingQuota = false
    @Published var isAddingAccount = false
    @Published var statusText = "就绪"
    @Published var loginLog = ""
    @Published var toolCalls: [UUID: [ToolCallRecord]] = [:]
    @Published var plans: [UUID: [PlanEntryRecord]] = [:]
    @Published var extensionEvents: [UUID: [(String, String)]] = [:]
    @Published var pendingPermission: PendingPermission?
    @Published var pendingQuestion: PendingQuestionRequest?
    @Published var pendingPlanApproval: PendingPlanApproval?
    @Published var rawCapabilityResult = ""
    @Published var pendingAttachments: [URL] = []
    @Published var slashCommands: [SlashCommandItem] = SlashCommandItem.fallback
    @Published var skills: [GrokSkill] = []
    @Published var availableModels: [GrokModelOption] = []
    @Published var hiddenProjectPaths: Set<String>
    @Published var contextUsage: [UUID: ContextUsage] = [:]
    @Published var showRuntimeInstallPrompt = false
    @Published var showRuntimeInstaller = false
    @Published var isInstallingRuntime = false
    @Published var runtimeInstallSucceeded = false
    @Published var runtimeInstallLog = ""
    @Published var runtimeInstallError: String?
    @Published private(set) var needsLanguageOnboarding = false
    @Published private(set) var launchMode = AppLaunchMode.current
    @Published var demoWorkspaceRequest: DemoWorkspaceRequest?
    @Published var pendingRelayImport: RelayImportPayload?
    @Published var relayEndpoint = "https://api.xiaohaweb.com/v1"
    @Published var relayApiKey = ""
    @Published var relayModel = RelayImportPayload.defaultModel
    @Published var relayName = RelayImportPayload.defaultName
    @Published var relayImportMessage: String?
    @Published var relayImportError: String?

    private let cli = CLIProcessService()
    private let runtimeInstaller = GrokRuntimeInstaller()
    private var runtimes: [UUID: ACPBridge] = [:]
    private var headlessProcesses: [UUID: CLIProcessService] = [:]
    private var lastRoundRobinAccountID: UUID?
    private var cancelledConversationIDs: Set<UUID> = []
    private struct PendingACPUpdate {
        let method: String
        let params: [String: Any]
    }
    private var pendingACPUpdates: [UUID: [PendingACPUpdate]] = [:]
    private var acpFlushTasks: [UUID: Task<Void, Never>] = [:]
    private var pendingDemoConversationAccount: GrokAccount?

    private func localized(_ key: String) -> String {
        L10n.text(key, language: settings.effectiveLanguage)
    }

    private func localizedFormat(_ key: String, _ arguments: CVarArg...) -> String {
        String(format: localized(key), locale: settings.appLocale, arguments: arguments)
    }

    init() {
        let hadPersistedState = FileManager.default.fileExists(atPath: AppPaths.state.path)
        try? AppPaths.prepare()
        let state = StateStore.load()
        accounts = state.accounts; conversations = state.conversations
        selectedConversationID = state.selectedConversationID; settings = state.settings
        hiddenProjectPaths = state.hiddenProjectPaths ?? []
        let legacyContextWindow = 225_000
        let defaultContextWindow = 500_000
        if settings.contextWindowTokens == nil || settings.contextWindowTokens == legacyContextWindow {
            settings.contextWindowTokens = defaultContextWindow
        }
        if let completed = settings.hasCompletedLanguageOnboarding {
            needsLanguageOnboarding = !completed
        } else if hadPersistedState {
            // Existing installations already had an implicit language choice.
            // Do not interrupt them with onboarding after an app update.
            settings.hasCompletedLanguageOnboarding = true
        } else {
            settings.hasCompletedLanguageOnboarding = false
            needsLanguageOnboarding = true
        }
        // An unsent folder selection is not a completed conversation and must
        // not survive an app relaunch as an extra empty sidebar session.
        conversations.removeAll(where: \.isUnsentLocalDraft)
        compactPersistedTimelines()
        if !conversations.contains(where: { $0.id == selectedConversationID }) {
            selectedConversationID = nil
        }
        let defaultHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".grok", isDirectory: true)
        if FileManager.default.fileExists(atPath: defaultHome.appendingPathComponent("auth.json").path),
           !accounts.contains(where: { URL(fileURLWithPath: $0.homePath).standardizedFileURL == defaultHome.standardizedFileURL }) {
            accounts.insert(GrokAccount(id: UUID(), name: L10n.text("本机 Grok CLI", language: settings.effectiveLanguage), homePath: defaultHome.path,
                                        enabled: true, createdAt: .distantPast), at: 0)
        }
        for account in accounts { AccountEnvironment.prepare(home: URL(fileURLWithPath: account.homePath)) }
        syncLocalSessions()
        if conversations.isEmpty { createConversation() }
        if selectedConversationID == nil { selectedConversationID = conversations.first?.id }
        if let selectedConversationID { loadHistoryIfNeeded(selectedConversationID) }
        refreshLocalSkills()
        availableModels = [GrokModelOption(id: settings.model, name: settings.model)]
        persist()
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.needsLanguageOnboarding else { return }
            if self.checkRuntimeAvailability(offerInstall: true) {
                self.refreshAvailableModels()
            }
        }
    }

    var selectedConversationIndex: Int? { conversations.firstIndex { $0.id == selectedConversationID } }
    var selectedConversation: Conversation? { selectedConversationIndex.map { conversations[$0] } }
    var selectedTools: [ToolCallRecord] { selectedConversationID.flatMap { toolCalls[$0] } ?? [] }
    var selectedPlan: [PlanEntryRecord] { selectedConversationID.flatMap { plans[$0] } ?? [] }
    var selectedExtensionEvents: [(String, String)] { selectedConversationID.flatMap { extensionEvents[$0] } ?? [] }
    var selectedContextUsage: ContextUsage? { selectedConversationID.flatMap { contextUsage[$0] } }
    var selectedConversationIsRunning: Bool {
        guard let selectedConversationID else { return false }
        return isConversationRunning(selectedConversationID)
    }
    var isRunning: Bool { !runningConversationIDs.isEmpty }

    func isConversationRunning(_ id: UUID) -> Bool {
        runningConversationIDs.contains(id)
    }

    private func markConversationRunning(_ id: UUID) {
        runningConversationIDs.insert(id)
    }

    private func markConversationFinished(_ id: UUID) {
        runningConversationIDs.remove(id)
        headlessProcesses[id] = nil
    }

    func persist() {
        try? StateStore.save(PersistedState(accounts: accounts, conversations: conversations,
                                             selectedConversationID: selectedConversationID, settings: settings,
                                             hiddenProjectPaths: hiddenProjectPaths))
    }

    func switchLaunchModeAndRestart(_ mode: AppLaunchMode) {
        guard mode != launchMode else { return }
        persist()
        AppLaunchMode.save(mode)

        let applicationURL = Bundle.main.bundleURL
        guard applicationURL.pathExtension == "app" else {
            statusText = localized("运行模式已保存，请重新启动 GrokDesk")
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: applicationURL, configuration: configuration) { _, error in
            DispatchQueue.main.async {
                if let error {
                    self.statusText = self.localizedFormat("重新启动失败：%@", error.localizedDescription)
                } else {
                    NSApp.terminate(nil)
                }
            }
        }
    }

    /// Older GrokDesk versions copied high-frequency ACP protocol updates and
    /// embedded image/audio bytes into state.json. Compact them once on load so
    /// subsequent launches and chat switches operate on the useful timeline.
    private func compactPersistedTimelines() {
        for conversationIndex in conversations.indices {
            for messageIndex in conversations[conversationIndex].messages.indices {
                guard let events = conversations[conversationIndex].messages[messageIndex].events else { continue }
                conversations[conversationIndex].messages[messageIndex].events = TimelinePersistencePolicy.prepare(events)
            }
        }
    }

    func completeLanguageOnboarding(language: String) {
        guard ["zh-Hans", "zh-Hant", "en"].contains(language) else { return }
        settings.language = language
        settings.hasCompletedLanguageOnboarding = true
        needsLanguageOnboarding = false

        // These records may be created while the onboarding screen is still
        // visible. Normalize only untouched defaults; user-defined names and
        // imported session titles must never be translated or overwritten.
        for index in accounts.indices
        where accounts[index].createdAt == .distantPast
            && ["本机 Grok CLI", "Local Grok CLI"].contains(accounts[index].name) {
            accounts[index].name = L10n.text("本机 Grok CLI", language: settings.effectiveLanguage)
        }
        for index in conversations.indices
        where conversations[index].isUnsentLocalDraft
            && ["新对话", "New chat"].contains(conversations[index].title) {
            conversations[index].title = L10n.text("新对话", language: settings.effectiveLanguage)
        }
        statusText = L10n.text("就绪", language: settings.effectiveLanguage)
        persist()

        // Runtime installation is intentionally deferred until onboarding has
        // finished so two unrelated first-launch prompts never compete.
        if checkRuntimeAvailability(offerInstall: true) {
            refreshAvailableModels()
        }
    }

    @discardableResult
    func checkRuntimeAvailability(offerInstall: Bool) -> Bool {
        if let binary = GrokRuntimeInstaller.resolveBinary(configuredPath: settings.grokBinary) {
            if settings.grokBinary != binary {
                settings.grokBinary = binary
                persist()
            }
            return true
        }
        if offerInstall { showRuntimeInstallPrompt = true }
        return false
    }

    func handleOpenURL(_ url: URL) {
        guard let payload = RelayImportPayload.parse(url) else { return }
        applyRelayPayload(payload, confirm: true)
    }

    func applyRelayPayload(_ payload: RelayImportPayload, confirm: Bool) {
        relayEndpoint = payload.endpoint
        relayApiKey = payload.apiKey
        relayModel = payload.model
        relayName = payload.name
        sidebarSection = .settings
        settingsPage = "中转站"
        if confirm {
            pendingRelayImport = payload
        }
    }

    func importRelayConfig(_ payload: RelayImportPayload? = nil) {
        let source = payload ?? RelayImportPayload(
            endpoint: relayEndpoint,
            apiKey: relayApiKey,
            model: relayModel,
            name: relayName
        )
        relayImportError = nil
        relayImportMessage = nil
        do {
            let result = try RelayConfigWriter.write(source)
            var message = localized("已写入 Grok 配置") + "：\(result.configPath.path)"
            if let backup = result.backupPath {
                message += "\n" + localized("已备份原配置") + "：\(backup.path)"
            }
            relayImportMessage = message
            pendingRelayImport = nil
            statusText = localized("中转站配置已导入")
        } catch {
            relayImportError = error.localizedDescription
            statusText = localized("中转站配置导入失败")
        }
    }

    func installLatestRuntime() {
        guard !isInstallingRuntime else { return }
        showRuntimeInstallPrompt = false
        showRuntimeInstaller = true
        isInstallingRuntime = true
        runtimeInstallSucceeded = false
        runtimeInstallError = nil
        runtimeInstallLog = L10n.text("正在准备安装最新版 Grok Build…", language: settings.effectiveLanguage) + "\n"
        runtimeInstaller.installLatest(onLine: { [weak self] line in
            self?.runtimeInstallLog += line + "\n"
        }) { [weak self] result in
            guard let self else { return }
            self.isInstallingRuntime = false
            switch result {
            case .success(let binary):
                self.settings.grokBinary = binary
                self.runtimeInstallSucceeded = true
                self.runtimeInstallLog += L10n.format("安装完成：%@", language: self.settings.effectiveLanguage, binary) + "\n"
                self.statusText = L10n.text("Grok Build 已安装", language: self.settings.effectiveLanguage)
                self.persist()
                self.refreshAvailableModels()
            case .failure(let error):
                self.runtimeInstallError = error.localizedDescription
                self.runtimeInstallLog += L10n.text("安装失败：", language: self.settings.effectiveLanguage)
                    + error.localizedDescription + "\n"
                self.statusText = L10n.text("Grok Build 安装失败", language: self.settings.effectiveLanguage)
            }
        }
    }

    func syncLocalSessions() {
        // An isolated demo profile must not repopulate itself from the user's real
        // ~/.grok/sessions directory. The default production behavior is unchanged.
        guard AppLaunchMode.current == .normal,
              ProcessInfo.processInfo.environment["GROKDESK_SKIP_SESSION_IMPORT"] != "1" else { return }
        let summaries = LocalSessionIndex.summaries()
        let known = Set(conversations.compactMap(\.grokSessionID))
        conversations.append(contentsOf: summaries.filter { session in
            session.grokSessionID.map { !known.contains($0) } ?? false
        })
        for summary in summaries {
            guard let sessionID = summary.grokSessionID,
                  let index = conversations.firstIndex(where: { $0.grokSessionID == sessionID }) else { continue }
            conversations[index].updatedAt = max(conversations[index].updatedAt, summary.updatedAt)
            if conversations[index].title == "Grok Session" { conversations[index].title = summary.title }
        }
        conversations.sort { $0.updatedAt > $1.updatedAt }
        if let selectedConversationID { loadHistoryIfNeeded(selectedConversationID) }
        persist()
    }

    func loadHistoryIfNeeded(_ conversationID: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationID }),
              let sessionID = conversations[index].grokSessionID else { return }
        conversations[index].messages.removeAll {
            $0.role == .user && ($0.text.contains("<system-reminder>") || $0.text.contains("<user_info>"))
        }
        contextUsage[conversationID] = LocalSessionIndex.contextUsage(
            sessionID: sessionID, fallbackTotal: settings.effectiveContextWindowTokens
        )
        let external = LocalSessionIndex.messages(sessionID: sessionID)
        let merged = LocalSessionIndex.reconcile(local: conversations[index].messages, external: external)
        guard merged != conversations[index].messages else { return }
        conversations[index].messages = merged
        conversations[index].updatedAt = Date()
        persist()
    }

    /// User-created conversations always begin with an explicit workspace choice.
    /// Cancelling the panel intentionally leaves the current conversation untouched.
    func newConversation() { newConversation(account: nil) }

    /// Project-scoped creation bypasses the folder picker because the workspace is already explicit.
    func newConversation(in cwd: String) { createConversation(cwd: cwd) }

    private func newConversation(account: GrokAccount?) {
        if launchMode == .demo {
            pendingDemoConversationAccount = account
            demoWorkspaceRequest = .createConversation
            return
        }
        let panel = NSOpenPanel()
        panel.title = L10n.text("选择 Grok 工作文件夹", language: settings.effectiveLanguage)
        panel.message = L10n.text("Grok 将在这个文件夹中读取文件、修改代码并运行工具。", language: settings.effectiveLanguage)
        panel.prompt = L10n.text("选择文件夹", language: settings.effectiveLanguage)
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: selectedConversation?.cwd ?? settings.defaultWorkingDirectory)
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        createConversation(account: account, cwd: folder.path)
    }

    private func createConversation(account: GrokAccount? = nil, cwd: String? = nil) {
        // Keep at most one transient composer draft. Choosing New Chat again
        // abandons the previous unsent folder selection instead of creating a
        // stack of empty conversations in persisted state.
        conversations.removeAll(where: \.isUnsentLocalDraft)
        var conversation = Conversation(cwd: cwd ?? settings.defaultWorkingDirectory)
        conversation.title = L10n.text("新对话", language: settings.effectiveLanguage)
        conversation.accountID = account?.id
        hiddenProjectPaths.remove(conversation.cwd)
        conversations.insert(conversation, at: 0); selectedConversationID = conversation.id
        sidebarSection = .chat; persist()
    }

    func deleteConversation(_ id: UUID) {
        if let conversation = conversations.first(where: { $0.id == id }),
           let sessionID = conversation.grokSessionID {
            do { _ = try LocalSessionIndex.moveToTrash(sessionID: sessionID) }
            catch { statusText = "无法将 Session 移到废纸篓：\(error.localizedDescription)"; return }
        }
        runtimes.removeValue(forKey: id)?.stop()
        headlessProcesses.removeValue(forKey: id)?.cancel()
        runningConversationIDs.remove(id)
        conversations.removeAll { $0.id == id }
        toolCalls[id] = nil; plans[id] = nil; extensionEvents[id] = nil
        if selectedConversationID == id { selectedConversationID = conversations.first(where: { $0.archivedAt == nil })?.id }
        if conversations.isEmpty { createConversation() }; persist()
    }

    func archiveConversation(_ id: UUID) {
        runtimes.removeValue(forKey: id)?.stop()
        headlessProcesses.removeValue(forKey: id)?.cancel()
        runningConversationIDs.remove(id)
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].archivedAt = Date()
        if selectedConversationID == id { selectedConversationID = conversations.first(where: { $0.archivedAt == nil })?.id }
        persist()
    }

    func unarchiveConversation(_ id: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].archivedAt = nil
        hiddenProjectPaths.remove(conversations[index].cwd)
        persist()
    }

    /// Removes only GrokDesk's project presentation. The workspace and local
    /// Grok Session directories are intentionally left untouched.
    func hideProject(_ path: String) {
        hiddenProjectPaths.insert(path)
        if selectedConversation?.cwd == path {
            selectedConversationID = conversations.first {
                $0.archivedAt == nil && $0.cwd != path && !hiddenProjectPaths.contains($0.cwd)
            }?.id
        }
        persist()
    }

    /// A candidate account remains outside persisted state until OAuth has
    /// produced an auth file. Cancelling login must never create a dead card.
    func addAccount(name: String) {
        guard !isAddingAccount else { return }
        let id = UUID(), home = AppPaths.accounts.appendingPathComponent(id.uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        AccountEnvironment.prepare(home: home)
        let candidate = GrokAccount(id: id, name: name, homePath: home.path, enabled: true, createdAt: Date())
        isAddingAccount = true
        loginLog = localizedFormat("正在启动 %@ 的浏览器登录…", name) + "\n"
        statusText = "等待登录"
        cli.runLogin(binary: settings.grokBinary, account: candidate, onLine: { [weak self] in
            self?.loginLog += $0 + "\n"
        }) { [weak self] result in
            guard let self else { return }
            self.isAddingAccount = false
            guard case .success = result, candidate.isLoggedIn else {
                if case .failure(let error) = result {
                    self.loginLog += self.localizedFormat("登录失败：%@", error.localizedDescription) + "\n"
                } else {
                    self.loginLog += self.localized("登录未完成，账号未添加。") + "\n"
                }
                self.statusText = "登录未完成"
                // This directory belongs only to the uncommitted candidate.
                try? FileManager.default.removeItem(at: home)
                return
            }
            self.accounts.append(candidate)
            self.loginLog += self.localized("登录完成，账号已添加。") + "\n"
            self.statusText = "登录完成"
            self.persist()
            self.refreshAvailableModels(account: candidate)
            Task { await self.refreshQuotas() }
        }
    }

    func removeAccount(_ id: UUID) { accounts.removeAll { $0.id == id }; persist() }

    /// The account array is also the durable priority order used by sequential
    /// routing. Reordering never touches the isolated account home directories.
    func moveAccount(_ sourceID: UUID, onto targetID: UUID) {
        guard sourceID != targetID,
              let sourceIndex = accounts.firstIndex(where: { $0.id == sourceID }),
              let targetIndex = accounts.firstIndex(where: { $0.id == targetID }) else { return }
        let account = accounts.remove(at: sourceIndex)
        guard let remainingTargetIndex = accounts.firstIndex(where: { $0.id == targetID }) else { return }
        let insertionIndex = sourceIndex < targetIndex ? remainingTargetIndex + 1 : remainingTargetIndex
        accounts.insert(account, at: insertionIndex)
        persist()
    }

    func openAccount(_ account: GrokAccount) { workspaceMode = .modern; newConversation(account: account) }

    func showAccountSettings() {
        settingsPage = "账号与用量"
        sidebarSection = .settings
    }

    func setReasoningEffort(_ effort: String) {
        settings.reasoningEffort = effort
        persist()
        guard let conversationID = selectedConversationID,
              let runtime = runtimes[conversationID], !isConversationRunning(conversationID) else {
            statusText = "推理强度将在下次连接时生效"
            return
        }
        statusText = "正在切换推理强度"
        runtime.setModel(settings.model, reasoningEffort: effort) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.statusText = self.localizedFormat("推理强度已切换为 %@", effort)
            case .failure:
                // Older runtimes may not implement live model updates. Reconnect on
                // the next turn and resume the same Grok Session with the new meta.
                self.runtimes.removeValue(forKey: conversationID)?.stop()
                self.statusText = "推理强度将在下一条消息生效"
            }
        }
    }

    func setModel(_ model: String) {
        guard !model.isEmpty else { return }
        settings.model = model
        persist()
        guard let conversationID = selectedConversationID,
              let runtime = runtimes[conversationID], !isConversationRunning(conversationID) else {
            statusText = "模型将在下次连接时生效"
            return
        }
        statusText = "正在切换模型"
        runtime.setModel(model, reasoningEffort: settings.reasoningEffort) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success: self.statusText = self.localizedFormat("模型已切换为 %@", model)
            case .failure:
                self.runtimes.removeValue(forKey: conversationID)?.stop()
                self.statusText = "模型将在下一条消息生效"
            }
        }
    }

    func setContextWindowTokens(_ tokens: Int) {
        let value = max(tokens, 16_000)
        settings.contextWindowTokens = value
        for id in contextUsage.keys { contextUsage[id]?.totalTokens = value }
        reconnectAfterRuntimeSettingChange("Context window 将在下一次连接时应用")
    }

    func setAutoCompactThreshold(_ percent: Int) {
        settings.autoCompactThresholdPercent = min(max(percent, 50), 99)
        reconnectAfterRuntimeSettingChange("自动压缩阈值将在下一次连接时应用")
    }

    private func reconnectAfterRuntimeSettingChange(_ message: String) {
        persist()
        if isRunning {
            statusText = message
        } else {
            for runtime in runtimes.values { runtime.stop() }
            runtimes.removeAll()
            statusText = message
        }
    }

    func refreshAvailableModels(account: GrokAccount? = nil) {
        guard let account = account ?? routeAccount() else { return }
        cli.listModels(binary: settings.grokBinary, account: account) { [weak self] result in
            guard let self, case .success(let ids) = result, !ids.isEmpty else { return }
            self.availableModels = ids.map { GrokModelOption(id: $0, name: $0) }
            if !ids.contains(self.settings.model), let first = ids.first { self.settings.model = first; self.persist() }
        }
    }

    func login(_ account: GrokAccount) {
        loginLog = localizedFormat("正在启动 %@ 的浏览器登录…", account.name) + "\n"
        statusText = "等待登录"
        cli.runLogin(binary: settings.grokBinary, account: account, onLine: { [weak self] in self?.loginLog += $0 + "\n" }) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result {
                self.loginLog += self.localizedFormat("登录失败：%@", error.localizedDescription) + "\n"
                self.statusText = "登录失败"
            } else {
                self.loginLog += self.localized("登录完成。") + "\n"
                self.statusText = "登录完成"
                self.refreshAvailableModels(account: account)
                Task { await self.refreshQuotas() }
            }
        }
    }

    func refreshQuotas() async {
        isRefreshingQuota = true
        let candidates = accounts.filter { $0.enabled && $0.isLoggedIn }
        var failedCount = 0
        await withTaskGroup(of: (UUID, QuotaSnapshot).self) { group in
            for account in candidates { group.addTask { (account.id, await QuotaService.fetch(account: account)) } }
            for await (id, quota) in group {
                if quota.error != nil { failedCount += 1 }
                if let index = accounts.firstIndex(where: { $0.id == id }) { accounts[index].quota = quota }
            }
        }
        isRefreshingQuota = false
        statusText = failedCount == 0
            ? "额度已刷新"
            : localizedFormat("%d 个账号额度刷新失败", failedCount)
        persist()
    }

    func routeAccount(excluding excluded: Set<UUID> = []) -> GrokAccount? {
        let loggedIn = accounts.filter { $0.enabled && $0.isLoggedIn && !excluded.contains($0.id) }
        // A known exhausted account is skipped while another usable account is
        // available. Unknown quota remains eligible before the first refresh.
        let usable = loggedIn.filter {
            $0.quota?.error == nil && ($0.quota?.routingScore.map { $0 > 0 } ?? true)
        }
        let pool = usable.isEmpty ? loggedIn : usable
        if settings.accountRoutingMode == "fixed",
           let preferred = settings.preferredAccountID,
           let account = pool.first(where: { $0.id == preferred }) { return account }
        if settings.accountRoutingMode == "sequential" { return pool.first }
        if settings.accountRoutingMode == "roundRobin", !pool.isEmpty {
            guard let lastRoundRobinAccountID,
                  let index = pool.firstIndex(where: { $0.id == lastRoundRobinAccountID }) else { return pool[0] }
            return pool[(index + 1) % pool.count]
        }
        return pool.max {
            let lhs = $0.quota?.routingScore ?? -1, rhs = $1.quota?.routingScore ?? -1
            return lhs == rhs ? $0.createdAt > $1.createdAt : lhs < rhs
        }
    }

    private func accountForNextTurn() -> GrokAccount? {
        let account = routeAccount()
        if settings.accountRoutingMode == "roundRobin" { lastRoundRobinAccountID = account?.id }
        return account
    }

    func send(_ prompt: String) {
        guard let conversationID = selectedConversationID,
              conversations.contains(where: { $0.id == conversationID }),
              !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty else { return }

        if isConversationRunning(conversationID) {
            guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            interject(prompt, conversationID: conversationID)
            return
        }

        // Capture the target before crossing an async boundary. The user may
        // switch chats while quotas refresh; a late lookup of the selection
        // would otherwise deliver this prompt to the newly selected session.
        let attachments = pendingAttachments
        let requestedWorkspaceMode = workspaceMode
        pendingAttachments = []
        markConversationRunning(conversationID)
        Task {
            let quotaIsStale = accounts.filter(\.enabled).contains {
                guard let checked = $0.quota?.checkedAt else { return true }
                return Date().timeIntervalSince(checked) > 300
            }
            if quotaIsStale { await refreshQuotas() }
            // Cancellation may happen while quota refresh is suspended. Do
            // not resurrect a turn that the user already stopped.
            guard isConversationRunning(conversationID) else {
                cancelledConversationIDs.remove(conversationID)
                return
            }
            guard let index = conversations.firstIndex(where: { $0.id == conversationID }) else {
                markConversationFinished(conversationID)
                return
            }
            let preferred = conversations[index].messages.isEmpty
                ? conversations[index].accountID.flatMap { id in accounts.first { $0.id == id && $0.enabled && $0.isLoggedIn } }
                : nil
            let account = preferred ?? accountForNextTurn()
            guard let account else {
                markConversationFinished(conversationID)
                if selectedConversationID == conversationID, pendingAttachments.isEmpty {
                    pendingAttachments = attachments
                }
                statusText = "没有已登录且启用的账号"
                showAccountSettings()
                return
            }
            conversations[index].accountID = account.id
            if requestedWorkspaceMode == .modern {
                sendACP(prompt, attachments: attachments, account: account, index: index)
            } else {
                sendHeadless(prompt, account: account, index: index)
            }
        }
    }

    private func interject(_ prompt: String, conversationID: UUID) {
        guard let runtime = runtimes[conversationID],
              let index = conversations.firstIndex(where: { $0.id == conversationID }) else {
            statusText = "当前 Runtime 尚未准备好追加消息"
            return
        }
        // Keep the live assistant row after every mid-turn user interjection.
        // Otherwise subsequent thought/message chunks still target the same
        // streaming row but that row visually remains above the new prompt.
        let streaming: ChatMessage? = conversations[index].messages
            .lastIndex(where: { $0.role == .assistant && $0.isStreaming })
            .map { conversations[index].messages.remove(at: $0) }
        conversations[index].messages.append(ChatMessage(role: .user, text: prompt))
        if let streaming { conversations[index].messages.append(streaming) }
        conversations[index].updatedAt = Date()
        runtime.interject(prompt)
        statusText = "已追加到当前运行"
        persist()
    }

    private func prepareTurn(_ prompt: String, attachments: [URL] = [], index: Int) -> UUID {
        markConversationRunning(conversations[index].id)
        statusText = "正在连接 Grok Agent"
        let media = attachments.map { url -> MessageMedia in
            if NSImage(contentsOf: url) != nil {
                // Keep only the durable local URL in chat state; ACP performs
                // the one-time base64 upload without bloating state.json.
                return MessageMedia(type: "image", uri: url.absoluteString, name: url.lastPathComponent)
            }
            return MessageMedia(type: "resource_link", uri: url.absoluteString, name: url.lastPathComponent)
        }
        conversations[index].messages.append(ChatMessage(role: .user, text: prompt, media: media.isEmpty ? nil : media))
        conversations[index].messages.append(ChatMessage(role: .assistant, text: "", isStreaming: true))
        conversations[index].updatedAt = Date()
        if conversations[index].title == "新对话" || conversations[index].title == "New chat" {
            conversations[index].title = prompt.isEmpty
                ? (attachments.first?.lastPathComponent ?? localized("附件对话"))
                : String(prompt.prefix(28))
        }
        persist(); return conversations[index].id
    }

    /// Replays the most recent user turn without duplicating its bubble. Any
    /// partial assistant output and the terminal error card are replaced by a
    /// fresh assistant stream, matching the usual "regenerate" interaction.
    func regenerateLastResponse() {
        guard let index = selectedConversationIndex,
              !isConversationRunning(conversations[index].id),
              let userIndex = conversations[index].messages.lastIndex(where: { $0.role == .user }) else {
            statusText = selectedConversationIsRunning ? "请先等待当前运行结束" : "没有可重新生成的消息"
            return
        }
        let userMessage = conversations[index].messages[userIndex]
        let attachments = userMessage.media?.compactMap { media in
            media.uri.flatMap(URL.init(string:))
        } ?? []

        let preferred = conversations[index].accountID.flatMap { id in
            accounts.first { $0.id == id && $0.enabled && $0.isLoggedIn }
        }
        guard let account = preferred ?? accountForNextTurn() else {
            statusText = "没有已登录且启用的账号"
            showAccountSettings()
            return
        }
        conversations[index].messages.removeSubrange((userIndex + 1)..<conversations[index].messages.endIndex)
        conversations[index].accountID = account.id
        beginRegeneratedTurn(userMessage.text, attachments: attachments, account: account, index: index)
    }

    private func beginRegeneratedTurn(_ prompt: String, attachments: [URL], account: GrokAccount, index: Int) {
        let conversationID = conversations[index].id
        markConversationRunning(conversationID)
        statusText = "正在重新生成"
        conversations[index].messages.append(ChatMessage(role: .assistant, text: "", isStreaming: true))
        conversations[index].updatedAt = Date()
        persist()

        if workspaceMode == .modern {
            if let runtime = runtimes[conversationID], runtime.accountID == account.id {
                promptACP(prompt, attachments: attachments, runtime: runtime, conversationID: conversationID)
            } else {
                runtimes.removeValue(forKey: conversationID)?.stop()
                connectACP(prompt: prompt, attachments: attachments, conversationID: conversationID,
                           account: account, excluded: [])
            }
        } else {
            let snapshot = conversations[index]
            runHeadless(prompt, account: account, conversation: snapshot, conversationID: conversationID)
        }
    }

    private func sendACP(_ prompt: String, attachments: [URL], account: GrokAccount, index: Int) {
        let conversationID = prepareTurn(prompt, attachments: attachments, index: index)
        if let runtime = runtimes[conversationID], runtime.accountID == account.id {
            promptACP(prompt, attachments: attachments, runtime: runtime, conversationID: conversationID); return
        }
        // A session is shared local state; changing the quota-selected token only
        // requires reconnecting the ACP process and loading the same session ID.
        runtimes.removeValue(forKey: conversationID)?.stop()
        connectACP(prompt: prompt, attachments: attachments, conversationID: conversationID, account: account, excluded: [])
    }

    private func connectACP(prompt: String, attachments: [URL], conversationID: UUID,
                            account: GrokAccount, excluded: Set<UUID>) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationID }) else { return }
        let runtime = ACPBridge(binary: settings.grokBinary, account: account, settings: settings, cwd: conversations[index].cwd)
        configure(runtime, conversationID: conversationID); runtimes[conversationID] = runtime
        runtime.start(existingSessionID: conversations[index].grokSessionID) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.runtimes[conversationID] = nil
                guard let currentIndex = self.conversations.firstIndex(where: { $0.id == conversationID }) else { return }
                var rejected = excluded; rejected.insert(account.id)
                // Failover honors the visible routing policy. Sequential mode
                // therefore advances to the next card in the user's order.
                let alternate = self.routeAccount(excluding: rejected)
                if let alternate {
                    self.conversations[currentIndex].accountID = alternate.id
                    self.statusText = self.localizedFormat("%@ 连接失败，切换到 %@", account.name, alternate.name)
                    self.connectACP(prompt: prompt, attachments: attachments, conversationID: conversationID,
                                    account: alternate, excluded: rejected)
                } else { self.finish(conversationID, error: error) }
            case .success(let sessionID):
                if let i = self.conversations.firstIndex(where: { $0.id == conversationID }) { self.conversations[i].grokSessionID = sessionID }
                self.contextUsage[conversationID] = LocalSessionIndex.contextUsage(
                    sessionID: sessionID, fallbackTotal: self.settings.effectiveContextWindowTokens
                ) ?? ContextUsage(usedTokens: 0, totalTokens: self.settings.effectiveContextWindowTokens)
                self.refreshSlashCommands(runtime: runtime, cwd: self.conversations.first(where: { $0.id == conversationID })?.cwd)
                self.refreshSkills(runtime: runtime, cwd: self.conversations.first(where: { $0.id == conversationID })?.cwd)
                self.statusText = "Agent 已连接"; self.promptACP(prompt, attachments: attachments, runtime: runtime, conversationID: conversationID)
            }
        }
    }

    private func refreshSlashCommands(runtime: ACPBridge, cwd: String?) {
        var params: [String: Any] = [:]
        if let cwd { params["cwd"] = cwd }
        runtime.callExtension("x.ai/commands/list", params: params) { [weak self] result in
            guard let self, case .success(let value) = result,
                  let rows = value["commands"] as? [[String: Any]] else { return }
            let parsed = rows.compactMap { row -> SlashCommandItem? in
                guard let name = row["name"] as? String else { return nil }
                let input = row["input"] as? [String: Any]
                let hint = input?["hint"] as? String ?? input?["placeholder"] as? String
                let meta = row["_meta"] as? [String: Any] ?? row["meta"] as? [String: Any]
                let path = meta?["path"] as? String
                let scope = meta?["scope"] as? String
                return SlashCommandItem(name: name, description: row["description"] as? String ?? "",
                                        argumentHint: hint, isSkill: path != nil && scope != nil,
                                        skillPath: path, skillScope: scope)
            }
            if !parsed.isEmpty { self.slashCommands = self.mergingSkillCommands(parsed) }
        }
    }

    func refreshLocalSkills() {
        skills = SkillIndex.discover(cwd: selectedConversation?.cwd)
        slashCommands = mergingSkillCommands(slashCommands.filter { !$0.isSkill })
    }

    func refreshSkills() {
        guard let id = selectedConversationID, let runtime = runtimes[id] else {
            refreshLocalSkills(); statusText = "已刷新本地 Skills"
            return
        }
        refreshSkills(runtime: runtime, cwd: selectedConversation?.cwd)
    }

    private func refreshSkills(runtime: ACPBridge, cwd: String?) {
        runtime.callExtension("x.ai/skills/list", params: ["cwd": cwd ?? "."]) { [weak self] result in
            guard let self, case .success(let value) = result,
                  let rows = value["skills"] as? [[String: Any]] else { return }
            self.skills = rows.compactMap(self.parseSkill).sorted {
                $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
            }
            self.slashCommands = self.mergingSkillCommands(self.slashCommands.filter { !$0.isSkill })
        }
    }

    func toggleSkill(_ skill: GrokSkill, enabled: Bool) {
        guard let id = selectedConversationID, let runtime = runtimes[id] else {
            statusText = "请先在任意对话发送一条消息，再启停 Skill"
            return
        }
        runtime.callExtension("x.ai/skills/toggle", params: ["name": skill.name, "enabled": enabled,
                                                              "cwd": selectedConversation?.cwd ?? "."]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.statusText = self.localizedFormat("Skill 更新失败：%@", error.localizedDescription)
            case .success(let value):
                if let rows = value["skills"] as? [[String: Any]] {
                    self.skills = rows.compactMap(self.parseSkill).sorted {
                        $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
                    }
                } else if let index = self.skills.firstIndex(where: { $0.id == skill.id }) {
                    self.skills[index].enabled = enabled
                }
                self.refreshSlashCommands(runtime: runtime, cwd: self.selectedConversation?.cwd)
                self.statusText = enabled
                    ? self.localizedFormat("已启用 /%@", skill.name)
                    : self.localizedFormat("已停用 /%@", skill.name)
            }
        }
    }

    private func mergingSkillCommands(_ base: [SlashCommandItem]) -> [SlashCommandItem] {
        var rows = base
        let names = Set(rows.map(\.name))
        rows.append(contentsOf: skills.filter { $0.enabled && $0.userInvocable && !names.contains($0.name) }.map {
            SlashCommandItem(name: $0.name, description: $0.shortDescription ?? $0.description,
                             argumentHint: $0.argumentHint, isSkill: true,
                             skillPath: $0.path, skillScope: $0.scope)
        })
        return rows
    }

    private func parseSkill(_ row: [String: Any]) -> GrokSkill? {
        guard let name = row["name"] as? String, let path = row["path"] as? String else { return nil }
        let content = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        return GrokSkill(name: name, displayName: row["display_name"] as? String,
                         description: row["description"] as? String ?? "Grok Skill",
                         shortDescription: row["short_description"] as? String,
                         path: path, scope: row["scope"] as? String ?? "user",
                         enabled: row["enabled"] as? Bool ?? true,
                         userInvocable: row["user_invocable"] as? Bool ?? true,
                         whenToUse: row["when_to_use"] as? String,
                         argumentHint: row["argument_hint"] as? String,
                         author: row["author"] as? String,
                         compatibility: row["compatibility"] as? String, content: content)
    }

    private func configure(_ runtime: ACPBridge, conversationID: UUID) {
        runtime.onDiagnostic = { [weak self] line in
            guard let self, let message = self.userFacingDiagnostic(line) else { return }
            self.statusText = message
        }
        runtime.onModelState = { [weak self] in self?.updateModelState($0) }
        runtime.onUpdate = { [weak self] method, params in
            self?.enqueueACPUpdate(method: method, params: params, conversationID: conversationID)
        }
        runtime.onInteraction = { [weak self] method, requestID, params in
            guard let self else { return }
            // Interactions must appear after all preceding streamed activity,
            // even when the conversation is currently running in background.
            self.flushACPUpdates(for: conversationID)
            self.handleInteraction(method: method, requestID: requestID, params: params, conversationID: conversationID)
        }
    }

    private func enqueueACPUpdate(method: String, params: [String: Any], conversationID: UUID) {
        let incoming = PendingACPUpdate(method: method, params: params)
        if selectedConversationID != conversationID,
           var buffered = pendingACPUpdates[conversationID],
           let last = buffered.last,
           let merged = coalescingStreamChunk(last, with: incoming) {
            buffered[buffered.count - 1] = merged
            pendingACPUpdates[conversationID] = buffered
        } else {
            pendingACPUpdates[conversationID, default: []].append(incoming)
        }

        // A background transcript is not visible. Keep its ordered ACP updates
        // off the published conversation graph until the chat is selected or
        // the turn finishes; otherwise every token invalidates the whole window
        // and can interrupt text input in an unrelated session.
        guard selectedConversationID == conversationID else { return }
        guard acpFlushTasks[conversationID] == nil else { return }

        // Keep the visible transcript fluid, while preventing a background
        // stream from forcing a full AppModel/SwiftUI diff for every token.
        // Each session owns a separate FIFO queue, so tool/thought/text order
        // is preserved exactly within that session.
        let delay = 0.016
        let task = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.flushACPUpdates(for: conversationID)
        }
        acpFlushTasks[conversationID] = task
    }

    /// Combine adjacent background text/thought deltas without changing their
    /// position relative to tools, hooks, plans, or other runtime events.
    private func coalescingStreamChunk(_ older: PendingACPUpdate,
                                       with newer: PendingACPUpdate) -> PendingACPUpdate? {
        guard older.method == newer.method,
              let olderUpdate = sessionUpdate(from: older.params),
              var newerUpdate = sessionUpdate(from: newer.params),
              let olderType = olderUpdate["sessionUpdate"] as? String,
              olderType == newerUpdate["sessionUpdate"] as? String,
              olderType == "agent_message_chunk" || olderType == "agent_thought_chunk" else { return nil }

        let combined = contentText(olderUpdate) + contentText(newerUpdate)
        if var content = newerUpdate["content"] as? [String: Any] {
            guard (content["type"] as? String ?? "text") == "text" else { return nil }
            content["text"] = combined
            newerUpdate["content"] = content
        } else {
            newerUpdate["text"] = combined
        }
        var params = newer.params
        if params["update"] != nil { params["update"] = newerUpdate }
        else { params = newerUpdate }
        return PendingACPUpdate(method: newer.method, params: params)
    }

    private func sessionUpdate(from params: [String: Any]) -> [String: Any]? {
        (params["update"] as? [String: Any]) ?? (params["sessionUpdate"] != nil ? params : nil)
    }

    private func flushACPUpdates(for conversationID: UUID) {
        acpFlushTasks.removeValue(forKey: conversationID)?.cancel()
        guard let updates = pendingACPUpdates.removeValue(forKey: conversationID), !updates.isEmpty else { return }
        for update in updates {
            handleACP(method: update.method, params: update.params, conversationID: conversationID)
        }
    }

    private func userFacingDiagnostic(_ line: String) -> String? {
        let plain = line.replacingOccurrences(of: "\u{001B}\\[[0-9;]*[A-Za-z]", with: "",
                                              options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !plain.isEmpty else { return nil }
        // Grok's replay/config tracing belongs in logs, not in the chat header.
        // In particular this benign warning can occur after loading a persisted
        // session and does not represent a failed user turn.
        if plain.contains("Post-replay flush failed")
            || plain.contains("session not found")
            || plain.contains(" WARN ") { return nil }
        return plain
    }

    private func updateModelState(_ state: [String: Any]) {
        let rows = state["availableModels"] as? [[String: Any]]
            ?? state["available_models"] as? [[String: Any]] ?? []
        let parsed = rows.compactMap { value -> GrokModelOption? in
            guard let id = value["modelId"] as? String ?? value["model_id"] as? String else { return nil }
            return GrokModelOption(id: id, name: value["name"] as? String ?? id)
        }
        if !parsed.isEmpty { availableModels = parsed }
        if let current = state["currentModelId"] as? String ?? state["current_model_id"] as? String,
           !current.isEmpty { settings.model = current; persist() }
    }

    private func promptACP(_ prompt: String, attachments: [URL], runtime: ACPBridge, conversationID: UUID) {
        statusText = "Grok 正在处理"
        runtime.prompt(prompt, attachments: attachments) { [weak self] result in
            guard let self else { return }
            switch result { case .success: self.finish(conversationID); case .failure(let error): self.finish(conversationID, error: error) }
        }
    }

    private func handleACP(method: String, params: [String: Any], conversationID: UUID) {
        if method == "_x.ai/models/update" || method == "x.ai/models/update" {
            updateModelState(params)
            return
        }
        if let meta = params["_meta"] as? [String: Any],
           let tokens = integer(meta["totalTokens"]) {
            var usage = contextUsage[conversationID] ?? ContextUsage(
                usedTokens: 0, totalTokens: settings.effectiveContextWindowTokens
            )
            usage.usedTokens = tokens
            usage.totalTokens = settings.effectiveContextWindowTokens
            contextUsage[conversationID] = usage
        }
        let eventID = (params["_meta"] as? [String: Any])?["eventId"] as? String
        let update = (params["update"] as? [String: Any]) ?? (params["sessionUpdate"] != nil ? params : nil)
        guard let update else { recordExtension(method, params: params, eventID: eventID, conversationID: conversationID); return }
        let type = update["sessionUpdate"] as? String ?? "unknown"
        switch type {
        case "agent_message_chunk": handleAgentContent(update, conversationID: conversationID)
        case "agent_thought_chunk": append(text: contentText(update), thought: true, conversationID: conversationID)
        case "tool_call", "tool_call_update": upsertTool(update, conversationID: conversationID)
        case "plan": updatePlan(update, conversationID: conversationID)
        case "auto_compact_started":
            let percentage = integer(update["percentage"]) ?? Int((contextUsage[conversationID]?.fraction ?? 0) * 100)
            upsertTimelineEvent(.init(id: "active-compaction", kind: "compaction", title: "正在自动压缩上下文",
                                      status: "\(percentage)%", input: nil, output: nil), conversationID: conversationID)
        case "auto_compact_completed":
            let before = integer(update["tokens_before"] ?? update["tokensBefore"])
            let after = integer(update["tokens_after"] ?? update["tokensAfter"]) ?? 0
            var usage = contextUsage[conversationID] ?? ContextUsage(usedTokens: after, totalTokens: settings.effectiveContextWindowTokens)
            usage.usedTokens = after; usage.compactionCount += 1; contextUsage[conversationID] = usage
            upsertTimelineEvent(.init(id: "active-compaction", kind: "compaction", title: "上下文已自动压缩",
                                      status: "completed", input: before.map { "压缩前：\(formatTokens($0))" },
                                      output: "压缩后：\(formatTokens(after))"), conversationID: conversationID)
        case "auto_compact_failed":
            upsertTimelineEvent(.init(id: "active-compaction", kind: "compaction", title: "自动压缩失败",
                                      status: "failed", input: nil, output: update["error"] as? String), conversationID: conversationID)
        case "session_summary_generated":
            if let title = update["sessionSummary"] as? String ?? update["session_summary"] as? String,
               let i = conversations.firstIndex(where: { $0.id == conversationID }) { conversations[i].title = title }
        default: recordExtension(type, params: update, eventID: eventID, conversationID: conversationID)
        }
    }

    private func contentText(_ update: [String: Any]) -> String {
        if let content = update["content"] as? [String: Any] { return content["text"] as? String ?? "" }
        return update["text"] as? String ?? ""
    }

    private func handleAgentContent(_ update: [String: Any], conversationID: UUID) {
        guard let content = update["content"] as? [String: Any] else {
            append(text: contentText(update), thought: false, conversationID: conversationID); return
        }
        let type = content["type"] as? String ?? "text"
        if type == "text" { append(text: content["text"] as? String ?? "", thought: false, conversationID: conversationID); return }
        guard let c = conversations.firstIndex(where: { $0.id == conversationID }),
              let m = conversations[c].messages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) else { return }
        let media = MessageMedia(type: type, mimeType: content["mimeType"] as? String, data: content["data"] as? String,
                                 uri: content["uri"] as? String, name: content["name"] as? String)
        conversations[c].messages[m].media = (conversations[c].messages[m].media ?? []) + [media]
    }

    private func upsertTool(_ value: [String: Any], conversationID: UUID) {
        let id = value["toolCallId"] as? String ?? value["tool_call_id"] as? String ?? UUID().uuidString
        let metadata = value["_meta"] as? [String: Any]
        let toolMetadata = metadata?["x.ai/tool"] as? [String: Any]
        let incomingKind = value["kind"] as? String ?? toolMetadata?["kind"] as? String ?? toolMetadata?["name"] as? String
        let incomingTitle = value["title"] as? String ?? toolMetadata?["label"] as? String
            ?? toolMetadata?["name"] as? String ?? value["name"] as? String
        var rows = toolCalls[conversationID] ?? []
        let input = jsonText(value["rawInput"] ?? value["input"]), output = jsonText(value["content"] ?? value["output"])
        if let i = rows.firstIndex(where: { $0.id == id }) {
            rows[i].title = incomingTitle ?? rows[i].title
            rows[i].kind = incomingKind ?? rows[i].kind
            rows[i].status = value["status"] as? String ?? rows[i].status
            rows[i].input = input ?? rows[i].input; rows[i].output = output ?? rows[i].output
        } else {
            rows.append(ToolCallRecord(id: id, title: incomingTitle ?? "工具调用",
                                       kind: incomingKind ?? "other", status: value["status"] as? String ?? "pending",
                                       input: input, output: output))
        }
        toolCalls[conversationID] = rows
        if let row = rows.first(where: { $0.id == id }) {
            upsertTimelineEvent(.init(id: "tool-\(id)", kind: row.kind, title: row.title, status: row.status,
                                      input: row.input, output: row.output), conversationID: conversationID)
        }
    }

    private func updatePlan(_ value: [String: Any], conversationID: UUID) {
        let entries = value["entries"] as? [[String: Any]] ?? []
        plans[conversationID] = entries.map { PlanEntryRecord(text: $0["content"] as? String ?? $0["text"] as? String ?? "",
                                                               status: $0["status"] as? String ?? "pending",
                                                               priority: $0["priority"] as? String ?? "medium") }
        let detail = plans[conversationID]?.map { "[\($0.status)] \($0.text)" }.joined(separator: "\n")
        upsertTimelineEvent(.init(id: "plan", kind: "plan", title: "执行计划", status: nil,
                                  input: nil, output: detail), conversationID: conversationID)
    }

    private func upsertTimelineEvent(_ event: ChatTimelineEvent, conversationID: UUID) {
        guard let c = conversations.firstIndex(where: { $0.id == conversationID }),
              let m = conversations[c].messages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) else { return }
        guard let event = TimelinePersistencePolicy.prepare([event]).first else { return }
        var events = conversations[c].messages[m].events ?? []
        if let index = events.firstIndex(where: { $0.id == event.id }) { events[index] = event }
        else { events.append(event) }
        conversations[c].messages[m].events = events
    }

    private func integer(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let string = value as? String { return Int(string) }
        return nil
    }

    private func formatTokens(_ value: Int) -> String {
        value >= 1_000 ? String(format: "%.1fk tokens", Double(value) / 1_000) : "\(value) tokens"
    }

    private func handleInteraction(method: String, requestID: String, params: [String: Any], conversationID: UUID) {
        if method == "x.ai/ask_user_question" {
            upsertTimelineEvent(.init(id: "interaction-\(requestID)", kind: "question", title: "Grok 请求补充信息",
                                      status: "pending", input: jsonText(params), output: nil), conversationID: conversationID)
            let questions = (params["questions"] as? [[String: Any]] ?? []).map { value in
                AgentQuestion(question: value["question"] as? String ?? "",
                              options: (value["options"] as? [[String: Any]] ?? []).map {
                                  AgentQuestionOption(label: $0["label"] as? String ?? "",
                                                      description: $0["description"] as? String ?? "",
                                                      preview: $0["preview"] as? String)
                              }, multiSelect: value["multiSelect"] as? Bool ?? false)
            }
            pendingQuestion = PendingQuestionRequest(id: requestID, conversationID: conversationID,
                                                     questions: questions, planMode: (params["mode"] as? String) == "plan")
            return
        }
        if method == "x.ai/exit_plan_mode" {
            upsertTimelineEvent(.init(id: "interaction-\(requestID)", kind: "interaction", title: "Grok 请求确认计划",
                                      status: "pending", input: jsonText(params), output: nil), conversationID: conversationID)
            pendingPlanApproval = PendingPlanApproval(id: requestID, conversationID: conversationID,
                                                      content: params["planContent"] as? String ?? "计划已准备完成。")
            return
        }
        let tool = params["toolCall"] as? [String: Any]
        let options = (params["options"] as? [[String: Any]] ?? []).map {
            PermissionOptionRecord(id: $0["optionId"] as? String ?? $0["id"] as? String ?? "",
                                   name: $0["name"] as? String ?? "选择", kind: $0["kind"] as? String ?? "")
        }
        upsertTimelineEvent(.init(id: "interaction-\(requestID)", kind: "permission",
                                  title: tool?["title"] as? String ?? "Grok 请求执行操作", status: "pending",
                                  input: jsonText(params), output: nil), conversationID: conversationID)
        if settings.permissionMode == "bypassPermissions",
           let allow = preferredBypassPermissionOption(in: options),
           let runtime = runtimes[conversationID] {
            // Permission mode can be changed after an ACP session has started. Grok Build only
            // receives yoloMode during session/new or session/load, so handle later permission
            // requests here as well; otherwise the UI says Full access but still opens a sheet.
            upsertTimelineEvent(.init(id: "interaction-\(requestID)", kind: "permission",
                                      title: tool?["title"] as? String ?? "Grok 请求执行操作", status: "approved",
                                      input: jsonText(params), output: "完全访问模式：自动允许"), conversationID: conversationID)
            runtime.answerPermission(requestID: requestID, optionID: allow.id)
            return
        }
        if settings.permissionMode == "acceptEdits",
           (tool?["kind"] as? String ?? "").lowercased().contains("edit"),
           let allow = options.first(where: { $0.kind.lowercased().contains("allow_once") || $0.kind.lowercased().contains("allowonce") }),
           let runtime = runtimes[conversationID] {
            upsertTimelineEvent(.init(id: "interaction-\(requestID)", kind: "permission",
                                      title: tool?["title"] as? String ?? "Grok 请求执行操作", status: "approved",
                                      input: jsonText(params), output: "接受编辑模式：自动允许一次"), conversationID: conversationID)
            runtime.answerPermission(requestID: requestID, optionID: allow.id); return
        }
        pendingPermission = PendingPermission(id: requestID, conversationID: conversationID,
                                              title: tool?["title"] as? String ?? "Grok 请求执行操作", options: options)
    }

    private func preferredBypassPermissionOption(in options: [PermissionOptionRecord]) -> PermissionOptionRecord? {
        func searchableText(_ option: PermissionOptionRecord) -> String {
            "\(option.id) \(option.kind) \(option.name)"
                .lowercased()
                .replacingOccurrences(of: "-", with: "_")
                .replacingOccurrences(of: " ", with: "_")
        }

        // Prefer a session-scoped grant. A persistent all-session grant would outlive the
        // user's current Full access selection and silently broaden future sessions.
        let priorities = [
            "allow_all_edits_during_this_session", "allow_for_session", "allow_session",
            "allow_command_always", "allow_once", "allowonce", "yes"
        ]
        for priority in priorities {
            if let option = options.first(where: { searchableText($0).contains(priority) }) {
                return option
            }
        }
        return options.first(where: {
            let text = searchableText($0)
            return text.contains("allow") && !text.contains("reject") && !text.contains("deny")
        })
    }

    func answerPermission(_ optionID: String?) {
        guard let pendingPermission, let runtime = runtimes[pendingPermission.conversationID] else { return }
        upsertTimelineEvent(.init(id: "interaction-\(pendingPermission.id)", kind: "permission", title: pendingPermission.title,
                                  status: optionID == nil ? "cancelled" : "approved", input: nil,
                                  output: optionID == nil ? "用户取消" : "用户已选择权限选项"), conversationID: pendingPermission.conversationID)
        runtime.answerPermission(requestID: pendingPermission.id, optionID: optionID); self.pendingPermission = nil
    }

    func answerQuestions(_ answers: [String: [String]], notes: [String: String], action: String = "accepted") {
        guard let request = pendingQuestion, let runtime = runtimes[request.conversationID] else { return }
        var result: [String: Any] = ["outcome": action]
        if action == "accepted" {
            result["answers"] = answers
            let annotations = notes.reduce(into: [String: Any]()) { partial, item in partial[item.key] = ["notes": item.value] }
            if !annotations.isEmpty { result["annotations"] = annotations }
        } else { result["partial_answers"] = answers.mapValues { $0.joined(separator: ", ") } }
        upsertTimelineEvent(.init(id: "interaction-\(request.id)", kind: "question", title: "Grok 请求补充信息",
                                  status: action, input: nil, output: jsonText(result)), conversationID: request.conversationID)
        runtime.answerInteraction(requestID: request.id, result: result); pendingQuestion = nil
    }

    func answerPlan(approved: Bool, feedback: String? = nil) {
        guard let request = pendingPlanApproval, let runtime = runtimes[request.conversationID] else { return }
        var result: [String: Any] = ["outcome": approved ? "approved" : "cancelled"]
        if let feedback, !feedback.isEmpty { result["feedback"] = feedback }
        upsertTimelineEvent(.init(id: "interaction-\(request.id)", kind: "interaction", title: "Grok 请求确认计划",
                                  status: approved ? "approved" : "cancelled", input: nil, output: jsonText(result)),
                            conversationID: request.conversationID)
        runtime.answerInteraction(requestID: request.id, result: result); pendingPlanApproval = nil
    }

    func callCapability(method: String, paramsText: String, asNotification: Bool = false) {
        guard let id = selectedConversationID, let runtime = runtimes[id] else {
            rawCapabilityResult = localized("请先在当前对话发送一条消息，建立 ACP Session。"); return
        }
        var params: [String: Any] = [:]
        if !paramsText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard let data = paramsText.data(using: .utf8),
                  let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                rawCapabilityResult = localized("参数必须是 JSON 对象。"); return
            }
            params = decoded
        }
        if asNotification {
            runtime.sendExtensionNotification(method, params: params)
            rawCapabilityResult = localized("通知已发送（JSON-RPC notification 无返回值）。")
            return
        }
        rawCapabilityResult = localized("请求中…")
        runtime.callExtension(method, params: params) { [weak self] result in
            switch result {
            case .failure(let error): self?.rawCapabilityResult = error.localizedDescription
            case .success(let value): self?.rawCapabilityResult = self?.jsonText(value) ?? "{}"
            }
        }
    }

    private func recordExtension(_ method: String, params: [String: Any], eventID: String? = nil, conversationID: UUID) {
        var rows = extensionEvents[conversationID] ?? []
        rows.append((method, jsonText(params) ?? "{}")); if rows.count > 200 { rows.removeFirst(rows.count - 200) }
        extensionEvents[conversationID] = rows

        // User text is already represented by the user bubble. Every other ACP
        // extension is retained inline, including unknown future event types, so
        // the UI cannot silently discard a new Grok capability it does not know yet.
        guard method != "user_message_chunk", method != "user_message" else { return }
        guard !TimelinePersistencePolicy.isRedundantExtension(method) else { return }
        let kind = extensionKind(method)
        // Low-level session/model/queue lifecycle notifications remain in the
        // Run Details inspector but do not belong in the user-facing process
        // timeline. This also keeps future unknown runtime churn from creating
        // a row between every meaningful action.
        guard kind != "system" else { return }
        upsertTimelineEvent(.init(id: "extension-\(eventID ?? UUID().uuidString)", kind: kind,
                                  title: extensionTitle(method, params: params), status: extensionStatus(params),
                                  input: nil, output: jsonText(params)), conversationID: conversationID)
    }

    private func extensionKind(_ method: String) -> String {
        let value = method.lowercased()
        if value.contains("hook") { return "hook" }
        if value.contains("skill") || value.contains("plugin") { return "skill" }
        if value.contains("memory") || value.contains("compact") { return "context" }
        if value.contains("retry") || value.contains("session") || value.contains("turn_") { return "system" }
        if value.contains("task") { return "background_task" }
        return "extension"
    }

    private func extensionTitle(_ method: String, params: [String: Any]) -> String {
        if method.lowercased().contains("hook") {
            let event = params["event_name"] as? String ?? params["eventName"] as? String ?? "hook"
            let tool = params["tool_name"] as? String ?? params["toolName"] as? String
            return "Hook · \(event)" + (tool.map { " · \($0)" } ?? "")
        }
        switch method {
        case "task_backgrounded": return "任务已转入后台"
        case "task_completed": return "后台任务完成"
        case "retry_state": return "Runtime 正在重试"
        case "memory_flush_started": return "正在写入 Memory"
        case "memory_flush_completed": return "Memory 写入完成"
        case "turn_completed": return "本轮执行完成"
        case "session_recap": return "Session 回顾"
        default: return method.replacingOccurrences(of: "_", with: " ")
        }
    }

    private func extensionStatus(_ params: [String: Any]) -> String? {
        if let status = params["status"] as? String { return status }
        if let runs = params["runs"] as? [[String: Any]] {
            let statuses = runs.compactMap { ($0["status"] as? [String: Any])?["status"] as? String }
            if statuses.contains(where: { $0 == "failed" || $0 == "error" }) { return "failed" }
            if !statuses.isEmpty && statuses.allSatisfy({ $0 == "completed" || $0 == "success" }) { return "completed" }
        }
        return nil
    }

    private func jsonText(_ value: Any?) -> String? {
        guard let value else { return nil }
        if let string = value as? String { return string }
        let compacted = TimelinePersistencePolicy.compactJSONObject(value)
        guard JSONSerialization.isValidJSONObject(compacted),
              let data = try? JSONSerialization.data(withJSONObject: compacted, options: [.prettyPrinted])
        else { return String(describing: value) }
        return String(data: data, encoding: .utf8)
    }

    private func finish(_ conversationID: UUID, error: Error? = nil) {
        // The prompt completion response may arrive before the scheduled UI
        // batch. Drain the FIFO first or the final chunks would target an
        // assistant row that has already stopped streaming and be discarded.
        flushACPUpdates(for: conversationID)
        if cancelledConversationIDs.remove(conversationID) != nil {
            markConversationFinished(conversationID)
            statusText = "已停止"
            persist()
            return
        }
        markConversationFinished(conversationID)
        guard let c = conversations.firstIndex(where: { $0.id == conversationID }) else { return }
        if let m = conversations[c].messages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) {
            conversations[c].messages[m].isStreaming = false
            if conversations[c].messages[m].text.isEmpty,
               conversations[c].messages[m].thought?.isEmpty != false,
               conversations[c].messages[m].media?.isEmpty != false {
                conversations[c].messages.remove(at: m)
            }
        }
        if let error {
            let detail = error.localizedDescription == "Internal error"
                ? localized("Grok Build 返回内部错误（Internal error）")
                : error.localizedDescription
            conversations[c].messages.append(ChatMessage(
                role: .system,
                text: localizedFormat("运行失败：%@", detail)
            ))
            statusText = "运行失败"
        }
        else { statusText = "完成" }
        persist(); Task { await refreshQuotas() }
    }

    private func append(text: String, thought: Bool, conversationID: UUID) {
        guard let c = conversations.firstIndex(where: { $0.id == conversationID }),
              let m = conversations[c].messages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) else { return }
        if thought {
            let value = (conversations[c].messages[m].thought ?? "") + text
            conversations[c].messages[m].thought = value
            upsertTimelineEvent(.init(id: "thought", kind: "thought", title: "思考过程", status: nil,
                                      input: nil, output: value), conversationID: conversationID)
        }
        else { conversations[c].messages[m].text += text }
    }

    private func sendHeadless(_ prompt: String, account: GrokAccount, index: Int) {
        let id = prepareTurn(prompt, index: index), snapshot = conversations[index]
        runHeadless(prompt, account: account, conversation: snapshot, conversationID: id)
    }

    private func runHeadless(_ prompt: String, account: GrokAccount,
                             conversation: Conversation, conversationID: UUID) {
        let service = CLIProcessService()
        headlessProcesses[conversationID] = service
        service.runChat(binary: settings.grokBinary, account: account, conversation: conversation,
                        prompt: prompt, settings: settings,
                        onText: { [weak self] in self?.append(text: $0, thought: false, conversationID: conversationID) },
                        onThought: { [weak self] in self?.append(text: $0, thought: true, conversationID: conversationID) },
                        onDiagnostic: { [weak self] diagnostic in
                            guard let self, self.selectedConversationID == conversationID else { return }
                            self.statusText = diagnostic
                        }) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result { self.finish(conversationID, error: error) }
            else { self.finish(conversationID) }
        }
    }

    func cancel() {
        guard let id = selectedConversationID, isConversationRunning(id) else { return }
        flushACPUpdates(for: id)
        cancelledConversationIDs.insert(id)
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            if let streaming = conversations[index].messages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) {
                conversations[index].messages[streaming].isStreaming = false
                if conversations[index].messages[streaming].text.isEmpty,
                   conversations[index].messages[streaming].thought?.isEmpty != false,
                   conversations[index].messages[streaming].media?.isEmpty != false {
                    conversations[index].messages.remove(at: streaming)
                }
            }
            conversations[index].messages.append(ChatMessage(role: .status, text: "已停止"))
            conversations[index].updatedAt = Date()
        }
        let runtime = runtimes[id]
        let headlessProcess = headlessProcesses[id]
        markConversationFinished(id)
        statusText = "已停止"
        if let runtime { runtime.cancel() }
        else { headlessProcess?.cancel() }
        persist()
    }

    func chooseWorkingDirectory() {
        if launchMode == .demo {
            demoWorkspaceRequest = .updateConversation
            return
        }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
        if panel.runModal() == .OK, let path = panel.url?.path, let i = selectedConversationIndex {
            if runtimes[conversations[i].id] != nil { statusText = "工作目录将在新对话生效" }
            else { conversations[i].cwd = path; persist() }
        }
    }

    func selectDemoWorkspace(_ choice: DemoWorkspaceChoice, for request: DemoWorkspaceRequest) {
        guard launchMode == .demo else { return }
        DemoWorkspaceCatalog.prepare(choice)
        switch request {
        case .createConversation:
            createConversation(account: pendingDemoConversationAccount, cwd: choice.path)
        case .updateConversation:
            guard let index = selectedConversationIndex else { return }
            if runtimes[conversations[index].id] != nil {
                statusText = localized("工作目录将在新对话生效")
            } else {
                conversations[index].cwd = choice.path
                hiddenProjectPaths.remove(choice.path)
                persist()
            }
        }
        pendingDemoConversationAccount = nil
        demoWorkspaceRequest = nil
    }

    func cancelDemoWorkspaceSelection() {
        pendingDemoConversationAccount = nil
        demoWorkspaceRequest = nil
    }

    func chooseAttachments() {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = true; panel.canChooseFiles = true; panel.canChooseDirectories = false
        if panel.runModal() == .OK { addAttachments(panel.urls) }
    }

    func addAttachments(_ urls: [URL]) {
        pendingAttachments.append(contentsOf: urls.filter { !pendingAttachments.contains($0) })
    }
}
