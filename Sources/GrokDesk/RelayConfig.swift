import Foundation

struct RelayImportPayload: Identifiable, Equatable {
    var id = UUID()
    var endpoint: String
    var apiKey: String
    var model: String
    var name: String

    static let defaultModel = "grok-4.5"
    static let defaultName = "小哈AI"

    static func parse(_ url: URL) -> RelayImportPayload? {
        guard url.scheme?.lowercased() == "grokdesk" else { return nil }
        let host = url.host?.lowercased() ?? ""
        let path = url.path.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let isImport = (host == "v1" && path == "import")
            || path == "v1/import"
            || url.absoluteString.lowercased().contains("://v1/import")
        guard isImport else { return nil }

        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ names: [String]) -> String {
            for name in names {
                if let found = items.first(where: { $0.name == name })?.value, !found.isEmpty {
                    return found
                }
            }
            return ""
        }

        let endpoint = normalizedEndpoint(value(["endpoint", "baseUrl", "base_url", "homepage"]))
        let apiKey = value(["apiKey", "api_key", "key"])
        guard !endpoint.isEmpty, !apiKey.isEmpty else { return nil }
        let model = value(["model"])
        let name = value(["name", "provider", "providerName"])
        return RelayImportPayload(
            endpoint: endpoint,
            apiKey: apiKey,
            model: model.isEmpty ? defaultModel : model,
            name: name.isEmpty ? defaultName : name
        )
    }
}

enum RelayConfigWriter {
    static func grokHome() -> URL {
        if let override = ProcessInfo.processInfo.environment["GROK_HOME"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".grok", isDirectory: true)
    }

    static func render(_ payload: RelayImportPayload) -> String {
        let endpoint = tomlEscape(normalizedEndpoint(payload.endpoint))
        let apiKey = tomlEscape(payload.apiKey)
        let provider = tomlEscape(payload.name.isEmpty ? RelayImportPayload.defaultName : payload.name)
        let model = payload.model.isEmpty ? RelayImportPayload.defaultModel : payload.model
        let listURL = tomlEscape(normalizedEndpoint(payload.endpoint) + "/models")
        let models: [(String, String, Int)] = [
            ("grok-4.5", "Grok 4.5", 500_000),
            ("grok-build-0.1", "Grok Build", 256_000),
            ("grok-4.20-multi-agent-0309", "Grok 4.20 Multi Agent", 1_000_000),
            ("grok-4.3", "Grok 4.3", 1_000_000),
            ("grok-composer-2.5-fast", "Grok Composer 2.5 Fast", 500_000)
        ]

        var body = """
        # Managed by GrokDesk — 小哈中转站 API-key 接入。
        # 原文件会在写入前备份为 config.toml.bak-grokdesk-*。
        # 文本模型使用 Responses（POST /v1/responses）。
        # 保存后可运行: grok inspect

        [endpoints]
        models_base_url = "\(endpoint)"
        models_list_url = "\(listURL)"
        xai_api_base_url = "\(endpoint)"
        cli_chat_proxy_base_url = "\(endpoint)"

        [auth]
        preferred_method = "api_key"

        """
        var written = Set<String>()
        for (id, display, window) in models {
            body += modelBlock(id: id, display: display, provider: provider, apiKey: apiKey, window: window)
            written.insert(id)
        }
        if !written.contains(model) {
            body += modelBlock(id: model, display: model, provider: provider, apiKey: apiKey, window: 500_000)
        }
        body += """
        [models]
        default = "\(tomlEscape(model))"
        web_search = "grok-4.5"
        image_description = "grok-4.5"

        [session]
        auto_compact_threshold_percent = 80

        [features]
        image_gen = true
        video_gen = true
        image_gen_model_override = "grok-imagine-image-quality"
        image_edit_model_override = "grok-imagine-edit"
        """
        return body
    }

    static func write(_ payload: RelayImportPayload) throws -> (configPath: URL, backupPath: URL?) {
        let home = grokHome()
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let config = home.appendingPathComponent("config.toml")
        var backup: URL?
        if FileManager.default.fileExists(atPath: config.path) {
            let stamp = Int(Date().timeIntervalSince1970)
            let dest = home.appendingPathComponent("config.toml.bak-grokdesk-\(stamp)")
            try FileManager.default.copyItem(at: config, to: dest)
            backup = dest
        }
        try render(payload).write(to: config, atomically: true, encoding: .utf8)
        return (config, backup)
    }

    private static func modelBlock(id: String, display: String, provider: String, apiKey: String, window: Int) -> String {
        let idEsc = tomlEscape(id)
        let displayEsc = tomlEscape(display)
        return """
        [model."\(idEsc)"]
        model = "\(idEsc)"
        name = "\(displayEsc)"
        description = "\(provider) · Responses"
        api_key = "\(apiKey)"
        api_backend = "responses"
        context_window = \(window)
        supports_backend_search = true

        """
    }
}

func normalizedEndpoint(_ endpoint: String) -> String {
    let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard !trimmed.isEmpty else { return "" }
    if trimmed.lowercased().hasSuffix("/v1") { return trimmed }
    return trimmed + "/v1"
}

func tomlEscape(_ value: String) -> String {
    value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
}
