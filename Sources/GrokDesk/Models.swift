import Foundation

struct GrokAccount: Identifiable, Codable, Hashable {
    var id: UUID
    var name: String
    var homePath: String
    var enabled: Bool
    var createdAt: Date
    var quota: QuotaSnapshot?

    var authPath: String { URL(fileURLWithPath: homePath).appendingPathComponent("auth.json").path }
    var isLoggedIn: Bool { FileManager.default.fileExists(atPath: authPath) }
}

struct QuotaSnapshot: Codable, Hashable {
    var weeklyUsedPercent: Double?
    var weeklyRemainingPercent: Double?
    var monthlyLimit: Double?
    var monthlyUsed: Double?
    var monthlyRemaining: Double?
    var periodEnd: String?
    var checkedAt: Date
    var error: String?

    var routingScore: Double? {
        if let weeklyRemainingPercent { return weeklyRemainingPercent }
        if let monthlyRemaining { return monthlyRemaining }
        return nil
    }
}

enum MessageRole: String, Codable { case user, assistant, system, status }

struct ChatMessage: Identifiable, Codable, Hashable {
    var id = UUID()
    var role: MessageRole
    var text: String
    var thought: String?
    var createdAt = Date()
    var isStreaming = false
    var media: [MessageMedia]?
    /// Ordered ACP activity belonging to this assistant turn. Optional keeps
    /// previously persisted GrokDesk state backward-compatible.
    var events: [ChatTimelineEvent]?
}

struct ChatTimelineEvent: Identifiable, Codable, Hashable {
    var id: String
    var kind: String
    var title: String
    var status: String?
    var input: String?
    var output: String?
}

/// Keeps the durable conversation timeline focused on user-relevant actions.
/// Grok's raw update log remains the source of truth for protocol diagnostics;
/// duplicating high-frequency deltas and embedded binary blobs in state.json
/// makes every app launch and transcript switch needlessly expensive.
enum TimelinePersistencePolicy {
    private static let redundantExtensionNames: Set<String> = [
        "available commands update", "tool call delta chunk",
        "pending interaction", "interaction resolved",
        "x.ai/queue/changed", "x.ai/announcements/update",
        "model changed", "x.ai/settings/update",
        "x.ai/mcp initialized", "x.ai/mcp/servers updated"
    ]

    static func isRedundantExtension(_ name: String) -> Bool {
        redundantExtensionNames.contains(normalized(name))
    }

    static func prepare(_ events: [ChatTimelineEvent]) -> [ChatTimelineEvent] {
        events.compactMap { event in
            guard !(event.kind == "extension" && isRedundantExtension(event.title)) else { return nil }
            var compacted = event
            compacted.input = compactSerializedPayload(event.input)
            compacted.output = compactSerializedPayload(event.output)
            return compacted
        }
    }

    /// Sanitizes a structured ACP payload before it becomes timeline text.
    /// Text remains intact; only large binary `data` fields are replaced.
    static func compactJSONObject(_ value: Any) -> Any {
        if let dictionary = value as? [String: Any] {
            var result = dictionary.mapValues(compactJSONObject)
            if let type = dictionary["type"] as? String,
               ["image", "audio"].contains(type.lowercased()),
               let data = dictionary["data"] as? String,
               data.count > 4_096 {
                result["data"] = "[binary \(type.lowercased()) data omitted by GrokDesk: \(data.count) characters]"
            }
            return result
        }
        if let array = value as? [Any] { return array.map(compactJSONObject) }
        return value
    }

    private static func compactSerializedPayload(_ value: String?) -> String? {
        guard let value, value.count > 4_096,
              value.contains("\"data\""),
              let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              JSONSerialization.isValidJSONObject(object),
              let compacted = try? JSONSerialization.data(
                withJSONObject: compactJSONObject(object), options: [.prettyPrinted]
              ) else { return value }
        return String(data: compacted, encoding: .utf8) ?? value
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "_", with: " ")
            .lowercased()
    }
}

struct ContextUsage: Hashable {
    var usedTokens: Int
    var totalTokens: Int
    var compactionCount: Int = 0

    var fraction: Double {
        guard totalTokens > 0 else { return 0 }
        return min(max(Double(usedTokens) / Double(totalTokens), 0), 1)
    }
}

struct MessageMedia: Identifiable, Codable, Hashable {
    var id = UUID()
    var type: String
    var mimeType: String?
    var data: String?
    var uri: String?
    var name: String?
}

struct Conversation: Identifiable, Codable, Hashable {
    var id = UUID()
    var title = "新对话"
    var cwd: String
    var accountID: UUID?
    var grokSessionID: String?
    var messages: [ChatMessage] = []
    var createdAt = Date()
    var updatedAt = Date()
    var archivedAt: Date?

    /// A folder choice is only a draft. The conversation becomes a sidebar
    /// item after its first user turn is sent. Imported CLI sessions with a
    /// generated title are already completed conversations even before their
    /// transcript is lazily loaded by GrokDesk.
    var isReadyForSidebar: Bool {
        if messages.contains(where: { $0.role == .user }) { return true }
        return grokSessionID != nil && title != "Grok Session"
    }

    var isUnsentLocalDraft: Bool {
        grokSessionID == nil && !messages.contains(where: { $0.role == .user })
    }
}

struct AppSettings: Codable, Hashable {
    var grokBinary = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".grok/bin/grok").path
    var defaultWorkingDirectory = FileManager.default.homeDirectoryForCurrentUser.path
    var model = "grok-4.5"
    var reasoningEffort = "high"
    var permissionMode = "default"
    var maxTurns = 50
    var enableMemory = false
    var enableWebSearch = true
    var enableSubagents = true
    var extraArguments = ""
    /// Optional fields preserve decoding of settings written by older builds.
    var accountRoutingMode: String?
    var preferredAccountID: UUID?
    /// Runtime-scoped overrides. Optional fields decode state written by older
    /// app versions; nil resolves to the GrokDesk defaults below.
    var contextWindowTokens: Int?
    var autoCompactThresholdPercent: Int?
    /// Optional values preserve settings written by builds before appearance
    /// and in-app language switching were introduced.
    var language: String?
    var appearance: String?
    /// `nil` identifies settings written before first-launch onboarding existed.
    /// This lets upgrades keep their current UI while clean installs must make
    /// an explicit language choice before entering the workspace.
    var hasCompletedLanguageOnboarding: Bool?

    var effectiveContextWindowTokens: Int { max(contextWindowTokens ?? 500_000, 16_000) }
    var effectiveAutoCompactThresholdPercent: Int {
        min(max(autoCompactThresholdPercent ?? 85, 50), 99)
    }
}

struct PersistedState: Codable {
    var accounts: [GrokAccount] = []
    var conversations: [Conversation] = []
    var selectedConversationID: UUID?
    var settings = AppSettings()
    /// Optional keeps existing state files forward-compatible.
    var hiddenProjectPaths: Set<String>?
}

enum SidebarSection: Hashable { case chat, settings }

enum WorkspaceMode: String, CaseIterable { case modern = "Agent", simple = "Headless" }

struct GrokModelOption: Identifiable, Hashable {
    var id: String
    var name: String
}

struct SlashCommandItem: Identifiable, Hashable {
    var id: String { name }
    var name: String
    var description: String
    var argumentHint: String?
    var isSkill = false
    var skillPath: String?
    var skillScope: String?

    var category: String {
        if isSkill { return "Skills" }
        if ["compact", "context", "session-info", "recap", "rewind", "fork", "rename", "resume", "history", "transcript"].contains(name) { return "Session" }
        if ["flush", "dream", "memory", "remember"].contains(name) { return "Memory" }
        if ["model", "effort", "plan", "view-plan", "always-approve", "auto", "tasks", "queue", "goal"].contains(name) { return "Agent" }
        if name.contains("plugin") || name.contains("hook") || ["skills", "marketplace", "mcps"].contains(name) { return "Extensions" }
        if ["imagine", "imagine-video", "voice", "loop", "share", "usage", "privacy"].contains(name) { return "Tools" }
        return "Other"
    }

    static let fallback: [SlashCommandItem] = [
        .init(name: "compact", description: "压缩对话历史以释放上下文", argumentHint: "可选：需要保留的重点"),
        .init(name: "context", description: "查看上下文窗口使用情况", argumentHint: nil),
        .init(name: "session-info", description: "查看当前 Session 详情", argumentHint: nil),
        .init(name: "recap", description: "生成当前工作回顾", argumentHint: nil),
        .init(name: "rewind", description: "回滚到较早的对话节点", argumentHint: nil),
        .init(name: "flush", description: "立即将对话 Memory 写入磁盘", argumentHint: nil),
        .init(name: "memory", description: "浏览或启停 Memory", argumentHint: "on | off"),
        .init(name: "model", description: "切换模型", argumentHint: nil),
        .init(name: "effort", description: "切换推理强度", argumentHint: nil),
        .init(name: "plan", description: "切换规划模式", argumentHint: nil),
        .init(name: "tasks", description: "查看和管理后台任务", argumentHint: nil),
        .init(name: "queue", description: "管理消息队列", argumentHint: nil),
        .init(name: "plugins", description: "管理 Plugins", argumentHint: "list | reload | add | remove"),
        .init(name: "skills", description: "管理 Skills", argumentHint: nil),
        .init(name: "mcps", description: "管理 MCP Servers", argumentHint: nil),
        .init(name: "hooks", description: "管理 Hooks", argumentHint: nil),
        .init(name: "imagine", description: "生成图片", argumentHint: "图片描述"),
        .init(name: "usage", description: "查看额度和使用量", argumentHint: nil)
    ]
}

struct GrokSkill: Identifiable, Hashable {
    /// The command identity is the stable key used by `/name` and
    /// `x.ai/skills/toggle`; displayName is presentation-only metadata.
    var id: String { "\(scope):\(name):\(path)" }
    var name: String
    var displayName: String?
    var description: String
    var shortDescription: String?
    var path: String
    var scope: String
    var enabled: Bool
    var userInvocable: Bool
    var whenToUse: String?
    var argumentHint: String?
    var author: String?
    var compatibility: String?
    var content: String

    var title: String { displayName?.isEmpty == false ? displayName! : name }
    var invocation: String { "/\(name)" }
}

struct ToolCallRecord: Identifiable, Hashable {
    var id: String
    var title: String
    var kind: String
    var status: String
    var input: String?
    var output: String?
}

struct PlanEntryRecord: Identifiable, Hashable {
    var id: String { "\(text)-\(priority)" }
    var text: String
    var status: String
    var priority: String
}

struct PermissionOptionRecord: Identifiable, Hashable {
    var id: String
    var name: String
    var kind: String
}

struct PendingPermission: Identifiable {
    var id: String
    var conversationID: UUID
    var title: String
    var options: [PermissionOptionRecord]
}

struct AgentQuestionOption: Identifiable, Hashable {
    var id: String { label }
    var label: String
    var description: String
    var preview: String?
}

struct AgentQuestion: Identifiable, Hashable {
    var id: String { question }
    var question: String
    var options: [AgentQuestionOption]
    var multiSelect: Bool
}

struct PendingQuestionRequest: Identifiable {
    var id: String
    var conversationID: UUID
    var questions: [AgentQuestion]
    var planMode: Bool
}

struct PendingPlanApproval: Identifiable {
    var id: String
    var conversationID: UUID
    var content: String
}

struct CLIEndEvent {
    var sessionID: String?
    var stopReason: String?
    var usageDescription: String?
}
