# GrokDesk

<p align="center">
  <img src="Resources/AppIcon.png" width="128" alt="GrokDesk 图标">
</p>

<p align="center">
  <strong>让 Grok Build 走出终端。</strong>
</p>

<p align="center">
  直接构建于 <a href="https://github.com/xai-org/grok-build">Grok Build</a> Runtime 之上的原生开源 macOS 工作台，提供完整 Agent 过程展示、CLI Session 共享与额度感知的多账号路由。
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

> [!IMPORTANT]
> GrokDesk 是独立的社区项目，与 xAI 没有关联，也未获得其认可。Grok 与 Grok Build 是其各自所有者的商标。

GrokDesk 是 Grok Build 的原生 macOS 体验层，而不是另一套通用 Agent Harness。它将本机 Runtime 的 ACP/JSON-RPC 能力呈现为现代化的 SwiftUI 桌面界面，同时保留 Grok Build 的 Session、工具与扩展语义。它不是内嵌终端，也不会重新实现 Grok Agent；文件、Shell、Git、MCP、Skills、Plugins、Hooks、Memory、Subagent 等能力仍由本机 Grok Build 执行。

## 功能

- 原生 macOS 会话界面，支持 Markdown、代码块、表格、链接和附件预览。
- 按真实执行顺序展示思考、文件与搜索、命令、Skills、Hooks、计划、权限、交互和 Runtime 事件；相邻同类事件可折叠，原始详情可查看。
- 直接读取并恢复本机 Grok Session，按工作文件夹组织对话，支持归档、搜索和删除。
- 选择工作目录、模型、推理强度和权限模式，并支持停止、追加提示、Context Window 展示和自动上下文压缩。
- Skills 浏览、启停、详情查看和斜杠触发；保留未知 ACP / `x.ai/*` 扩展事件，避免新能力被旧 UI 静默丢弃。
- 图片和文件选择、拖放、复制粘贴以及详情预览。
- 多账号登录、改名、启停和拖拽排序；支持智能额度优先、顺序、轮询和固定账号路由。
- 周/月额度、本轮账号、Context Window 和 Runtime 状态可视化。
- 浅色、深色和跟随系统外观；English 与简体中文界面。

## 系统要求

- **Windows 10/11**（x64）：使用本仓库 `desktop/` 下的 Tauri 桌面端
- **macOS 14 Sonoma 或更高版本**：SwiftUI ACP 工作台，或同一套 `desktop/` 连接器
- 可用的 Grok Build（官方 CLI）或小哈中转站 API Key

GrokDesk **不包含 Grok Build 源码或二进制**。启动时会检测 `~/.grok/bin/grok`（Windows 为 `%USERPROFILE%\.grok\bin\grok.exe`）、Homebrew 常见目录和 `PATH`。若未安装，可点击「从官方安装」，只拉取 xAI 官方脚本，不会静默安装：

```bash
curl -fsSL https://x.ai/cli/install.sh | bash   # macOS / Linux
```

```powershell
irm https://x.ai/cli/install.ps1 | iex          # Windows PowerShell
```

## 小哈中转站（像 CC Switch 一样导入）

密钥页点击「导入 GrokDesk」会打开 `grokdesk://v1/import?...`。GrokDesk 备份现有 `~/.grok/config.toml` 后写入：

- `[endpoints].models_base_url` → 小哈 `/v1`
- `[auth].preferred_method = "api_key"`
- 每个 `[model.*]` 使用 `api_backend = "responses"` 和内联 `api_key`（优先于 `grok login` 会话）

也可在 **设置 → 中转站**（macOS Swift 版）或桌面端右侧表单手动粘贴地址和密钥。

Windows / 跨平台连接器：

```bash
cd desktop
pnpm install
pnpm tauri dev      # 开发
pnpm tauri build    # 在对应系统上打安装包
```

## 下载与安装

小哈 fork 的 Windows / macOS 安装包发布在 [xiaoha-6/grok-desk- Releases](https://github.com/xiaoha-6/grok-desk-/releases)：

- Windows x64：`GrokDesk-*-windows-x64-setup.exe`
- macOS Apple Silicon：`GrokDesk-*-macos-arm64.dmg`

上游 [KAMIENDER/GrokDesk](https://github.com/KAMIENDER/GrokDesk/releases) 的 ACP 工作台 **不会** 注册 `grokdesk://` 导入链接。要用密钥页一键导入小哈中转站，请安装本 fork。

首次安装后，GrokDesk 会通过 Sparkle 从 GitHub Releases 检查新版本。可以在 **GrokDesk → 检查更新…** 手动检查，也可以在 **设置 → 通用 → 软件更新** 中启用定期检查和后台自动下载安装。更新压缩包在安装前会验证项目专用的 Sparkle EdDSA 签名。

当前社区构建使用临时签名，尚未通过 Apple 公证。首次启动时请按住 Control 点击 `GrokDesk.app`，选择“打开”，再确认 macOS 提示。要实现没有 Gatekeeper 警告的直接安装，需要 Apple Developer ID 证书；本项目目前尚未配置该证书。

## 从源码构建

```bash
git clone https://github.com/KAMIENDER/GrokDesk.git
cd GrokDesk
./script/build_and_run.sh --verify
```

或只构建 Swift Package：

```bash
swift build -c release --product GrokDesk
```

生成的应用位于 `dist/GrokDesk.app`。开发构建使用临时签名，首次打开时 macOS 可能要求在“系统设置 → 隐私与安全性”中确认。

如需生成拖拽安装 DMG：

```bash
./scripts/package-dmg.sh
```

维护者可以同时生成 DMG、Sparkle 更新 ZIP 和已签名的 `appcast.xml`：

```bash
./scripts/package-release.sh
```

推送 `v0.1.3` 这样的版本标签会触发 GitHub Release 工作流。仓库需要配置由 Sparkle `generate_keys` 工具导出的 `SPARKLE_PRIVATE_KEY` Actions Secret；私钥不得提交到仓库。

## 录制演示

使用全新的隔离演示档案启动 GrokDesk，并录制隐私安全的视频或 GIF：

```bash
./scripts/record-demo.sh --gif
```

脚本不会修改正常的 GrokDesk 档案或 Grok Build Session。显示器选择、推荐
演示流程和隐私注意事项请查看[演示录制说明](docs/DEMO_RECORDING.zh-CN.md)。
[English guide](docs/DEMO_RECORDING.md)

## 架构

```text
GrokDesk (SwiftUI)
  ├─ AppModel 与本地展示状态
  ├─ ACPBridge（通过 stdio 连接 Grok Build Agent）
  ├─ 本地 Session 与 Skill 索引
  └─ 各账号隔离的 GROK_HOME 环境
       └─ 本机 Grok Build Runtime
```

ACP 事件名称与原始 payload 始终是权威数据。UI 会为已知事件提供更丰富的展示，但不会丢弃新版 Runtime 上报的未知事件。

## 本地数据与隐私

GrokDesk 的 UI 状态和附加数据保存在：

```text
~/Library/Application Support/GrokDesk/
```

Grok Build 的默认数据仍位于 `~/.grok/`。多账号凭据保存在 GrokDesk 为每个账号建立的独立 `GROK_HOME` 中；Session 历史保持本机共享，不绑定某个账号，因此健康账号可以继续同一个 Session。GrokDesk 不会将 Token、Session、Memory 或工作区文件上传到本项目仓库。

## 参与贡献

欢迎提交 Issue 与 Pull Request。请勿提交凭据、本地 Session 数据、构建生成的 App Bundle 或 Grok Build 源码。

## 许可证

[MIT](LICENSE)
