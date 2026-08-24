import SwiftUI

extension AppSettings {
    var effectiveLanguage: String { language == "en" ? "en" : "zh-Hans" }
    var effectiveAppearance: String {
        ["system", "light", "dark"].contains(appearance ?? "") ? appearance! : "system"
    }
    var appLocale: Locale { Locale(identifier: effectiveLanguage) }
    var preferredColorScheme: ColorScheme? {
        switch effectiveAppearance {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}

/// Localizes strings that travel through model or helper APIs as `String`.
/// SwiftUI literals use Localizable.strings automatically; this helper covers
/// dynamic labels where `LocalizedStringKey` would otherwise be lost.
enum L10n {
    static func text(_ key: String, language: String) -> String {
        guard language == "en" else { return key }
        // Dynamic strings must use the same table as SwiftUI literals. Keeping
        // a second hand-maintained dictionary caused parts of one screen to
        // switch language while adjacent labels stayed in Chinese.
        if let bundle = englishBundle {
            let localized = bundle.localizedString(forKey: key, value: key, table: nil)
            if localized != key { return localized }
        }
        return englishFallback[key] ?? key
    }

    static func format(_ key: String, language: String, _ arguments: CVarArg...) -> String {
        String(format: text(key, language: language),
               locale: Locale(identifier: language == "en" ? "en" : "zh-Hans"),
               arguments: arguments)
    }

    private static let englishBundle: Bundle? = {
        guard let url = Bundle.main.url(forResource: "en", withExtension: "lproj") else { return nil }
        return Bundle(url: url)
    }()

    /// Minimal fallback for development environments that do not copy resources.
    private static let englishFallback: [String: String] = [
        "新对话": "New chat", "项目": "Projects", "设置": "Settings",
        "账号与额度": "Accounts & usage", "刷新额度": "Refresh usage",
        "添加 Grok 账号": "Add Grok account", "尚未配置": "Not configured",
        "额度待刷新": "Usage pending", "选择项目": "Choose project",
        "运行详情": "Run details", "过程": "Process", "思考过程": "Reasoning",
        "Skills 与扩展": "Skills & extensions", "文件与搜索": "Files & search",
        "上下文与记忆": "Context & memory",
        "命令与任务": "Commands & tasks", "执行计划": "Plan",
        "权限与交互": "Permissions & interactions", "运行与系统": "Runtime & system",
        "其他操作": "Other activity", "输入": "Input", "内容": "Content", "结果": "Result",
        "完成": "Completed", "失败": "Failed", "等待": "Pending", "运行中": "Running",
        "通用": "General", "Agent 能力": "Agent capabilities", "兼容性": "Compatibility",
        "中转站": "Relay", "小哈中转站": "Xiaoha relay",
        "已写入 Grok 配置": "Wrote Grok config", "已备份原配置": "Previous config backed up",
        "中转站配置已导入": "Relay config imported", "中转站配置导入失败": "Relay config import failed",
        "账号与用量": "Accounts & usage", "已归档对话": "Archived chats",
        "检查更新…": "Check for Updates…", "软件更新": "Software updates",
        "自动检查更新": "Automatically check for updates",
        "自动下载并安装": "Automatically download and install",
        "当前版本": "Current version",
        "选择 Grok 工作文件夹": "Choose a Grok workspace",
        "Grok 将在这个文件夹中读取文件、修改代码并运行工具。": "Grok will read files, modify code, and run tools in this folder.",
        "选择文件夹": "Choose folder", "已选择工作目录": "Workspace selected", "主目录": "Home",
        "运行模式": "Run mode", "数据与会话": "Data and sessions",
        "演示模式使用独立数据，不导入本机历史会话": "Demo mode uses isolated data and does not import local session history",
        "正常模式": "Normal mode", "演示模式": "Demo mode", "切换并重启": "Switch and restart",
        "运行模式已保存，请重新启动 GrokDesk": "Run mode saved. Restart GrokDesk to apply it.",
        "重新启动失败：%@": "Could not restart: %@",
        "本机 Grok CLI": "Local Grok CLI",
        "就绪": "Ready", "正在连接 Grok Agent": "Connecting to Grok Agent",
        "Agent 已连接": "Agent connected", "Grok 正在处理": "Grok is processing",
        "已追加到当前运行": "Added to current run", "额度已刷新": "Usage refreshed",
        "正在自动压缩上下文": "Auto-compacting context", "上下文已自动压缩": "Context auto-compacted",
        "自动压缩失败": "Auto-compaction failed", "工具调用": "Tool call",
        "正在准备安装最新版 Grok Build…": "Preparing to install the latest Grok Build…",
        "Grok Build 已安装": "Grok Build installed", "Grok Build 安装失败": "Grok Build installation failed",
        "Grok 请求补充信息": "Grok requests more information", "Grok 请求确认计划": "Grok requests plan approval",
        "Grok 请求执行操作": "Grok requests an action", "任务已转入后台": "Task moved to background",
        "后台任务完成": "Background task completed", "Runtime 正在重试": "Runtime is retrying",
        "正在写入 Memory": "Writing Memory", "Memory 写入完成": "Memory written",
        "本轮执行完成": "Turn completed", "Session 回顾": "Session recap",
        "加载更早消息（%@ 条）": "Load earlier messages (%@)",
        "跳到最新消息": "Jump to latest message",
        "使用情况": "Context usage",
        "Context window：%d%% 已使用（剩余 %d%%）\n%@ / %@ tokens": "Context window: %d%% used (%d%% left)\n%@ / %@ tokens"
    ]
}
