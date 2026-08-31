# GrokDesk

<p align="center">
  <img src="Resources/AppIcon.png" width="128" alt="GrokDesk 图标">
</p>

<p align="center">
  <strong>让 Grok Build 走出终端。</strong>
</p>

<p align="center">
  直接构建于 <a href="https://github.com/xai-org/grok-build">Grok Build</a> Runtime 之上的原生开源桌面工作台，提供完整 Agent 过程展示、CLI Session 共享与额度感知的多账号路由。
</p>

<p align="center">
  简体中文 · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.en.md">English</a>
</p>

> [!TIP]
> **官方推荐中转站**：[xiaohaweb.com](https://xiaohaweb.com/) · 前往官网补充 AI 额度，记得魔法上网访问<br>
> **QQ 售后群**：`863407368` · 安装、导入密钥、桥接连不上，进群找我们

> [!IMPORTANT]
> GrokDesk 是独立的社区项目，与 xAI 没有关联，也未获得其认可。Grok 与 Grok Build 是其各自所有者的商标。

GrokDesk 是 Grok Build 的桌面体验层，而不是另一套通用 Agent。小哈版（`desktop/`）是 **Windows / macOS** 都能用的 Tauri 2 桌面端。文件、Shell、Git、MCP、Skills、Plugins、Hooks、Memory、Subagent 仍由本机 Grok Build 执行。

## 官方推荐中转站

额度用完、新电脑还没 Key，去官网补：

- 官网：[https://xiaohaweb.com/](https://xiaohaweb.com/)（访问需要魔法上网）
- QQ 售后群：`863407368`

密钥页点「导入 GrokDesk」，或打开桌面端 **设置 → 中转站** 粘贴地址和 Key。桌面顶部偶尔也会划过推荐入口。

## 功能

- 原生会话界面，支持 Markdown、代码块、表格、链接和附件预览。
- 按真实执行顺序展示思考、文件与搜索、命令、Skills、Hooks、计划、权限、交互和 Runtime 事件。
- 直接读取并恢复本机 Grok Session，按工作文件夹组织对话，支持归档、搜索和删除。
- 选择工作目录、模型、推理强度和权限模式；支持停止、追加提示、Context Window 展示和自动上下文压缩。
- Skills 浏览、启停、斜杠触发；保留未知 ACP / `x.ai/*` 扩展事件。
- 图片和文件选择、拖放、复制粘贴以及详情预览。
- 多账号登录、改名、启停和排序；智能额度优先、顺序、轮询和固定账号路由。
- 周/月额度、本轮账号、Context Window 和 Runtime 状态可视化。
- 聊天桥接：Telegram、Discord、Slack、飞书等，桌面回复能同步出去，平台消息也能收回来继续聊。
- 浅色、深色和跟随系统外观；English、简体中文与繁体中文界面。

## 系统要求

- **Windows 10/11**（x64）：使用本仓库 `desktop/` 下的 Tauri 桌面端
- **macOS 14 Sonoma 或更高版本**：同一套 `desktop/` 连接器，或 SwiftUI ACP 工作台
- 可用的 Grok Build（官方 CLI），或 [小哈中转站](https://xiaohaweb.com/) API Key

GrokDesk **不包含 Grok Build 源码或二进制**。启动时会检测 `~/.grok/bin/grok`（Windows 为 `%USERPROFILE%\.grok\bin\grok.exe`）、Homebrew 常见目录和 `PATH`。若未安装，可点击「从官方安装」，只拉取 xAI 官方脚本，不会静默安装：

```bash
curl -fsSL https://x.ai/cli/install.sh | bash   # macOS / Linux
```

```powershell
irm https://x.ai/cli/install.ps1 | iex          # Windows PowerShell
```

## 导入小哈中转站

在 [xiaohaweb.com](https://xiaohaweb.com/) 开通或补充额度后，密钥页点「导入 GrokDesk」会打开 `grokdesk://v1/import?...`。GrokDesk 备份现有 `~/.grok/config.toml` 后写入中转站地址、API Key 和 Responses 模型条目。每个模型上的 `api_key` 优先于 `grok login` 会话。

也可在 **设置 → 中转站** 手动粘贴地址和密钥。

Windows / 跨平台连接器：

```bash
cd desktop
pnpm install
pnpm tauri dev      # 开发
pnpm tauri build    # 在对应系统上打安装包
```

## 下载与安装

小哈版 Windows / macOS 安装包在 [xiaoha-6/grok-desk- Releases](https://github.com/xiaoha-6/grok-desk-/releases)：

- Windows x64：`GrokDesk-*-windows-x64-setup.exe`
- macOS Apple Silicon：`GrokDesk-*-macos-arm64.dmg`

上游 [KAMIENDER/GrokDesk](https://github.com/KAMIENDER/GrokDesk/releases) **不会** 注册 `grokdesk://` 导入链接。要一键导入小哈中转站，请装本仓库的安装包。

当前社区构建使用临时签名，尚未通过 Apple 公证。首次启动时请按住 Control 点击 `GrokDesk.app`，选择“打开”，再确认 macOS 提示。

## 售后

- 推荐中转站：[https://xiaohaweb.com/](https://xiaohaweb.com/)
- QQ 售后群：`863407368`

## 从源码构建

```bash
git clone https://github.com/xiaoha-6/grok-desk-.git
cd grok-desk-
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

## 架构

```text
GrokDesk (desktop / SwiftUI)
  ├─ 本地展示状态
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

Grok Build 的默认数据仍位于 `~/.grok/`。多账号凭据保存在独立的 `GROK_HOME` 中；Session 历史保持本机共享。密钥只存在本机，例如中转站配置和 `~/.grok/bridges.json`。GrokDesk 不会把 Token、Session、Memory 或工作区文件上传到本仓库。

## 参与贡献

欢迎提交 Issue 与 Pull Request。请勿提交凭据、本地 Session 数据、构建生成的安装包或 Grok Build 源码。

## 许可证

[MIT](LICENSE)
