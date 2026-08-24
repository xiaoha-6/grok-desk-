import AppKit
import Foundation
import SwiftUI

private extension Color {
    /// A restrained, opaque sidebar surface close to Codex's neutral gray.
    /// Using underPageBackgroundColor here is substantially too dark on macOS.
    static let grokSidebarSurface = Color(nsColor: NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return isDark
            ? NSColor(calibratedWhite: 0.115, alpha: 1)
            : NSColor(calibratedRed: 0.952, green: 0.956, blue: 0.960, alpha: 1)
    })
}

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showInspector = false
    @State private var showSidebar = true
    @State private var sidebarWidth: CGFloat = 280
    @State private var showAccountMenu = false
    @State private var showUsageCard = false

    var body: some View {
        Group {
            if model.sidebarSection == .settings {
                // Settings owns the entire window. Nesting it in the chat detail
                // would create two sidebars and make the inner one look floating.
                SettingsView(sidebarWidth: $sidebarWidth)
            } else {
                HStack(spacing: 0) {
                    if showSidebar {
                        AppSidebar(showingAccountMenu: $showAccountMenu, showUsageCard: $showUsageCard) {
                            withAnimation(.easeInOut(duration: 0.18)) { showSidebar = false }
                        }
                        .frame(width: sidebarWidth)
                        SidebarResizeDivider(width: $sidebarWidth)
                    }
                    VStack(spacing: 0) {
                        Group {
                            if model.selectedConversation != nil {
                                ChatView(showInspector: $showInspector, showSidebar: $showSidebar)
                            } else {
                                ContentUnavailableView("选择一个对话", systemImage: "bubble.left.and.bubble.right")
                            }
                        }
                        .inspector(isPresented: $showInspector) {
                            RuntimeInspector()
                                .inspectorColumnWidth(min: 300, ideal: 340, max: 460)
                        }
                    }
                    .simultaneousGesture(TapGesture().onEnded { showAccountMenu = false })
                }
                .ignoresSafeArea(.container, edges: .top)
            }
        }
        .overlay {
            if showUsageCard {
                ZStack {
                    Color.black.opacity(0.16).ignoresSafeArea().onTapGesture { showUsageCard = false }
                    UsageCard { showUsageCard = false }
                        .onTapGesture { }
                }
            }
        }
        .onChange(of: model.settings) { _, _ in model.persist() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            // Native Grok CLI may continue a shared session while GrokDesk is
            // in the background. Reconcile its new turns when the app returns.
            model.syncLocalSessions()
        }
        .sheet(item: $model.pendingPermission) { PermissionSheet(permission: $0) }
        .sheet(item: $model.pendingQuestion) { QuestionSheet(request: $0) }
        .sheet(item: $model.pendingPlanApproval) { PlanApprovalSheet(request: $0) }
        .sheet(item: $model.demoWorkspaceRequest) { request in
            DemoWorkspacePickerView(request: request)
        }
        .sheet(item: $model.pendingRelayImport) { payload in
            RelayImportConfirmSheet(payload: payload)
        }
        .alert("需要安装 Grok Build", isPresented: $model.showRuntimeInstallPrompt) {
            Button("稍后", role: .cancel) { }
            Button("安装最新版") { model.installLatestRuntime() }
        } message: {
            Text("GrokDesk 需要本地 Grok Build Runtime 才能运行 Agent。是否使用 xAI 官方安装器安装最新版？")
        }
        .sheet(isPresented: $model.showRuntimeInstaller) { RuntimeInstallerSheet() }
        .font(GrokTypography.body)
        .environment(\.locale, model.settings.appLocale)
        .preferredColorScheme(model.settings.preferredColorScheme)
    }
}

private struct RuntimeInstallerSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    private static let icon: NSImage? = {
        guard let url = Bundle.main.url(forResource: "AppIcon", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                if let icon = Self.icon {
                    Image(nsImage: icon).resizable().interpolation(.high).frame(width: 42, height: 42)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text("安装 Grok Build").font(.title2.weight(.semibold))
                    Text("使用 xAI 官方安装器获取最新版 Runtime").foregroundStyle(.secondary)
                }
            }

            if model.isInstallingRuntime {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("正在安装，请稍候…")
                }
            } else if model.runtimeInstallSucceeded {
                Label("Grok Build 已安装", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            } else if let error = model.runtimeInstallError {
                Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
            }

            ScrollView {
                Text(model.runtimeInstallLog)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(12)
            }
            .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))

            HStack {
                Link("查看 GitHub 源码", destination: GrokRuntimeInstaller.sourceRepository)
                Spacer()
                if model.runtimeInstallError != nil, !model.isInstallingRuntime {
                    Button("重试") { model.installLatestRuntime() }
                }
                Button("完成") { dismiss() }.disabled(model.isInstallingRuntime)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 600, height: 430)
    }
}

private enum WorkspacePresentation {
    static func displayName(for path: String, language: String) -> String {
        if AppLaunchMode.current == .demo,
           let mockName = DemoWorkspaceCatalog.displayName(for: path) {
            return L10n.text(mockName, language: language)
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
            .standardizedFileURL.resolvingSymlinksInPath()
        let home = FileManager.default.homeDirectoryForCurrentUser
            .standardizedFileURL.resolvingSymlinksInPath()

        // A home directory's final path component is commonly the macOS account
        // name. It is runtime context, not project content, so never surface it.
        if url == home {
            return L10n.text("主目录", language: language)
        }
        let name = url.lastPathComponent
        return name.isEmpty ? L10n.text("已选择工作目录", language: language) : name
    }
}

private struct DemoWorkspacePickerView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let request: DemoWorkspaceRequest

    private func text(_ key: String) -> String {
        L10n.text(key, language: model.settings.effectiveLanguage)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 26, weight: .medium))
                    .frame(width: 44, height: 44)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 4) {
                    Text(text("选择演示项目")).font(.title2.weight(.semibold))
                    Text(text("演示模式仅显示安全的示例项目，不会访问或展示你的本地路径。"))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            VStack(spacing: 10) {
                ForEach(DemoWorkspaceCatalog.choices) { choice in
                    Button {
                        model.selectDemoWorkspace(choice, for: request)
                        dismiss()
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "folder.fill")
                                .foregroundStyle(Color.accentColor)
                                .font(.title3)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(text(choice.nameKey))
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Text(text(choice.subtitleKey))
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.tertiary)
                        }
                        .padding(16)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 14))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(Color.primary.opacity(0.08), lineWidth: 1)
                    }
                }
            }

            HStack {
                Label(text("已隐藏用户名与绝对路径"), systemImage: "eye.slash")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(text("取消")) {
                    model.cancelDemoWorkspaceSelection()
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
            }
        }
        .padding(24)
        .frame(width: 620)
        .interactiveDismissDisabled()
    }
}

private struct ConversationProject: Identifiable {
    let path: String
    let conversations: [Conversation]
    var id: String { path }
    func displayName(language: String) -> String {
        WorkspacePresentation.displayName(for: path, language: language)
    }
}

private struct SidebarResizeDivider: View {
    @Binding var width: CGFloat
    @State private var dragStart: CGFloat?

    var body: some View {
        ZStack {
            Rectangle().fill(Color.clear)
            Rectangle().fill(Color.primary.opacity(0.10)).frame(width: 1)
        }
        .frame(width: 7).contentShape(Rectangle())
        .onHover { hovering in
            if hovering { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
        }
        .gesture(DragGesture(minimumDistance: 0)
            .onChanged { value in
                if dragStart == nil { dragStart = width }
                width = min(max((dragStart ?? width) + value.translation.width, 220), 400)
            }
            .onEnded { _ in dragStart = nil })
    }
}

private struct GrokDeskBrandMark: View {
    // GrokDesk is packaged manually, so load the loose PNG from the main bundle
    // explicitly instead of relying on asset-catalog name resolution.
    private static let bundledImage: NSImage? = {
        guard let url = Bundle.main.url(forResource: "AppIcon", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    var body: some View {
        Group {
            if let image = Self.bundledImage {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
            } else {
                Image(systemName: "sparkles")
                    .font(.system(size: 13, weight: .semibold))
                    .background(.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
            }
        }
        .frame(width: 26, height: 26)
        .accessibilityHidden(true)
    }
}

struct AppSidebar: View {
    @EnvironmentObject private var model: AppModel
    @Binding var showingAccountMenu: Bool
    @Binding var showUsageCard: Bool
    let hideSidebar: () -> Void
    @State private var collapsedProjects: Set<String> = []
    @State private var deleteCandidate: Conversation?
    @State private var isWindowFullScreen = false

    private var projects: [ConversationProject] {
        Dictionary(grouping: model.conversations.filter {
            $0.archivedAt == nil
                && $0.isReadyForSidebar
                && !model.hiddenProjectPaths.contains($0.cwd)
        }, by: \.cwd)
            .map { ConversationProject(path: $0.key, conversations: $0.value.sorted { $0.updatedAt > $1.updatedAt }) }
            .sorted { ($0.conversations.first?.updatedAt ?? .distantPast) > ($1.conversations.first?.updatedAt ?? .distantPast) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 9) {
                GrokDeskBrandMark()
                Text("GrokDesk").font(.system(size: 15, weight: .semibold))
                Spacer()
                Button(action: hideSidebar) { Image(systemName: "sidebar.left") }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("隐藏侧栏")
                Button(action: model.newConversation) { Image(systemName: "square.and.pencil") }
                    .buttonStyle(.plain).help("新对话 ⌘N")
            }
            // A regular hidden-titlebar window needs room for the traffic-light
            // controls. Fullscreen has no traffic lights, so it uses the compact
            // Codex-style top inset instead of keeping an empty titlebar band.
            .padding(.horizontal, 13)
            .padding(.top, isWindowFullScreen ? 10 : 28)
            .padding(.bottom, 8)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 3) {
                    SidebarAction(title: "新对话", icon: "square.and.pencil") { model.newConversation() }
                        .padding(.bottom, 12)
                    Text("项目")
                        .font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                        .padding(.horizontal, 8).padding(.bottom, 4)
                    ForEach(projects) { project in
                        ProjectHeaderRow(
                            project: project,
                            language: model.settings.effectiveLanguage,
                            isExpanded: !collapsedProjects.contains(project.path),
                            toggleExpanded: { toggle(project.path) },
                            hideProject: { model.hideProject(project.path) }
                        ) {
                            model.newConversation(in: project.path)
                        }
                        .frame(height: 30)
                        if !collapsedProjects.contains(project.path) {
                            ForEach(project.conversations) { conversation in
                                Button {
                                    model.selectedConversationID = conversation.id
                                    model.sidebarSection = .chat
                                    model.loadHistoryIfNeeded(conversation.id)
                                } label: {
                                    HStack(spacing: 8) {
                                        Text(conversation.title).lineLimit(1)
                                        Spacer(minLength: 2)
                                        if model.isConversationRunning(conversation.id) {
                                            ProgressView().controlSize(.mini)
                                        }
                                    }
                                    .font(GrokTypography.item)
                                    .padding(.horizontal, 10).padding(.leading, 19)
                                    .frame(maxWidth: .infinity, alignment: .leading).frame(height: 34)
                                    .contentShape(Rectangle())
                                    .background(
                                        conversation.id == model.selectedConversationID
                                            ? Color.primary.opacity(0.085) : Color.clear,
                                        in: RoundedRectangle(cornerRadius: 7)
                                    )
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button("归档对话") { model.archiveConversation(conversation.id) }
                                    Divider()
                                    Button("删除对话…", role: .destructive) { deleteCandidate = conversation }
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 10).padding(.bottom, 10)
            }
            .simultaneousGesture(TapGesture().onEnded { showingAccountMenu = false })

            Divider().opacity(0.6)
            SidebarAccountFooter(showingMenu: $showingAccountMenu, showUsageCard: $showUsageCard)
                .zIndex(20)
        }
        .background(Color.grokSidebarSurface.ignoresSafeArea())
        .overlay(alignment: .topLeading) {
            WindowFullscreenObserver(isFullScreen: $isWindowFullScreen)
                .frame(width: 0, height: 0)
                .allowsHitTesting(false)
        }
        .onAppear { model.syncLocalSessions() }
        .alert("永久删除这个 Session？", isPresented: Binding(
            get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } }
        ), presenting: deleteCandidate) { conversation in
            Button("移到废纸篓", role: .destructive) { model.deleteConversation(conversation.id); deleteCandidate = nil }
            Button("取消", role: .cancel) { deleteCandidate = nil }
        } message: { conversation in
            Text("“\(conversation.title)” 将从 GrokDesk 删除；对应的本地 Grok Session 会移到 macOS 废纸篓。")
        }
    }

    private func toggle(_ path: String) {
        withAnimation(.easeInOut(duration: 0.16)) {
            if collapsedProjects.contains(path) { collapsedProjects.remove(path) }
            else { collapsedProjects.insert(path) }
        }
    }
}

private struct ProjectHeaderRow: View {
    let project: ConversationProject
    let language: String
    let isExpanded: Bool
    let toggleExpanded: () -> Void
    let hideProject: () -> Void
    let createConversation: () -> Void
    @State private var hovering = false

    private var projectName: String { project.displayName(language: language) }

    var body: some View {
        HStack(spacing: 4) {
            Button(action: toggleExpanded) {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .frame(width: 10)
                    Label(projectName, systemImage: "folder")
                        .font(GrokTypography.item(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Spacer(minLength: 4)
            Button(action: createConversation) {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .opacity(hovering ? 1 : 0.45)
            .help("在 \(projectName) 中新建对话")
        }
        .onHover { hovering = $0 }
        .help(isExpanded ? "折叠 \(projectName)" : "展开 \(projectName)")
        .contextMenu {
            Button("在此项目中新建对话", action: createConversation)
            Button("从侧栏移除项目", role: .destructive, action: hideProject)
        }
    }
}

private struct SidebarAction: View {
    let title: String
    let icon: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Label { Text(LocalizedStringKey(title)) } icon: { Image(systemName: icon) }
                .font(GrokTypography.item)
                .frame(maxWidth: .infinity, alignment: .leading).frame(height: 32)
                .padding(.horizontal, 8).contentShape(Rectangle())
        }
            .buttonStyle(.plain)
    }
}

struct SidebarAccountFooter: View {
    @EnvironmentObject private var model: AppModel
    @Binding var showingMenu: Bool
    @Binding var showUsageCard: Bool
    private var active: GrokAccount? {
        if let id = model.selectedConversation?.accountID { return model.accounts.first { $0.id == id } }
        return model.routeAccount()
    }
    var body: some View {
        ZStack(alignment: .bottom) {
            Button {
                withAnimation(.easeOut(duration: 0.14)) { showingMenu.toggle() }
            } label: {
                HStack(spacing: 9) {
                    accountAvatar
                    VStack(alignment: .leading, spacing: 1) {
                        Text(active?.name ?? L10n.text("添加 Grok 账号", language: model.settings.effectiveLanguage)).font(GrokTypography.item(.medium)).lineLimit(1)
                        Text(quotaText).font(GrokTypography.metadata).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: showingMenu ? "chevron.down" : "chevron.up")
                        .font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle()).padding(.horizontal, 12)
            }
            .buttonStyle(.plain).frame(maxWidth: .infinity).frame(height: 52)

            if showingMenu {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 9) {
                        accountAvatar
                        Text(active?.name ?? L10n.text("添加 Grok 账号", language: model.settings.effectiveLanguage)).font(GrokTypography.item(.medium))
                    }.padding(.horizontal, 11).frame(height: 38)
                    Divider()
                    accountMenuButton("账号与额度", icon: "gauge.with.dots.needle.50percent") {
                        showUsageCard = true; showingMenu = false
                    }
                    accountMenuButton("刷新额度", icon: "arrow.clockwise") {
                        Task { await model.refreshQuotas() }; showingMenu = false
                    }
                    accountMenuButton("设置", icon: "gearshape") {
                        model.sidebarSection = .settings; showingMenu = false
                    }
                }
                .padding(5)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(.primary.opacity(0.10), lineWidth: 0.7))
                .shadow(color: .black.opacity(0.14), radius: 16, y: 5)
                .padding(.horizontal, 7)
                .offset(y: -48)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
                .zIndex(2)
            }
        }
        .frame(maxWidth: .infinity).frame(height: 52)
        .background(Color.grokSidebarSurface)
    }

    private var accountAvatar: some View {
        ZStack {
            Circle().fill(Color.accentColor.opacity(0.14))
            Text(String((active?.name ?? "G").prefix(1))).font(.system(size: 10, weight: .semibold))
        }.frame(width: 24, height: 24)
    }

    private var quotaText: String {
        if let remaining = active?.quota?.weeklyRemainingPercent {
            return model.settings.effectiveLanguage == "en"
                ? "\(Int(remaining.rounded()))% weekly usage remaining"
                : "本周剩余 \(Int(remaining.rounded()))%"
        }
        return L10n.text(model.accounts.isEmpty ? "尚未配置" : "额度待刷新", language: model.settings.effectiveLanguage)
    }

    private func accountMenuButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: icon).frame(width: 15)
                Text(LocalizedStringKey(title))
                Spacer()
                if title == "账号与额度" { Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary) }
                if title == "设置" { Text("⌘,").font(.caption).foregroundStyle(.tertiary) }
            }
            .font(GrokTypography.item).padding(.horizontal, 8).frame(height: 32).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

struct ChatView: View {
    @EnvironmentObject private var model: AppModel
    @Binding var showInspector: Bool
    @Binding var showSidebar: Bool
    private static let messagePageSize = 12
    /// Draft text belongs to a conversation, not to the chat window. Keeping
    /// one shared string lets a background stream re-render the composer while
    /// the user is editing another session and also leaks drafts on switching.
    @State private var promptsByConversation: [UUID: String] = [:]
    @State private var visibleMessageLimit = ChatView.messagePageSize
    @State private var isNearLatestMessage = true
    @State private var followLatestTask: Task<Void, Never>?

    private static let latestMessageAnchor = "chat-latest-message-anchor"

    var body: some View {
        VStack(spacing: 0) {
            ChatHeader(showInspector: $showInspector, showSidebar: $showSidebar)
            Divider().opacity(0.55)
            messageArea
            ComposerView(prompt: selectedPrompt)
                // A conversation switch is an editor boundary. Reusing the
                // same AppKit text view leaks marked-text/focus synchronization
                // from a streaming session into the newly selected draft.
                .id(model.selectedConversationID)
                .padding(.horizontal, 28).padding(.bottom, 18)
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.34))
        .onChange(of: model.selectedConversationID) { _, _ in
            followLatestTask?.cancel()
            isNearLatestMessage = true
            // Opening a long chat starts from its recent turns. Older turns are
            // opt-in so switching sessions does not eagerly build thousands of
            // Markdown and timeline subviews.
            visibleMessageLimit = Self.messagePageSize
        }
    }

    private var selectedPrompt: Binding<String> {
        let conversationID = model.selectedConversationID
        return Binding(
            get: {
                guard let conversationID else { return "" }
                return promptsByConversation[conversationID] ?? ""
            },
            set: { value in
                guard let conversationID else { return }
                promptsByConversation[conversationID] = value
            }
        )
    }

    private var messageArea: some View {
        let messages = model.selectedConversation?.messages ?? []
        let hiddenCount = max(messages.count - visibleMessageLimit, 0)
        let visibleMessages = Array(messages.suffix(visibleMessageLimit))
        return ScrollViewReader { proxy in
            GeometryReader { viewport in
                ScrollView {
                    // Only the recent bounded window is rendered, so eagerly
                    // measuring it is inexpensive and gives macOS a stable
                    // height for the initial bottom anchor. LazyVStack can
                    // estimate an empty region until the first wheel gesture.
                    VStack(alignment: .leading, spacing: 26) {
                        if messages.isEmpty {
                            EmptyConversationView()
                                .frame(maxWidth: .infinity).padding(.top, 110)
                        } else {
                            if hiddenCount > 0 {
                                Button {
                                    visibleMessageLimit += Self.messagePageSize
                                } label: {
                                    Label(
                                        L10n.format("加载更早消息（%@ 条）", language: model.settings.effectiveLanguage,
                                                    String(min(hiddenCount, Self.messagePageSize))),
                                        systemImage: "clock.arrow.circlepath"
                                    )
                                }
                                .buttonStyle(.borderless)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity)
                            }
                            ForEach(visibleMessages) { message in
                                MessageRow(message: message).id(message.id)
                            }
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(Self.latestMessageAnchor)
                            .background {
                                GeometryReader { geometry in
                                    Color.clear.preference(
                                        key: ChatLatestMessagePositionKey.self,
                                        value: geometry.frame(in: .named("chat-message-scroll")).maxY
                                    )
                                }
                            }
                    }
                    .frame(maxWidth: 780)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 34).padding(.top, 34).padding(.bottom, 28)
                }
                .defaultScrollAnchor(.bottom)
                .coordinateSpace(name: "chat-message-scroll")
                .onPreferenceChange(ChatLatestMessagePositionKey.self) { bottomY in
                    isNearLatestMessage = bottomY <= viewport.size.height + 72
                }
                .overlay(alignment: .bottomTrailing) {
                    if !messages.isEmpty && !isNearLatestMessage {
                        Button {
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo(Self.latestMessageAnchor, anchor: .bottom)
                            }
                        } label: {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 14, weight: .semibold))
                                .frame(width: 34, height: 34)
                        }
                        .buttonStyle(.plain)
                        .background(.regularMaterial, in: Circle())
                        .overlay(Circle().stroke(.separator.opacity(0.65), lineWidth: 0.5))
                        .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
                        .help(L10n.text("跳到最新消息", language: model.settings.effectiveLanguage))
                        .padding(.trailing, 24).padding(.bottom, 18)
                    }
                }
                .onChange(of: latestMessageSignal) { _, _ in
                    guard isNearLatestMessage else { return }
                    scheduleFollowLatest(proxy, conversationID: model.selectedConversationID)
                }
                .onDisappear { followLatestTask?.cancel() }
            }
        }
        // ScrollViewReader otherwise keeps the previous session's scroll
        // storage and applies the new transcript from the top before scrollTo.
        .id(model.selectedConversationID)
    }

    /// SwiftUI's `onChange` would otherwise compare the complete last message,
    /// including every persisted tool payload, on each streamed update.
    private var latestMessageSignal: LatestMessageSignal? {
        guard let message = model.selectedConversation?.messages.last else { return nil }
        return LatestMessageSignal(
            id: message.id,
            textLength: message.text.utf8.count,
            thoughtLength: message.thought?.utf8.count ?? 0,
            mediaCount: message.media?.count ?? 0,
            eventCount: message.events?.count ?? 0,
            isStreaming: message.isStreaming
        )
    }

    private func scheduleFollowLatest(_ proxy: ScrollViewProxy, conversationID: UUID?) {
        followLatestTask?.cancel()
        followLatestTask = Task { @MainActor in
            // Coalesce streaming deltas into one post-layout update. Re-checking
            // proximity after yielding lets a user's wheel/trackpad gesture
            // cancel automatic following immediately.
            await Task.yield()
            guard !Task.isCancelled,
                  model.selectedConversationID == conversationID,
                  isNearLatestMessage else { return }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                proxy.scrollTo(Self.latestMessageAnchor, anchor: .bottom)
            }
        }
    }
}

private struct LatestMessageSignal: Equatable {
    let id: UUID
    let textLength: Int
    let thoughtLength: Int
    let mediaCount: Int
    let eventCount: Int
    let isStreaming: Bool
}

private struct ChatLatestMessagePositionKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct ChatHeader: View {
    @EnvironmentObject private var model: AppModel
    @Binding var showInspector: Bool
    @Binding var showSidebar: Bool
    private var projectName: String {
        guard let cwd = model.selectedConversation?.cwd else {
            return L10n.text("选择项目", language: model.settings.effectiveLanguage)
        }
        return WorkspacePresentation.displayName(for: cwd, language: model.settings.effectiveLanguage)
    }
    var body: some View {
        HStack(spacing: 10) {
            if !showSidebar {
                Button { withAnimation(.easeInOut(duration: 0.18)) { showSidebar = true } } label: {
                    Image(systemName: "sidebar.left")
                }
                .buttonStyle(.plain).help("显示侧栏")
            }
            Button(action: model.chooseWorkingDirectory) {
                HStack(spacing: 7) {
                    Image(systemName: "folder").foregroundStyle(.secondary)
                    Text(projectName).fontWeight(.medium).lineLimit(1)
                }
            }.buttonStyle(.plain).help(projectName)
            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            Text(model.selectedConversation?.title ?? L10n.text("新对话", language: model.settings.effectiveLanguage)).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
            if model.selectedConversationIsRunning {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L10n.text(model.statusText, language: model.settings.effectiveLanguage))
                }
                    .font(GrokTypography.metadata).foregroundStyle(.secondary)
            }
            Button { showInspector.toggle() } label: {
                Image(systemName: showInspector ? "sidebar.right" : "sidebar.trailing")
            }.buttonStyle(.plain).help("运行详情")
        }
        .font(GrokTypography.item).padding(.horizontal, 18).frame(height: 48)
    }
}

struct EmptyConversationView: View {
    @EnvironmentObject private var model: AppModel

    private var workspaceDisplayName: String {
        guard let cwd = model.selectedConversation?.cwd else {
            return L10n.text("选择一个工作目录，然后把任务交给 Grok",
                             language: model.settings.effectiveLanguage)
        }

        return WorkspacePresentation.displayName(for: cwd, language: model.settings.effectiveLanguage)
    }

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "sparkles").font(.system(size: 28, weight: .light)).foregroundStyle(.secondary)
            Text("今天想构建什么？").font(.system(size: 24, weight: .semibold))
            Text(workspaceDisplayName)
                .font(.callout).foregroundStyle(.secondary).lineLimit(1)
            if model.accounts.isEmpty {
                Button("添加 Grok 账号", action: model.showAccountSettings).buttonStyle(.borderedProminent)
            }
        }
    }
}

struct ComposerView: View {
    @EnvironmentObject private var model: AppModel
    @Binding var prompt: String
    @State private var editorHeight: CGFloat = 30
    @State private var editorFocused = false
    @State private var previewAttachment: AttachmentPreview?
    @State private var selectedSlashCommandName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if showsSlashCommands {
                SlashCommandPalette(query: slashQuery) { command in
                    selectedSlashCommandName = command.name
                    prompt = "/\(command.name) "
                    editorFocused = true
                }
            }
            if model.selectedConversation?.messages.isEmpty != false { workspacePicker }
            if !model.pendingAttachments.isEmpty { attachments }
            ZStack(alignment: .topLeading) {
                if prompt.isEmpty { Text("描述任务，或让 Grok 修改代码…").font(GrokTypography.body).foregroundStyle(.tertiary).padding(.top, 7).padding(.leading, 5) }
                AutoGrowingTextEditor(text: $prompt, height: $editorHeight, isFocused: $editorFocused,
                                      onSubmit: send, onPasteAttachments: model.addAttachments)
                    .frame(height: editorHeight)
            }
            HStack(spacing: 10) {
                Button(action: model.chooseAttachments) { Image(systemName: "plus") }
                    .buttonStyle(.plain).help("添加图片、音频或文件")
                PermissionModeMenu()
                Spacer()
                ContextUsageIndicator()
                ReasoningEffortMenu()
                if model.selectedConversationIsRunning && !canSend {
                    Button(action: model.cancel) {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 8, weight: .bold))
                            .frame(width: 28, height: 28)
                            .background(Color.primary, in: Circle())
                            .foregroundStyle(Color(nsColor: .controlBackgroundColor))
                    }
                        .buttonStyle(.plain).help("停止")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold))
                            .frame(width: 28, height: 28)
                            .background(canSend ? Color.primary : Color.secondary.opacity(0.16), in: Circle())
                            .foregroundStyle(canSend ? Color(nsColor: .controlBackgroundColor) : Color.secondary.opacity(0.55))
                    }
                    .buttonStyle(.plain).disabled(!canSend)
                    .help(model.selectedConversationIsRunning ? "追加到当前运行" : "发送（Return）")
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: 780)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(.primary.opacity(0.10), lineWidth: 0.7))
        .shadow(color: .black.opacity(0.08), radius: 18, y: 5)
        .frame(maxWidth: .infinity)
        .onAppear { editorHeight = 30 }
        .sheet(item: $previewAttachment) { AttachmentDetailView(url: $0.url) }
    }

    private var canSend: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || (!model.selectedConversationIsRunning && !model.pendingAttachments.isEmpty)
    }
    private func send() {
        guard canSend else { return }
        let value = prompt
        prompt = ""
        selectedSlashCommandName = nil
        model.send(value)
    }
    private var showsSlashCommands: Bool {
        guard prompt.hasPrefix("/"), !prompt.contains("\n") else { return false }
        // Once a row has completed `/name `, arguments belong to that command
        // and the chooser must stay dismissed. Editing the command token itself
        // makes the prefix differ and naturally reopens discovery.
        if let selectedSlashCommandName,
           prompt.hasPrefix("/\(selectedSlashCommandName) ") { return false }
        return true
    }
    private var slashQuery: String { String(prompt.dropFirst()).split(separator: " ").first.map(String.init) ?? "" }

    private var workspacePicker: some View {
        Button(action: model.chooseWorkingDirectory) {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                Text(workspaceName).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2).foregroundStyle(.tertiary)
            }
            .font(GrokTypography.metadata).foregroundStyle(.secondary)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(.secondary.opacity(0.07), in: Capsule())
        }
        .buttonStyle(.plain)
        .help(workspaceName)
    }

    private var workspaceName: String {
        guard let path = model.selectedConversation?.cwd else {
            return L10n.text("选择文件夹", language: model.settings.effectiveLanguage)
        }
        return WorkspacePresentation.displayName(for: path, language: model.settings.effectiveLanguage)
    }

    private var attachments: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(model.pendingAttachments, id: \.self) { url in
                    ZStack(alignment: .topTrailing) {
                        Button { previewAttachment = AttachmentPreview(url: url) } label: {
                            AttachmentThumbnail(url: url)
                        }.buttonStyle(.plain)
                        Button { model.pendingAttachments.removeAll { $0 == url } } label: {
                            Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                                .frame(width: 16, height: 16).background(Color.black, in: Circle()).foregroundStyle(.white)
                        }
                        .buttonStyle(.plain).offset(x: 4, y: -4).help("移除附件")
                    }
                }
            }
            // The remove button overlaps the card edge. Keep that overlap
            // inside the ScrollView's clip rect instead of cutting its top.
            .padding(.top, 6)
            .padding(.trailing, 6)
            .padding(.leading, 2)
            .padding(.bottom, 2)
        }
    }
}

private struct AttachmentPreview: Identifiable {
    let id = UUID()
    let url: URL
}

private struct AttachmentThumbnail: View {
    let url: URL
    private var image: NSImage? { NSImage(contentsOf: url) }
    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                VStack(spacing: 5) {
                    Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable().scaledToFit().frame(width: 28, height: 28)
                    Text(url.lastPathComponent).font(.caption2).lineLimit(1)
                }.padding(7)
            }
        }
        .frame(width: 76, height: 66).clipped()
        .background(.secondary.opacity(0.055), in: RoundedRectangle(cornerRadius: 9))
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(.primary.opacity(0.09)))
    }
}

private struct AttachmentDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let url: URL
    private var image: NSImage? { NSImage(contentsOf: url) }
    private var sizeText: String {
        guard let bytes = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize else { return "" }
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
    var body: some View {
        VStack(spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(url.lastPathComponent).font(.headline).lineLimit(1)
                    Text(sizeText).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { NSWorkspace.shared.open(url) } label: { Image(systemName: "arrow.down.to.line") }.help("使用默认 App 打开")
                Button { dismiss() } label: { Image(systemName: "xmark") }
            }.buttonStyle(.plain)
            Group {
                if let image {
                    Image(nsImage: image).resizable().scaledToFit()
                } else {
                    VStack(spacing: 14) {
                        Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable().scaledToFit().frame(width: 96, height: 96)
                        Text(url.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack {
                Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                Spacer()
                Button("打开") { NSWorkspace.shared.open(url) }.buttonStyle(.borderedProminent)
            }
        }
        .padding(18).frame(minWidth: 720, minHeight: 540)
    }
}

struct SlashCommandPalette: View {
    @EnvironmentObject private var model: AppModel
    let query: String
    let select: (SlashCommandItem) -> Void

    private var matches: [SlashCommandItem] {
        guard !query.isEmpty else { return model.slashCommands }
        return model.slashCommands.filter {
            $0.name.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query)
        }
    }

    private var categories: [String] {
        let order = ["Skills", "Session", "Memory", "Agent", "Extensions", "Tools", "Other"]
        return order.filter { category in matches.contains { $0.category == category } }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                ForEach(categories, id: \.self) { category in
                    Text(category.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
                        .padding(.horizontal, 8).padding(.top, 7)
                    ForEach(matches.filter { $0.category == category }) { command in
                        Button { select(command) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: command.isSkill ? "shippingbox" : "slash.circle")
                                    .font(.caption).foregroundStyle(.secondary).frame(width: 14)
                                Text("/\(command.name)").font(.system(.body, design: .monospaced).weight(.medium)).foregroundStyle(.primary)
                                Text(LocalizedStringKey(command.description)).font(GrokTypography.metadata).foregroundStyle(.secondary).lineLimit(1)
                                Spacer()
                                if let hint = command.argumentHint { Text(LocalizedStringKey(hint)).font(.caption2).foregroundStyle(.tertiary).lineLimit(1) }
                            }.padding(.horizontal, 8).padding(.vertical, 6).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }
            }.padding(6)
        }
        .frame(maxHeight: 250)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.primary.opacity(0.09)))
        .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
    }
}

struct ReasoningEffortMenu: View {
    @EnvironmentObject private var model: AppModel
    private let efforts: [(id: String, label: String)] = [
        ("minimal", "Minimal"), ("low", "Low"), ("medium", "Medium"),
        ("high", "High"), ("xhigh", "X-High")
    ]

    var body: some View {
        Menu {
            Menu {
                ForEach(model.availableModels) { option in
                    Button {
                        model.setModel(option.id)
                    } label: {
                        if option.id == model.settings.model { Label(option.name, systemImage: "checkmark") }
                        else { Text(option.name) }
                    }
                }
            } label: {
                HStack { Text("模型"); Spacer(); Text(currentModelName).foregroundStyle(.secondary) }
            }
            Menu {
                ForEach(efforts, id: \.id) { effort in
                    Button {
                        model.setReasoningEffort(effort.id)
                    } label: {
                        if effort.id == model.settings.reasoningEffort {
                            Label(effort.label, systemImage: "checkmark")
                        } else {
                            Text(effort.label)
                        }
                    }
                }
            } label: {
                HStack { Text("推理强度"); Spacer(); Text(effortLabel).foregroundStyle(.secondary) }
            }
        } label: {
            Text("\(model.settings.model) · \(effortLabel)")
                .font(GrokTypography.metadata).foregroundStyle(.secondary)
        }
        .menuStyle(.borderlessButton).fixedSize()
        .menuIndicator(.hidden)
        .disabled(model.selectedConversationIsRunning)
        .help("选择模型推理强度")
    }

    private var effortLabel: String {
        efforts.first { $0.id == model.settings.reasoningEffort }?.label ?? model.settings.reasoningEffort.capitalized
    }
    private var currentModelName: String {
        model.availableModels.first { $0.id == model.settings.model }?.name ?? model.settings.model
    }
}

struct PermissionModeMenu: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        Menu {
            Button("每次确认") { model.settings.permissionMode = "default" }
            Button("接受编辑") { model.settings.permissionMode = "acceptEdits" }
            Button("自动执行") { model.settings.permissionMode = "auto" }
            Button("规划模式") { model.settings.permissionMode = "plan" }
            Divider()
            Button("绕过确认（高风险）") { model.settings.permissionMode = "bypassPermissions" }
        } label: {
            Label { Text(LocalizedStringKey(label)) } icon: {
                Image(systemName: model.settings.permissionMode == "bypassPermissions" ? "exclamationmark.shield" : "shield")
            }
                .font(GrokTypography.item).foregroundStyle(model.settings.permissionMode == "bypassPermissions" ? .orange : .secondary)
        }.menuStyle(.borderlessButton).fixedSize()
    }
    private var label: String {
        ["default": "确认操作", "acceptEdits": "接受编辑", "auto": "自动执行", "plan": "规划模式", "bypassPermissions": "完全访问"][model.settings.permissionMode] ?? "确认操作"
    }
}

struct MessageRow: View {
    @EnvironmentObject private var model: AppModel
    let message: ChatMessage
    var body: some View {
        switch message.role {
        case .user:
            HStack { Spacer(minLength: 130); messageContent.padding(.horizontal, 14).padding(.vertical, 10).background(.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 15, style: .continuous)) }
        case .assistant:
            messageContent.frame(maxWidth: .infinity, alignment: .leading)
        case .system:
            HStack(spacing: 12) {
                Label { messageContent } icon: { Image(systemName: "exclamationmark.circle") }
                Spacer(minLength: 8)
                if message.text.hasPrefix("运行失败：") || message.text.hasPrefix("Run failed: ") {
                    Button("重新生成", action: model.regenerateLastResponse)
                        .buttonStyle(.bordered)
                        .disabled(model.selectedConversationIsRunning)
                }
            }
            .foregroundStyle(.red).padding(12).background(.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
        case .status:
            Label {
                Text(L10n.text(message.text, language: model.settings.effectiveLanguage))
            } icon: {
                Image(systemName: "stop.circle")
            }
                .font(GrokTypography.metadata).foregroundStyle(.secondary)
        }
    }
    private var messageContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let events = message.events, !events.isEmpty {
                ActivityTimeline(events: events, baseDirectory: model.selectedConversation?.cwd)
            } else if let thought = message.thought, !thought.isEmpty {
                DisclosureGroup("思考过程") {
                    MarkdownText(text: thought, baseDirectory: model.selectedConversation?.cwd)
                        .foregroundStyle(.secondary).padding(.top, 5)
                }
                .font(GrokTypography.item).foregroundStyle(.secondary)
            }
            MarkdownText(text: message.text.isEmpty && message.isStreaming
                ? L10n.text("正在思考…", language: model.settings.effectiveLanguage)
                : displayedMessageText,
                baseDirectory: model.selectedConversation?.cwd)
            if let media = message.media { ForEach(media) { MessageMediaView(media: $0) } }
            if message.isStreaming { HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Grok 正在工作").font(GrokTypography.metadata).foregroundStyle(.secondary) } }
        }
    }

    private var displayedMessageText: String {
        guard message.role == .system,
              message.text.hasPrefix("运行失败：") else { return message.text }
        let detail = String(message.text.dropFirst("运行失败：".count))
        return L10n.format("运行失败：%@", language: model.settings.effectiveLanguage, detail)
    }
}

private enum ActivityCategory: Int, CaseIterable, Identifiable {
    case reasoning, skills, files, commands, hooks, context, plan, interactions, system, other
    var id: Int { rawValue }
    var title: String {
        switch self {
        case .reasoning: return "思考过程"
        case .skills: return "Skills 与扩展"
        case .files: return "文件与搜索"
        case .commands: return "命令与任务"
        case .hooks: return "Hooks"
        case .context: return "上下文与记忆"
        case .plan: return "执行计划"
        case .interactions: return "权限与交互"
        case .system: return "运行与系统"
        case .other: return "其他操作"
        }
    }
    var icon: String {
        switch self {
        case .reasoning: return "brain"
        case .skills: return "shippingbox"
        case .files: return "doc.text.magnifyingglass"
        case .commands: return "terminal"
        case .hooks: return "arrow.triangle.branch"
        case .context: return "arrow.triangle.2.circlepath"
        case .plan: return "checklist"
        case .interactions: return "hand.raised"
        case .system: return "waveform.path.ecg"
        case .other: return "wrench.and.screwdriver"
        }
    }

    static func category(for event: ChatTimelineEvent) -> ActivityCategory {
        // Classification metadata is sufficient. Scanning tool input/output here
        // made a collapsed process row repeatedly traverse multi-megabyte payloads.
        let haystack = [event.kind, event.title].joined(separator: " ").lowercased()
        if haystack.contains("hook") || haystack.contains("pre_tool_use") || haystack.contains("post_tool_use") { return .hooks }
        if haystack.contains("skill") || haystack.contains("plugin") || haystack.contains("/skills/") { return .skills }
        if event.kind == "thought" { return .reasoning }
        if event.kind == "plan" { return .plan }
        if event.kind == "context" || haystack.contains("compact") || haystack.contains("memory") { return .context }
        if ["permission", "question", "interaction"].contains(where: haystack.contains) { return .interactions }
        if ["read", "write", "edit", "search", "list", "file", "fetch"].contains(where: haystack.contains) { return .files }
        if ["execute", "command", "shell", "bash", "terminal", "background_task", "task_"].contains(where: haystack.contains) { return .commands }
        if ["compact", "memory", "retry", "session", "turn_completed", "system"].contains(where: haystack.contains) { return .system }
        return .other
    }
}

private struct ActivityTimeline: View {
    let events: [ChatTimelineEvent]
    let baseDirectory: String?
    @State private var expanded = false

    /// Runtime lifecycle noise is still available in the inspector's raw ACP
    /// event stream. The conversation timeline only contains user-relevant
    /// actions and state transitions.
    private var visibleEvents: [ChatTimelineEvent] {
        events.filter { ActivityCategory.category(for: $0) != .system }
    }

    /// Preserve ACP arrival order. Only consecutive events of the same category
    /// share a disclosure group; a later return to that category starts a new run.
    private var runs: [ActivityRun] {
        var result: [ActivityRun] = []
        for event in visibleEvents {
            let category = ActivityCategory.category(for: event)
            if let lastIndex = result.indices.last, result[lastIndex].category == category {
                result[lastIndex].events.append(event)
            } else {
                result.append(ActivityRun(id: "\(event.id)-\(result.count)", category: category, events: [event]))
            }
        }
        return result
    }

    var body: some View {
        if !visibleEvents.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                TimelineDisclosureButton(isExpanded: $expanded) {
                    Image(systemName: "brain.head.profile").frame(width: 16)
                    Text("过程")
                    Text("\(visibleEvents.count)").font(GrokTypography.metadata).foregroundStyle(.tertiary)
                }
                .font(GrokTypography.item(.medium))
                if expanded {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(runs) { run in
                            ActivityCategoryGroup(category: run.category, events: run.events, baseDirectory: baseDirectory)
                        }
                    }
                    .padding(.top, 8).padding(.leading, 20)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .foregroundStyle(.secondary)
        }
    }
}

/// `DisclosureGroup` on macOS may leave only its chevron reliably clickable.
/// This control makes the complete visible row toggle its nested content.
private struct TimelineDisclosureButton<Label: View>: View {
    @Binding var isExpanded: Bool
    @ViewBuilder let label: () -> Label

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.16)) { isExpanded.toggle() }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .frame(width: 12)
                label()
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isExpanded ? "已展开" : "已折叠")
    }
}

private struct ActivityRun: Identifiable {
    let id: String
    let category: ActivityCategory
    var events: [ChatTimelineEvent]
}

private struct ActivityCategoryGroup: View {
    let category: ActivityCategory
    let events: [ChatTimelineEvent]
    let baseDirectory: String?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TimelineDisclosureButton(isExpanded: $expanded) {
                Image(systemName: category.icon).frame(width: 16)
                Text(LocalizedStringKey(category.title))
                Text("\(events.count)").font(GrokTypography.metadata).foregroundStyle(.tertiary)
            }
            .font(GrokTypography.item(.medium))
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(events) { TimelineEventRow(event: $0, baseDirectory: baseDirectory) }
                }
                .padding(.top, 8).padding(.leading, 20)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .foregroundStyle(.secondary)
    }
}

private struct TimelineEventRow: View {
    @Environment(\.locale) private var locale
    let event: ChatTimelineEvent
    let baseDirectory: String?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TimelineDisclosureButton(isExpanded: $expanded) {
                Image(systemName: icon).frame(width: 13)
                Text(L10n.text(event.title, language: locale.identifier.hasPrefix("en") ? "en" : "zh-Hans")).lineLimit(1)
                if let status = event.status, !status.isEmpty {
                    Text(LocalizedStringKey(statusLabel(status))).foregroundStyle(statusColor(status))
                }
            }
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if let input = event.input, !input.isEmpty {
                        eventDetail(title: "输入", value: input)
                    }
                    if let output = event.output, !output.isEmpty {
                        if event.kind == "thought" {
                            MarkdownText(text: output, baseDirectory: baseDirectory).foregroundStyle(.secondary)
                        }
                        else { eventDetail(title: event.kind == "plan" ? "内容" : "结果", value: output) }
                    }
                }
                .padding(.top, 7).padding(.leading, 2)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .font(GrokTypography.item).foregroundStyle(.secondary)
    }

    private func eventDetail(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(LocalizedStringKey(title)).font(GrokTypography.metadata(.semibold)).foregroundStyle(.tertiary)
            Text(value).font(GrokTypography.metadata.monospaced()).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8).background(.secondary.opacity(0.055), in: RoundedRectangle(cornerRadius: 7))
        }
    }

    private var icon: String {
        switch event.kind {
        case "thought": return "brain"
        case "plan": return "checklist"
        case "compaction": return "arrow.triangle.2.circlepath"
        case "hook": return "arrow.triangle.branch"
        case "permission", "question", "interaction": return "hand.raised"
        default:
            let title = event.title.lowercased()
            if title.contains("shell") || title.contains("terminal") || title.contains("command") { return "terminal" }
            if title.contains("read") || title.contains("file") { return "doc.text" }
            if title.contains("search") { return "magnifyingglass" }
            return "wrench.and.screwdriver"
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "completed", "success": return "完成"
        case "failed", "error": return "失败"
        case "pending": return "等待"
        case "in_progress", "running": return "运行中"
        default: return status
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "completed", "success": return .green
        case "failed", "error": return .red
        default: return .secondary
        }
    }
}

private struct ContextUsageIndicator: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingDetails = false

    private var usage: ContextUsage {
        model.selectedContextUsage ?? ContextUsage(
            usedTokens: 0, totalTokens: model.settings.effectiveContextWindowTokens
        )
    }

    var body: some View {
        Button { showingDetails = true } label: {
            ZStack {
                Circle().stroke(.secondary.opacity(0.18), lineWidth: 2)
                Circle().trim(from: 0, to: usage.fraction)
                    .stroke(usage.fraction >= 0.8 ? Color.orange : Color.secondary,
                            style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 13, height: 13)
            // Keep the compact ring visually aligned with the composer while
            // providing a standard, reliable pointer target around it.
            .frame(width: 28, height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(width: 28, height: 28)
        .help(L10n.format("Context window：%d%% 已使用（剩余 %d%%）\n%@ / %@ tokens",
                          language: model.settings.effectiveLanguage,
                          percent, 100 - percent,
                          format(usage.usedTokens), format(usage.totalTokens)))
        .popover(isPresented: $showingDetails, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Context window").font(.headline)
                HStack {
                    Text(L10n.text("使用情况", language: model.settings.effectiveLanguage))
                    Spacer()
                    Text("\(percent)%")
                }
                ProgressView(value: usage.fraction)
                Text("\(format(usage.usedTokens)) / \(format(usage.totalTokens)) tokens")
                    .font(GrokTypography.metadata).foregroundStyle(.secondary)
                Divider()
                Text(L10n.format("达到 %d%% 时由 Grok Build 自动压缩",
                                 language: model.settings.effectiveLanguage,
                                 model.settings.effectiveAutoCompactThresholdPercent))
                    .font(GrokTypography.metadata).foregroundStyle(.secondary)
                if usage.compactionCount > 0 {
                    Text(L10n.format("本 Session 已压缩 %d 次",
                                     language: model.settings.effectiveLanguage,
                                     usage.compactionCount))
                        .font(GrokTypography.metadata).foregroundStyle(.secondary)
                }
            }.padding(14).frame(width: 280)
        }
    }

    private var percent: Int { Int((usage.fraction * 100).rounded()) }
    private func format(_ value: Int) -> String {
        value >= 1_000 ? String(format: "%.0fk", Double(value) / 1_000) : "\(value)"
    }
}

struct RuntimeInspector: View {
    @EnvironmentObject private var model: AppModel
    @State private var tab = 0
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("运行详情").font(.headline)
                Spacer()
                Picker("", selection: $tab) {
                    Image(systemName: "wrench.and.screwdriver").tag(0)
                    Image(systemName: "checklist").tag(1)
                    Image(systemName: "waveform.path.ecg").tag(2)
                    Image(systemName: "slider.horizontal.3").tag(3)
                }.pickerStyle(.segmented).frame(width: 142)
            }.padding(14)
            Divider()
            Group {
                if tab == 0 { ToolInspector() }
                else if tab == 1 { PlanInspector() }
                else if tab == 2 { EventInspector() }
                else { CapabilityCenter() }
            }
        }
        .ignoresSafeArea(.container, edges: .top)
    }
}

private struct InspectorCard<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View { content.padding(12).background(.secondary.opacity(0.055), in: RoundedRectangle(cornerRadius: 12)) }
}

struct ToolInspector: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ScrollView { LazyVStack(spacing: 9) {
            if model.selectedTools.isEmpty { InspectorEmpty(title: "暂无工具调用", icon: "wrench.and.screwdriver") }
            ForEach(model.selectedTools) { tool in
                InspectorCard {
                    DisclosureGroup {
                        if let input = tool.input { Text(input).font(.caption.monospaced()).textSelection(.enabled).padding(.top, 8) }
                        if let output = tool.output { Divider(); Text(output).font(.caption.monospaced()).textSelection(.enabled) }
                    } label: {
                        HStack { Image(systemName: toolIcon(tool.kind)); VStack(alignment: .leading, spacing: 2) { Text(tool.title).lineLimit(1); Text(tool.status).font(.caption2).foregroundStyle(.secondary) } }
                    }
                }
            }
        }.padding(12) }
    }
    private func toolIcon(_ kind: String) -> String {
        if kind.contains("edit") { return "pencil.line" }; if kind.contains("execute") { return "terminal" }; if kind.contains("search") { return "magnifyingglass" }; return "wrench"
    }
}

struct PlanInspector: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ScrollView { LazyVStack(spacing: 9) {
            if model.selectedPlan.isEmpty { InspectorEmpty(title: "暂无执行计划", icon: "checklist") }
            ForEach(model.selectedPlan) { item in InspectorCard { HStack(alignment: .top) { Image(systemName: item.status == "completed" ? "checkmark.circle.fill" : "circle").foregroundStyle(item.status == "completed" ? .green : .secondary); Text(item.text).frame(maxWidth: .infinity, alignment: .leading) } } }
        }.padding(12) }
    }
}

struct EventInspector: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ScrollView { LazyVStack(spacing: 9) {
            if model.selectedExtensionEvents.isEmpty { InspectorEmpty(title: "暂无 Runtime 事件", icon: "waveform.path.ecg") }
            ForEach(Array(model.selectedExtensionEvents.enumerated()), id: \.offset) { _, event in InspectorCard { DisclosureGroup(event.0) { Text(event.1).font(.caption.monospaced()).textSelection(.enabled).padding(.top, 8) } } }
        }.padding(12) }
    }
}

struct InspectorEmpty: View {
    let title: String; let icon: String
    var body: some View { VStack(spacing: 8) { Image(systemName: icon).font(.title2).foregroundStyle(.tertiary); Text(LocalizedStringKey(title)).font(GrokTypography.metadata).foregroundStyle(.secondary) }.frame(maxWidth: .infinity).padding(.top, 50) }
}

struct CapabilityCenter: View {
    @EnvironmentObject private var model: AppModel
    @State private var method = "x.ai/session/info"
    @State private var params = "{}"
    @State private var asNotification = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("底层能力").font(.headline)
                Menu(method) {
                    ForEach(Dictionary(grouping: GrokCapabilityCatalog.all, by: \.category).keys.sorted(), id: \.self) { category in
                        Menu(category) { ForEach(GrokCapabilityCatalog.all.filter { $0.category == category }) { item in Button(item.method) { method = item.method; params = item.template } } }
                    }
                }.menuStyle(.borderlessButton)
                TextField("ACP / x.ai 方法", text: $method).textFieldStyle(.roundedBorder)
                TextEditor(text: $params).font(.caption.monospaced()).frame(height: 108).padding(5).background(.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                Toggle("作为 notification 发送", isOn: $asNotification).font(.caption)
                Button(asNotification ? "发送通知" : "调用能力") { model.callCapability(method: method, paramsText: params, asNotification: asNotification) }.buttonStyle(.borderedProminent)
                Divider()
                Text(model.rawCapabilityResult.isEmpty
                     ? L10n.text("先发送一条消息建立 ACP Session，再调用扩展能力。", language: model.settings.effectiveLanguage)
                     : model.rawCapabilityResult)
                    .font(.caption.monospaced()).textSelection(.enabled).foregroundStyle(.secondary)
            }.padding(14)
        }
    }
}

struct AccountsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var newName = ""
    private let columns = [GridItem(.adaptive(minimum: 290), spacing: 14)]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) { Text("账号与额度").font(.system(size: 26, weight: .semibold)); Text("账号完全隔离，新会话自动使用周额度最充足的账号。").foregroundStyle(.secondary) }
                    Spacer()
                    Button { Task { await model.refreshQuotas() } } label: { Label("刷新额度", systemImage: "arrow.clockwise") }.disabled(model.isRefreshingQuota)
                }
                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach($model.accounts) { $account in
                        AccountCard(account: $account)
                            .dropDestination(for: String.self) { items, _ in
                                guard let rawID = items.first,
                                      let sourceID = UUID(uuidString: rawID) else { return false }
                                model.moveAccount(sourceID, onto: account.id)
                                return true
                            }
                    }
                }
                InspectorCard {
                    HStack(spacing: 10) {
                        Image(systemName: "plus.circle").foregroundStyle(.secondary)
                        TextField("账号名称，例如：工作账号", text: $newName).textFieldStyle(.plain)
                        Button(model.isAddingAccount ? "等待登录…" : "添加账号") {
                            model.addAccount(name: newName.isEmpty
                                ? L10n.format("账号 %d", language: model.settings.effectiveLanguage, model.accounts.count + 1)
                                : newName)
                            newName = ""
                        }.buttonStyle(.borderedProminent).disabled(model.isAddingAccount)
                    }
                }
                if !model.loginLog.isEmpty {
                    DisclosureGroup("登录日志") { Text(model.loginLog).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8) }
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: 980).frame(maxWidth: .infinity).padding(34)
        }
    }
}

private struct UsageCard: View {
    @EnvironmentObject private var model: AppModel
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("额度使用情况").font(.system(size: 18, weight: .semibold))
                Spacer()
                Button(action: close) { Image(systemName: "xmark") }.buttonStyle(.plain)
            }

            ScrollView {
                VStack(spacing: 10) {
                    ForEach(model.accounts.filter(\.enabled)) { account in
                        VStack(alignment: .leading, spacing: 9) {
                            HStack {
                                Circle().fill(account.isLoggedIn ? Color.green : Color.orange).frame(width: 8, height: 8)
                                Text(account.name).font(GrokTypography.item(.medium))
                                Spacer()
                                if model.routeAccount()?.id == account.id {
                                    Text("当前优先").font(.caption2).foregroundStyle(.green)
                                }
                            }
                            if let remaining = account.quota?.weeklyRemainingPercent {
                                HStack {
                                    Text("周额度剩余").foregroundStyle(.secondary)
                                    Spacer()
                                    Text("\(remaining, specifier: "%.0f")%")
                                }.font(GrokTypography.metadata)
                                ProgressView(value: remaining, total: 100).tint(.primary)
                            } else if let error = account.quota?.error {
                                VStack(alignment: .leading, spacing: 7) {
                                    Text(error).font(GrokTypography.metadata).foregroundStyle(.red)
                                    if account.isLoggedIn {
                                        Button("重新登录") { model.login(account) }
                                            .buttonStyle(.bordered).controlSize(.small)
                                    }
                                }
                            } else {
                                Text(LocalizedStringKey(account.isLoggedIn ? "额度待刷新" : "尚未登录"))
                                    .font(GrokTypography.metadata).foregroundStyle(.secondary)
                            }
                            if let end = account.quota?.periodEnd, !end.isEmpty {
                                Text("重置时间：\(end)").font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        .padding(13)
                        .background(.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 11))
                        .overlay(RoundedRectangle(cornerRadius: 11).stroke(.primary.opacity(0.07)))
                    }
                }
            }.frame(maxHeight: 380)

            HStack {
                Button { model.showAccountSettings(); close() } label: {
                    Label("管理账号", systemImage: "person.2")
                }
                Spacer()
                Button { Task { await model.refreshQuotas() } } label: {
                    if model.isRefreshingQuota {
                        HStack(spacing: 7) {
                            ProgressView().controlSize(.small)
                            Text("正在刷新…")
                        }
                    } else {
                        Label("刷新额度", systemImage: "arrow.clockwise")
                    }
                }
                .buttonStyle(.borderedProminent).disabled(model.isRefreshingQuota)
            }
        }
        .padding(20).frame(width: 480)
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.primary.opacity(0.09)))
        .shadow(color: .black.opacity(0.18), radius: 30, y: 12)
    }
}

struct AccountCard: View {
    @EnvironmentObject private var model: AppModel
    @Binding var account: GrokAccount
    @State private var isRenaming = false
    @State private var draftName = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: "line.3.horizontal")
                    .foregroundStyle(.tertiary)
                    .contentShape(Rectangle())
                    .draggable(account.id.uuidString)
                    .help("拖动调整账号顺序")
                Circle().fill(account.isLoggedIn ? Color.green : Color.orange).frame(width: 9, height: 9)
                if isRenaming {
                    TextField("账号名称", text: $draftName)
                        .textFieldStyle(.roundedBorder).font(.headline)
                        .onSubmit(saveName)
                    Button(action: saveName) { Image(systemName: "checkmark") }.buttonStyle(.plain).help("保存")
                    Button { isRenaming = false } label: { Image(systemName: "xmark") }.buttonStyle(.plain).help("取消")
                } else {
                    Text(account.name).font(.headline).lineLimit(1)
                    Spacer(minLength: 4)
                    Button(action: beginRename) { Image(systemName: "pencil") }.buttonStyle(.plain).help("重命名账号")
                }
                Toggle("", isOn: $account.enabled).labelsHidden().toggleStyle(.switch).controlSize(.mini).onChange(of: account.enabled) { _, _ in model.persist() }
                Menu {
                    Button("重命名", action: beginRename)
                    Divider()
                    Button("从列表移除", role: .destructive) { model.removeAccount(account.id) }
                } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize()
            }
            if let remaining = account.quota?.weeklyRemainingPercent {
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text("本周剩余").foregroundStyle(.secondary); Spacer(); Text("\(remaining, specifier: "%.1f")%").fontWeight(.semibold) }.font(GrokTypography.metadata)
                    ProgressView(value: remaining, total: 100).tint(remaining > 30 ? .green : .orange)
                }
            } else if let error = account.quota?.error {
                Text(error).font(GrokTypography.metadata).foregroundStyle(.red)
            } else {
                Text(LocalizedStringKey(account.isLoggedIn ? "登录成功，等待刷新额度" : "尚未登录"))
                    .font(GrokTypography.metadata).foregroundStyle(.secondary)
            }
            HStack {
                Button(account.isLoggedIn ? "重新登录" : "登录") { model.login(account) }
                if account.isLoggedIn { Button("开始对话") { model.openAccount(account) } }
                Spacer()
                if model.routeAccount()?.id == account.id { Label("优先路由", systemImage: "bolt.fill").font(.caption2).foregroundStyle(.green) }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 172, maxHeight: .infinity, alignment: .topLeading)
        .background(.secondary.opacity(0.055), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(.primary.opacity(0.07)))
    }

    private func beginRename() {
        draftName = account.name
        isRenaming = true
    }

    private func saveName() {
        let value = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { account.name = value; model.persist() }
        isRenaming = false
    }
}

struct PermissionSheet: View {
    @EnvironmentObject private var model: AppModel; let permission: PendingPermission
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("需要你的批准", systemImage: "hand.raised.fill").font(.title2.bold())
            Text(permission.title)
            HStack {
                Button("拒绝") { model.answerPermission(nil) }.keyboardShortcut(.cancelAction)
                Spacer()
                ForEach(permission.options) { option in
                    if option.kind.contains("allow") {
                        Button(option.name) { model.answerPermission(option.id) }.buttonStyle(.borderedProminent)
                    } else {
                        Button(option.name) { model.answerPermission(option.id) }.buttonStyle(.bordered)
                    }
                }
            }
        }.padding(24).frame(width: 520)
    }
}

struct QuestionSheet: View {
    @EnvironmentObject private var model: AppModel; let request: PendingQuestionRequest
    @State private var selections: [String: Set<String>] = [:]; @State private var notes: [String: String] = [:]
    var body: some View { VStack(alignment: .leading, spacing: 16) { Label("Grok 需要你的选择", systemImage: "questionmark.bubble.fill").font(.title2.bold()); ScrollView { VStack(alignment: .leading, spacing: 20) { ForEach(request.questions) { question in VStack(alignment: .leading, spacing: 8) { Text(question.question).font(.headline); ForEach(question.options) { option in Toggle(isOn: binding(question, option)) { VStack(alignment: .leading) { Text(option.label); Text(option.description).font(.caption).foregroundStyle(.secondary) } }.toggleStyle(.checkbox) }; TextField("补充说明（可选）", text: Binding(get: { notes[question.question] ?? "" }, set: { notes[question.question] = $0 })) } } } }; HStack { Button("取消") { model.answerQuestions([:], notes: [:], action: "cancelled") }; if request.planMode { Button("继续讨论") { model.answerQuestions(answerMap, notes: notes, action: "chat_about_this") }; Button("跳过访谈") { model.answerQuestions(answerMap, notes: notes, action: "skip_interview") } }; Spacer(); Button("提交") { model.answerQuestions(answerMap, notes: notes) }.buttonStyle(.borderedProminent) } }.padding(24).frame(width: 640, height: 600) }
    private var answerMap: [String: [String]] { selections.mapValues(Array.init) }
    private func binding(_ q: AgentQuestion, _ o: AgentQuestionOption) -> Binding<Bool> { Binding(get: { selections[q.question]?.contains(o.label) == true }, set: { checked in if q.multiSelect { var set = selections[q.question] ?? []; if checked { set.insert(o.label) } else { set.remove(o.label) }; selections[q.question] = set } else { selections[q.question] = checked ? [o.label] : [] } }) }
}

struct PlanApprovalSheet: View {
    @EnvironmentObject private var model: AppModel; let request: PendingPlanApproval; @State private var feedback = ""
    var body: some View { VStack(alignment: .leading, spacing: 16) { Label("审阅执行计划", systemImage: "checklist").font(.title2.bold()); ScrollView { Text(request.content).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.padding(12).background(.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10)); TextField("修改意见", text: $feedback); HStack { Button("要求修改") { model.answerPlan(approved: false, feedback: feedback) }; Spacer(); Button("批准并执行") { model.answerPlan(approved: true) }.buttonStyle(.borderedProminent) } }.padding(24).frame(width: 680, height: 560) }
}

struct MarkdownText: View {
    let text: String
    var baseDirectory: String? = nil
    private var blocks: [MarkdownBlock] { MarkdownBlock.parse(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(blocks) { block in
                switch block.content {
                case .paragraph(let value):
                    MarkdownInline(text: value)
                        .font(.system(size: 15))
                        .lineSpacing(6)
                case .image(let reference):
                    MarkdownImageView(reference: reference, baseDirectory: baseDirectory)
                case .heading(let level, let value):
                    MarkdownInline(text: value)
                        .font(.system(size: headingSize(level)))
                        .fontWeight(level <= 2 ? .bold : .semibold)
                        .padding(.top, level == 1 ? 5 : 2)
                case .unorderedList(let values):
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                            HStack(alignment: .firstTextBaseline, spacing: 9) {
                                Text("•").frame(width: 10, alignment: .center)
                                MarkdownInline(text: value).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }.font(.system(size: 15)).lineSpacing(5)
                case .orderedList(let values):
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(values.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: 9) {
                                Text("\(item.number).").frame(minWidth: 18, alignment: .trailing)
                                MarkdownInline(text: item.text).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }.font(.system(size: 15)).lineSpacing(5)
                case .quote(let value):
                    HStack(alignment: .top, spacing: 10) {
                        RoundedRectangle(cornerRadius: 1).fill(.secondary.opacity(0.35)).frame(width: 3)
                        MarkdownInline(text: value).foregroundStyle(.secondary)
                    }.font(.system(size: 15)).lineSpacing(6)
                case .divider:
                    Divider()
                case .code(let language, let value):
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Text(language.isEmpty ? "Code" : language).font(.caption2).foregroundStyle(.secondary)
                            Spacer()
                            Button {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(value, forType: .string)
                            } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.plain).help("复制代码")
                        }.padding(.horizontal, 10).padding(.vertical, 7)
                        Divider()
                        ScrollView(.horizontal, showsIndicators: true) {
                            Text(value).font(.system(size: 14, design: .monospaced))
                                .lineSpacing(4).textSelection(.enabled).padding(12)
                        }
                    }
                    .background(.secondary.opacity(0.055), in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(.primary.opacity(0.07)))
                case .table(let rows):
                    ScrollView(.horizontal, showsIndicators: true) {
                        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                                GridRow {
                                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                        MarkdownInline(text: cell)
                                            .font(.system(size: 14))
                                            .fontWeight(rowIndex == 0 ? .semibold : .regular)
                                            .padding(.horizontal, 11).padding(.vertical, 9)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .background(rowIndex == 0 ? Color.secondary.opacity(0.07) : Color.clear)
                                            .overlay(Rectangle().stroke(.primary.opacity(0.06), lineWidth: 0.5))
                                    }
                                }
                            }
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.primary.opacity(0.08)))
                }
            }
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level { case 1: return 22; case 2: return 19; case 3: return 17; default: return 15 }
    }
}

private struct MarkdownBlock: Identifiable {
    struct OrderedItem { let number: Int; let text: String }
    enum Content {
        case paragraph(String), heading(Int, String), unorderedList([String]), orderedList([OrderedItem])
        case quote(String), divider, code(String, String), table([[String]]), image(MarkdownImageReference)
    }
    let id = UUID()
    let content: Content

    static func parse(_ markdown: String) -> [MarkdownBlock] {
        var result: [MarkdownBlock] = []
        var prose: [String] = [], code: [String] = [], language = ""
        var insideCode = false

        func flushProse() {
            let value = prose.joined(separator: "\n")
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result.append(contentsOf: parseProseAndTables(value))
            }
            prose.removeAll()
        }
        func flushCode() {
            result.append(MarkdownBlock(content: .code(language, code.joined(separator: "\n"))))
            code.removeAll(); language = ""
        }

        for line in markdown.components(separatedBy: .newlines) {
            if line.hasPrefix("```") {
                if insideCode { flushCode(); insideCode = false }
                else { flushProse(); language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces); insideCode = true }
            } else if insideCode { code.append(line) }
            else { prose.append(line) }
        }
        if insideCode { flushCode() } else { flushProse() }
        return result.isEmpty ? [MarkdownBlock(content: .paragraph(markdown))] : result
    }

    private static func parseProseAndTables(_ value: String) -> [MarkdownBlock] {
        let lines = value.components(separatedBy: .newlines)
        var result: [MarkdownBlock] = [], prose: [String] = []
        var index = 0
        func flush() {
            let text = prose.joined(separator: "\n")
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result.append(MarkdownBlock(content: .paragraph(text)))
            }
            prose.removeAll()
        }
        while index < lines.count {
            if index + 1 < lines.count, lines[index].contains("|"), isTableSeparator(lines[index + 1]) {
                flush()
                var rows = [tableCells(lines[index])]
                index += 2 // Skip Markdown's alignment/separator row.
                while index < lines.count, lines[index].contains("|") {
                    rows.append(tableCells(lines[index])); index += 1
                }
                result.append(MarkdownBlock(content: .table(rows)))
                continue
            }
            if lines[index].contains("|"),
               let rowStart = fragmentedTableRowStart(lines, headerIndex: index) {
                flush()
                var rows = [tableCells(lines[index])]
                index = rowStart
                while index < lines.count, lines[index].contains("|") {
                    rows.append(tableCells(lines[index])); index += 1
                }
                result.append(MarkdownBlock(content: .table(rows)))
                continue
            }

            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { flush(); index += 1; continue }
            if let image = MarkdownImageReference.parseStandalone(line) {
                flush(); result.append(MarkdownBlock(content: .image(image)))
                index += 1; continue
            }
            if let heading = heading(line) {
                flush(); result.append(MarkdownBlock(content: .heading(heading.level, heading.title)))
                index += 1; continue
            }
            if let embedded = splitEmbeddedHeading(line) {
                prose.append(embedded.prefix); flush()
                result.append(MarkdownBlock(content: .heading(embedded.level, embedded.title)))
                index += 1; continue
            }
            if isDivider(line) {
                flush(); result.append(MarkdownBlock(content: .divider)); index += 1; continue
            }
            if let item = unorderedItem(line) {
                flush(); var items: [String] = [item]; index += 1
                while index < lines.count, let next = unorderedItem(lines[index]) { items.append(next); index += 1 }
                result.append(MarkdownBlock(content: .unorderedList(items))); continue
            }
            if let item = orderedItem(line) {
                flush(); var items: [OrderedItem] = [item]; index += 1
                while index < lines.count, let next = orderedItem(lines[index]) { items.append(next); index += 1 }
                result.append(MarkdownBlock(content: .orderedList(items))); continue
            }
            if let quote = quoteLine(line) {
                flush(); var values = [quote]; index += 1
                while index < lines.count, let next = quoteLine(lines[index]) { values.append(next); index += 1 }
                result.append(MarkdownBlock(content: .quote(values.joined(separator: "\n")))); continue
            }
            prose.append(line); index += 1
        }
        flush()
        return result
    }

    private static func heading(_ line: String) -> (level: Int, title: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let level = trimmed.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(level), trimmed.dropFirst(level).first == " " else { return nil }
        return (level, String(trimmed.dropFirst(level + 1)))
    }

    private static func splitEmbeddedHeading(_ line: String) -> (prefix: String, level: Int, title: String)? {
        for level in (1...6).reversed() {
            let marker = String(repeating: "#", count: level) + " "
            guard let range = line.range(of: marker), range.lowerBound != line.startIndex else { continue }
            guard line[line.index(before: range.lowerBound)] != "#" else { continue }
            let prefix = String(line[..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
            guard !prefix.isEmpty, prefix.last?.isPunctuation == true else { continue }
            return (prefix, level, String(line[range.upperBound...]))
        }
        return nil
    }

    private static func isDivider(_ line: String) -> Bool {
        let value = line.replacingOccurrences(of: " ", with: "")
        return value.count >= 3 && (value.allSatisfy { $0 == "-" } || value.allSatisfy { $0 == "*" } || value.allSatisfy { $0 == "_" })
    }

    private static func unorderedItem(_ line: String) -> String? {
        let value = line.trimmingCharacters(in: .whitespaces)
        for marker in ["- ", "* ", "+ "] where value.hasPrefix(marker) { return String(value.dropFirst(2)) }
        return nil
    }

    private static func orderedItem(_ line: String) -> OrderedItem? {
        let value = line.trimmingCharacters(in: .whitespaces)
        guard let dot = value.firstIndex(of: "."), dot != value.startIndex,
              value[value.index(after: dot)...].first == " ",
              let number = Int(value[..<dot]) else { return nil }
        return OrderedItem(number: number, text: String(value[value.index(dot, offsetBy: 2)...]))
    }

    private static func quoteLine(_ line: String) -> String? {
        let value = line.trimmingCharacters(in: .whitespaces)
        return value.hasPrefix("> ") ? String(value.dropFirst(2)) : nil
    }

    private static func fragmentedTableRowStart(_ lines: [String], headerIndex: Int) -> Int? {
        let expectedColumns = tableCells(lines[headerIndex]).count
        guard expectedColumns > 0, headerIndex + 1 < lines.count,
              lines[headerIndex + 1].trimmingCharacters(in: .whitespaces) == "|" else { return nil }
        var index = headerIndex + 2, separatorColumns = 0
        while index < lines.count, separatorColumns < expectedColumns {
            let value = lines[index].trimmingCharacters(in: .whitespaces)
            if value.isEmpty { index += 1; continue }
            var fragment = value
            if fragment.hasSuffix("|") { fragment.removeLast() }
            fragment = fragment.replacingOccurrences(of: ":", with: "")
                .trimmingCharacters(in: .whitespaces)
            guard fragment.count >= 3, fragment.allSatisfy({ $0 == "-" }) else { return nil }
            separatorColumns += 1; index += 1
        }
        while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).isEmpty { index += 1 }
        return separatorColumns == expectedColumns ? index : nil
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let cells = tableCells(line)
        return !cells.isEmpty && cells.allSatisfy {
            let value = $0.replacingOccurrences(of: ":", with: "").trimmingCharacters(in: .whitespaces)
            return value.count >= 3 && value.allSatisfy { $0 == "-" }
        }
    }

    private static func tableCells(_ line: String) -> [String] {
        var value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|") { value.removeLast() }
        return value.split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

private struct MarkdownImageView: View {
    let reference: MarkdownImageReference
    let baseDirectory: String?
    @State private var preview: AttachmentPreview?

    var body: some View {
        Group {
            if let url = reference.resolvedURL(relativeTo: baseDirectory) {
                if url.isFileURL {
                    localImage(url)
                } else if ["https", "http"].contains(url.scheme?.lowercased()) {
                    remoteImage(url)
                } else {
                    unavailable(destination: reference.destination)
                }
            } else {
                unavailable(destination: reference.destination)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(item: $preview) { AttachmentDetailView(url: $0.url) }
    }

    @ViewBuilder
    private func localImage(_ url: URL) -> some View {
        if let image = NSImage(contentsOf: url) {
            Button { preview = AttachmentPreview(url: url) } label: {
                Image(nsImage: image)
                    .resizable().scaledToFit()
                    .frame(maxWidth: 620, maxHeight: 520, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(.primary.opacity(0.08)))
            }
            .buttonStyle(.plain)
            .help(reference.altText.isEmpty ? url.lastPathComponent : reference.altText)
        } else {
            unavailable(destination: url.path)
        }
    }

    private func remoteImage(_ url: URL) -> some View {
        Button { NSWorkspace.shared.open(url) } label: {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                        .frame(maxWidth: 620, maxHeight: 520, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                case .failure:
                    unavailable(destination: url.absoluteString)
                default:
                    ProgressView().frame(width: 120, height: 90)
                }
            }
        }
        .buttonStyle(.plain)
        .help(reference.altText.isEmpty ? url.absoluteString : reference.altText)
    }

    private func unavailable(destination: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(reference.altText.isEmpty ? "图片无法显示" : reference.altText)
                Text(destination).font(GrokTypography.metadata.monospaced()).foregroundStyle(.secondary).lineLimit(2)
            }
        } icon: {
            Image(systemName: "photo.badge.exclamationmark")
        }
        .padding(10)
        .background(.secondary.opacity(0.055), in: RoundedRectangle(cornerRadius: 9))
    }
}

private struct MarkdownInline: View {
    let text: String
    var body: some View {
        if let value = try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(value).textSelection(.enabled)
        } else { Text(text).textSelection(.enabled) }
    }
}

struct MessageMediaView: View {
    let media: MessageMedia
    var body: some View {
        if media.type == "image", let encoded = media.data, let data = Data(base64Encoded: encoded), let image = NSImage(data: data) {
            Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: 620, maxHeight: 460).clipShape(RoundedRectangle(cornerRadius: 10))
        } else if let uri = media.uri, let url = URL(string: uri), url.isFileURL, let image = NSImage(contentsOf: url) {
            Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: 620, maxHeight: 460).clipShape(RoundedRectangle(cornerRadius: 10))
        } else if let uri = media.uri, let url = URL(string: uri) {
            Link(destination: url) { Label(media.name ?? url.lastPathComponent, systemImage: "doc") }
        } else { Label(media.name ?? media.mimeType ?? media.type, systemImage: media.type == "audio" ? "waveform" : "doc") }
    }
}

private enum SettingsSection: String, CaseIterable, Identifiable {
    case general = "通用"
    case runtime = "Grok Runtime"
    case relay = "中转站"
    case agent = "Agent 能力"
    case compatibility = "兼容性"
    case skills = "Skills"
    case accounts = "账号与用量"
    case archived = "已归档对话"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .runtime: return "terminal"
        case .relay: return "arrow.triangle.2.circlepath"
        case .agent: return "sparkles"
        case .compatibility: return "slider.horizontal.3"
        case .skills: return "shippingbox"
        case .accounts: return "person.crop.circle"
        case .archived: return "archivebox"
        }
    }
}

/// Settings are a first-class destination inside the main window, matching the
/// navigation model used by modern coding agents instead of a cramped form sheet.
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var updateManager: UpdateManager
    @Binding private var sidebarWidth: CGFloat
    @State private var search = ""
    @State private var selectedLaunchMode = AppLaunchMode.current.rawValue
    @FocusState private var searchFocused: Bool

    init(sidebarWidth: Binding<CGFloat> = .constant(280)) {
        _sidebarWidth = sidebarWidth
    }

    private var visibleSections: [SettingsSection] {
        guard !search.isEmpty else { return SettingsSection.allCases }
        return SettingsSection.allCases.filter {
            $0.rawValue.localizedCaseInsensitiveContains(search)
                || L10n.text($0.rawValue, language: model.settings.effectiveLanguage).localizedCaseInsensitiveContains(search)
        }
    }

    private var selection: SettingsSection {
        SettingsSection(rawValue: model.settingsPage) ?? .general
    }

    private var contextWindowTokens: Binding<Int> {
        Binding(get: { model.settings.effectiveContextWindowTokens },
                set: { model.setContextWindowTokens($0) })
    }

    private var autoCompactThreshold: Binding<Int> {
        Binding(get: { model.settings.effectiveAutoCompactThresholdPercent },
                set: { model.setAutoCompactThreshold($0) })
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Button { model.sidebarSection = .chat } label: {
                    HStack {
                        Label("返回 GrokDesk", systemImage: "chevron.left")
                            .font(GrokTypography.item(.medium))
                        Spacer()
                    }
                    .frame(maxWidth: .infinity).frame(height: 32)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 10).padding(.top, 14)

                TextField("搜索设置…", text: $search)
                    .textFieldStyle(.roundedBorder)
                    .focused($searchFocused)
                    .padding(.horizontal, 8)

                Text("设置").font(GrokTypography.metadata(.semibold)).foregroundStyle(.tertiary)
                    .padding(.horizontal, 12).padding(.top, 6)
                ForEach(visibleSections) { item in
                    Button { model.settingsPage = item.rawValue } label: {
                        Label { Text(LocalizedStringKey(item.rawValue)) } icon: { Image(systemName: item.icon) }
                            .font(GrokTypography.item)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10).frame(height: 30)
                            .background(selection == item ? Color.primary.opacity(0.08) : Color.clear,
                                        in: RoundedRectangle(cornerRadius: 7))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity)
                }
                Spacer()
            }
            .padding(8).frame(width: sidebarWidth).background(Color.grokSidebarSurface)

            SidebarResizeDivider(width: $sidebarWidth)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text(LocalizedStringKey(selection.rawValue)).font(.system(size: 25, weight: .semibold))
                    settingsContent
                }
                .frame(maxWidth: 700, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.horizontal, 48).padding(.vertical, 42)
            }
            .background(Color(nsColor: .textBackgroundColor))
        }
        .onAppear {
            // Prevent macOS from highlighting the first text field before the
            // user has expressed any intent to search.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                searchFocused = false
                NSApp.keyWindow?.makeFirstResponder(nil)
            }
        }
        .onDisappear { model.persist() }
    }

    @ViewBuilder private var settingsContent: some View {
        switch selection {
        case .general:
            SettingsGroup(title: "外观与语言") {
                SettingsRow(title: "外观", detail: "选择应用的显示模式") {
                    Picker("外观", selection: appearanceMode) {
                        Text("跟随系统").tag("system")
                        Text("浅色").tag("light")
                        Text("深色").tag("dark")
                    }.labelsHidden().frame(width: 150)
                }
                Divider()
                SettingsRow(title: "语言", detail: "切换 GrokDesk 界面语言") {
                    Picker("语言", selection: appLanguage) {
                        // Language names use endonyms so users can always recognize the switch target.
                        Text(verbatim: "简体中文").tag("zh-Hans")
                        Text(verbatim: "English").tag("en")
                    }.labelsHidden().frame(width: 150)
                }
            }
            SettingsGroup(title: "运行模式") {
                SettingsRow(title: "数据与会话", detail: "演示模式使用独立数据，不导入本机历史会话") {
                    HStack(spacing: 10) {
                        Picker("运行模式", selection: $selectedLaunchMode) {
                            Text("正常模式").tag(AppLaunchMode.normal.rawValue)
                            Text("演示模式").tag(AppLaunchMode.demo.rawValue)
                        }
                        .labelsHidden().frame(width: 140)

                        if selectedLaunchMode != model.launchMode.rawValue,
                           let mode = AppLaunchMode(rawValue: selectedLaunchMode) {
                            Button("切换并重启") { model.switchLaunchModeAndRestart(mode) }
                        }
                    }
                }
            }
            SettingsGroup(title: "软件更新") {
                SettingsToggleRow(
                    title: "自动检查更新",
                    detail: "定期从 GitHub Releases 检查 GrokDesk 新版本",
                    value: Binding(
                        get: { updateManager.automaticallyChecksForUpdates },
                        set: { updateManager.setAutomaticallyChecksForUpdates($0) }
                    )
                )
                Divider()
                SettingsToggleRow(
                    title: "自动下载并安装",
                    detail: "在后台准备更新，并在安全时完成安装",
                    value: Binding(
                        get: { updateManager.automaticallyDownloadsUpdates },
                        set: { updateManager.setAutomaticallyDownloadsUpdates($0) }
                    )
                )
                .disabled(!updateManager.automaticallyChecksForUpdates)
                Divider()
                SettingsRow(title: "当前版本", detail: "手动检查可用的新版本") {
                    HStack(spacing: 12) {
                        Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                            .foregroundStyle(.secondary)
                        Button("检查更新…") { updateManager.checkForUpdates() }
                    }
                }
            }
            SettingsGroup(title: "默认值") {
                SettingsRow(title: "默认工作目录", detail: "新建对话时文件夹选择器的默认位置") {
                    TextField("路径", text: $model.settings.defaultWorkingDirectory).frame(width: 300)
                }
                Divider()
                SettingsRow(title: "默认模型", detail: "新 Session 使用的 Grok Build 模型") {
                    TextField("模型", text: $model.settings.model).frame(width: 180)
                }
                Divider()
                SettingsRow(title: "推理强度", detail: "可在每个对话输入框右下角即时切换") {
                    Text(model.settings.reasoningEffort.capitalized).foregroundStyle(.secondary)
                }
            }
        case .runtime:
            SettingsGroup(title: "本地 Grok Build") {
                SettingsRow(title: "可执行文件", detail: "App 通过 ACP 对接这个本地 Runtime") {
                    TextField("grok 路径", text: $model.settings.grokBinary).frame(width: 320)
                }
                Divider()
                SettingsRow(title: "运行时状态", detail: "缺失时可使用 xAI 官方安装器安装最新版") {
                    HStack(spacing: 10) {
                        if GrokRuntimeInstaller.resolveBinary(configuredPath: model.settings.grokBinary) != nil {
                            Label("已安装", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        } else {
                            Text("未安装").foregroundStyle(.secondary)
                            Button("安装最新版") { model.installLatestRuntime() }
                        }
                    }
                }
                Divider()
                SettingsRow(title: "连接方式", detail: "原生 ACP：agent stdio；不内嵌终端或 TUI") {
                    Text("ACP").foregroundStyle(.secondary)
                }
                Divider()
                SettingsRow(title: "Context window", detail: "Grok Build 上下文窗口上限；默认 225k，新连接生效") {
                    HStack(spacing: 6) {
                        TextField("225000", value: contextWindowTokens, format: .number.grouping(.never))
                            .multilineTextAlignment(.trailing).frame(width: 100)
                        Text("tokens").foregroundStyle(.secondary)
                    }
                }
                Divider()
                SettingsRow(title: "自动压缩阈值", detail: "达到该使用率时调用 Grok Build 原生 auto-compaction") {
                    Stepper("\(model.settings.effectiveAutoCompactThresholdPercent)%",
                            value: autoCompactThreshold, in: 50...99, step: 1).fixedSize()
                }
            }
        case .relay:
            SettingsGroup(title: "小哈中转站") {
                SettingsRow(title: "API 地址", detail: "写入 [endpoints].models_base_url，需带 /v1") {
                    TextField("https://api.xiaohaweb.com/v1", text: $model.relayEndpoint).frame(width: 320)
                }
                Divider()
                SettingsRow(title: "API Key", detail: "写入每个 [model.*] 的 api_key，优先于 grok login 会话") {
                    SecureField("sk-...", text: $model.relayApiKey).frame(width: 320)
                }
                Divider()
                SettingsRow(title: "默认模型", detail: "写入 [models].default") {
                    TextField("grok-4.5", text: $model.relayModel).frame(width: 180)
                }
                Divider()
                SettingsRow(title: "显示名称", detail: "出现在模型 description 中") {
                    TextField("小哈AI", text: $model.relayName).frame(width: 180)
                }
                Divider()
                SettingsRow(title: "导入", detail: "备份 ~/.grok/config.toml 后写入中转站配置") {
                    Button("写入 Grok 配置") { model.importRelayConfig() }
                        .disabled(model.relayEndpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                  || model.relayApiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if let message = model.relayImportMessage {
                Text(message).font(GrokTypography.metadata).foregroundStyle(.green).textSelection(.enabled)
            }
            if let error = model.relayImportError {
                Text(error).font(GrokTypography.metadata).foregroundStyle(.red)
            }
            Text("也可从密钥页点击「导入 GrokDesk」，通过 grokdesk:// 深链直接填入。导入后运行 grok inspect，再用 /model grok-4.5。")
                .font(GrokTypography.metadata)
                .foregroundStyle(.secondary)
        case .agent:
            SettingsGroup(title: "执行与权限") {
                SettingsRow(title: "权限模式", detail: "控制文件修改和 Shell 命令的确认策略") {
                    PermissionModePicker(selection: $model.settings.permissionMode)
                }
                Divider()
                SettingsToggleRow(title: "跨会话 Memory", detail: "允许 Grok 使用本地持久化记忆", value: $model.settings.enableMemory)
                Divider()
                SettingsToggleRow(title: "Web Fetch", detail: "允许 Runtime 获取网页内容", value: $model.settings.enableWebSearch)
                Divider()
                SettingsToggleRow(title: "Plan 子 Agent", detail: "规划模式下允许启动子 Agent", value: $model.settings.enableSubagents)
            }
        case .compatibility:
            SettingsGroup(title: "Headless 兼容") {
                SettingsRow(title: "最大 Agent 轮数", detail: "仅用于 Headless 兼容模式") {
                    Stepper("\(model.settings.maxTurns)", value: $model.settings.maxTurns, in: 1...500).fixedSize()
                }
                Divider()
                SettingsRow(title: "附加 CLI 参数", detail: "只在兼容模式中追加") {
                    TextField("参数", text: $model.settings.extraArguments).frame(width: 280)
                }
            }
        case .skills:
            SkillsSettingsView()
        case .accounts:
            SettingsAccountsView()
        case .archived:
            ArchivedChatsView()
        }
    }

    private var appearanceMode: Binding<String> {
        Binding(get: { model.settings.effectiveAppearance }, set: { model.settings.appearance = $0 })
    }

    private var appLanguage: Binding<String> {
        Binding(get: { model.settings.effectiveLanguage }, set: { model.settings.language = $0 })
    }
}

private struct RelayImportConfirmSheet: View {
    @EnvironmentObject private var model: AppModel
    let payload: RelayImportPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("从网页导入配置").font(.title2.weight(.semibold))
            Text("小哈密钥页发来了一条导入请求。确认后会备份现有 config.toml，再写入中转站配置。")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("API 地址", value: payload.endpoint)
                LabeledContent("模型", value: payload.model)
                LabeledContent("名称", value: payload.name)
            }
            .font(GrokTypography.item)
            HStack {
                Spacer()
                Button("取消") { model.pendingRelayImport = nil }
                Button("确认导入") { model.importRelayConfig(payload) }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(minWidth: 460)
    }
}

private struct SettingsAccountsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var newName = ""
    private let columns = [GridItem(.adaptive(minimum: 285), spacing: 12)]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("账号").font(GrokTypography.item(.semibold))
                    Text("Session 保存在本地共享目录；账号只提供当前轮次 Token，智能路由优先使用周额度更多的健康账号。")
                        .font(GrokTypography.metadata).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await model.refreshQuotas() } } label: {
                    Label("刷新额度", systemImage: "arrow.clockwise")
                }.disabled(model.isRefreshingQuota)
            }


            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("路由方式").font(GrokTypography.item(.medium))
                        Text(LocalizedStringKey(routingDescription)).font(GrokTypography.metadata).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Picker("路由方式", selection: routingMode) {
                        Text("智能额度优先").tag("quota")
                        Text("顺序路由").tag("sequential")
                        Text("轮询").tag("roundRobin")
                        Text("固定账号").tag("fixed")
                    }.labelsHidden().frame(width: 160)
                }
                if model.settings.accountRoutingMode == "fixed" {
                    Divider()
                    HStack {
                        Text("首选账号").font(GrokTypography.item(.medium))
                        Spacer()
                        Picker("首选账号", selection: preferredAccount) {
                            Text("自动回退").tag(Optional<UUID>.none)
                            ForEach(model.accounts.filter { $0.enabled }) { account in
                                Text(account.name).tag(Optional(account.id))
                            }
                        }.labelsHidden().frame(width: 190)
                    }
                }
            }
            .padding(13)
            .background(.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.primary.opacity(0.07)))

            if model.accounts.isEmpty {
                ContentUnavailableView("尚未添加账号", systemImage: "person.crop.circle.badge.plus")
                    .frame(maxWidth: .infinity).padding(.vertical, 30)
            } else {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach($model.accounts) { $account in
                        AccountCard(account: $account)
                            .dropDestination(for: String.self) { items, _ in
                                guard let rawID = items.first,
                                      let sourceID = UUID(uuidString: rawID) else { return false }
                                model.moveAccount(sourceID, onto: account.id)
                                return true
                            }
                    }
                }
            }

            HStack(spacing: 10) {
                Image(systemName: "plus.circle").foregroundStyle(.secondary)
                TextField("账号名称，例如：工作账号", text: $newName).textFieldStyle(.plain)
                Button(model.isAddingAccount ? "等待登录…" : "添加账号") {
                    model.addAccount(name: newName.isEmpty
                        ? L10n.format("账号 %d", language: model.settings.effectiveLanguage, model.accounts.count + 1)
                        : newName)
                    newName = ""
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isAddingAccount)
            }
            .padding(13)
            .background(.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.primary.opacity(0.07)))

            if !model.loginLog.isEmpty {
                DisclosureGroup("登录日志") {
                    Text(model.loginLog).font(.caption.monospaced()).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                }.foregroundStyle(.secondary)
            }
        }
    }

    private var routingMode: Binding<String> {
        Binding(get: { model.settings.accountRoutingMode ?? "quota" }, set: {
            model.settings.accountRoutingMode = $0
            model.persist()
        })
    }

    private var preferredAccount: Binding<UUID?> {
        Binding(get: { model.settings.preferredAccountID }, set: {
            model.settings.preferredAccountID = $0
            model.persist()
        })
    }

    private var routingDescription: String {
        switch model.settings.accountRoutingMode ?? "quota" {
        case "sequential": return "严格按照下方拖拽顺序使用；不可用或额度耗尽时切换到下一个账号。"
        case "roundRobin": return "在所有已启用且已登录的账号之间依次轮换。"
        case "fixed": return "优先使用指定账号；不可用时自动回退到健康账号。"
        default: return "优先选择周额度剩余最多且状态健康的账号。"
        }
    }
}

private struct ArchivedChatsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    @State private var projectPath = "__all__"
    @State private var deleteCandidate: Conversation?

    private var archived: [Conversation] {
        model.conversations.filter { conversation in
            guard conversation.archivedAt != nil else { return false }
            let queryMatches = query.isEmpty || conversation.title.localizedCaseInsensitiveContains(query)
                || conversation.cwd.localizedCaseInsensitiveContains(query)
            return queryMatches && (projectPath == "__all__" || conversation.cwd == projectPath)
        }.sorted { ($0.archivedAt ?? .distantPast) > ($1.archivedAt ?? .distantPast) }
    }

    private var projectPaths: [String] {
        Array(Set(model.conversations.filter { $0.archivedAt != nil }.map(\.cwd))).sorted()
    }

    private var groups: [ConversationProject] {
        Dictionary(grouping: archived, by: \.cwd).map {
            ConversationProject(path: $0.key, conversations: $0.value)
        }.sorted {
            $0.displayName(language: model.settings.effectiveLanguage)
                .localizedStandardCompare($1.displayName(language: model.settings.effectiveLanguage)) == .orderedAscending
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 10) {
                TextField("搜索已归档对话", text: $query).textFieldStyle(.roundedBorder)
                Picker("文件夹", selection: $projectPath) {
                    Text("全部文件夹").tag("__all__")
                    ForEach(projectPaths, id: \.self) { path in
                        Text(WorkspacePresentation.displayName(for: path,
                                                               language: model.settings.effectiveLanguage)).tag(path)
                    }
                }.frame(width: 180)
            }

            if groups.isEmpty {
                ContentUnavailableView("没有匹配的归档对话", systemImage: "archivebox")
                    .frame(maxWidth: .infinity).padding(.top, 70)
            } else {
                ForEach(groups) { project in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Label(project.displayName(language: model.settings.effectiveLanguage), systemImage: "folder")
                                .font(GrokTypography.item(.semibold))
                            Spacer()
                            Text(L10n.format("%d 个对话", language: model.settings.effectiveLanguage,
                                             project.conversations.count))
                                .font(GrokTypography.metadata).foregroundStyle(.secondary)
                        }
                        VStack(spacing: 0) {
                            ForEach(Array(project.conversations.enumerated()), id: \.element.id) { index, conversation in
                                if index > 0 { Divider() }
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(conversation.title).font(GrokTypography.item(.medium)).lineLimit(1)
                                        if let date = conversation.archivedAt {
                                            Text(date, format: .dateTime.year().month().day().hour().minute())
                                                .font(.caption2).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    Button { deleteCandidate = conversation } label: { Image(systemName: "trash") }
                                        .buttonStyle(.plain).foregroundStyle(.secondary).help("永久删除")
                                    Button("取消归档") { model.unarchiveConversation(conversation.id) }
                                        .buttonStyle(.bordered).controlSize(.small)
                                }.padding(.horizontal, 14).padding(.vertical, 11)
                            }
                        }
                        .background(.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.primary.opacity(0.07)))
                    }
                }
            }
        }
        .alert("永久删除这个 Session？", isPresented: Binding(
            get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } }
        ), presenting: deleteCandidate) { conversation in
            Button("移到废纸篓", role: .destructive) { model.deleteConversation(conversation.id); deleteCandidate = nil }
            Button("取消", role: .cancel) { deleteCandidate = nil }
        } message: { conversation in
            Text(L10n.format("“%@” 的本地 Grok Session 将移到 macOS 废纸篓。",
                             language: model.settings.effectiveLanguage,
                             conversation.title))
        }
    }
}

private struct SettingsGroup<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(LocalizedStringKey(title)).font(GrokTypography.item(.semibold))
            VStack(spacing: 0) { content }
                .padding(.horizontal, 14)
                .background(.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(.primary.opacity(0.07)))
        }
    }
}

private struct SettingsRow<Control: View>: View {
    let title: String
    let detail: String
    @ViewBuilder let control: Control
    var body: some View {
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 3) {
                Text(LocalizedStringKey(title)).font(GrokTypography.item(.medium))
                Text(LocalizedStringKey(detail)).font(GrokTypography.metadata).foregroundStyle(.secondary)
            }
            Spacer(minLength: 20)
            control
        }
        .padding(.vertical, 13)
    }
}

private struct SettingsToggleRow: View {
    let title: String
    let detail: String
    @Binding var value: Bool
    var body: some View {
        SettingsRow(title: title, detail: detail) {
            Toggle("", isOn: $value).labelsHidden().toggleStyle(.switch).controlSize(.small)
        }
    }
}

private struct PermissionModePicker: View {
    @Binding var selection: String
    var body: some View {
        Picker("", selection: $selection) {
            Text("每次确认").tag("default")
            Text("接受编辑").tag("acceptEdits")
            Text("自动执行").tag("auto")
            Text("绕过确认（高风险）").tag("bypassPermissions")
            Text("规划模式").tag("plan")
        }.labelsHidden().frame(width: 170)
    }
}
