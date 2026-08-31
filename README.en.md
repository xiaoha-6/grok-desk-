# GrokDesk

<p align="center">
  <img src="Resources/AppIcon.png" width="128" alt="GrokDesk icon">
</p>

<p align="center">
  <strong>Grok Build, beyond the terminal.</strong>
</p>

<p align="center">
  A native, open-source workspace built on the <a href="https://github.com/xai-org/grok-build">Grok Build</a> runtime—with full agent visibility, shared CLI sessions, and quota-aware multi-account routing.
</p>

<p align="center">
  <a href="README.md">简体中文</a> · English
</p>

> [!TIP]
> **Recommended relay:** [xiaohaweb.com](https://xiaohaweb.com/) — top up AI quota there (a VPN is usually required).<br>
> **QQ support group:** `863407368`

> [!IMPORTANT]
> GrokDesk is an independent community project. It is not affiliated with or endorsed by xAI. Grok and Grok Build are trademarks of their respective owner.

GrokDesk is the desktop experience layer for Grok Build, not a separate general-purpose agent harness. The Xiaoha build (`desktop/`) is a Tauri 2 app for **Windows and macOS**. File operations, shell commands, Git, MCP, Skills, Plugins, Hooks, Memory, and subagents continue to run through Grok Build.

## Highlights

- Native conversations with Markdown, code blocks, tables, links, and attachment previews.
- Chronological, expandable activity for reasoning, files, searches, commands, Skills, Hooks, plans, permissions, interactions, and runtime events.
- Local Grok Session discovery and resume, grouped by workspace, with archive, search, and deletion controls.
- Workspace, model, reasoning effort, permission controls, stop/interject, context-window visibility, and automatic context compaction.
- Skill management and slash invocation, plus lossless retention of unknown ACP and `x.ai/*` extension events.
- File and image selection, drag and drop, clipboard paste, and full previews.
- Isolated multi-account authentication with renaming, ordering, health controls, and smart-usage, sequential, round-robin, or fixed-account routing.
- Weekly/monthly usage, active account, context-window, and runtime status visibility.
- Chat bridges (Telegram, Discord, Slack, Feishu, and more) so desktop replies can sync out and platform messages can come back in.
- System, light, and dark appearance with English and Simplified Chinese interfaces.

## Requirements

- **Windows 10/11** (x64): use the Tauri app in `desktop/`
- **macOS 14 Sonoma or later**: the same `desktop/` connector, or the SwiftUI ACP workspace
- Official Grok Build CLI, or a Xiaoha relay API key from [xiaohaweb.com](https://xiaohaweb.com/)

GrokDesk does **not** vendor Grok Build source or binaries. It probes `~/.grok/bin/grok` (`%USERPROFILE%\.grok\bin\grok.exe` on Windows), Homebrew paths, and `PATH`. If the runtime is missing, you can click **Install from official** to run the xAI installer — never a silent install:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash   # macOS / Linux
```

```powershell
irm https://x.ai/cli/install.ps1 | iex          # Windows PowerShell
```

## Xiaoha relay import (CC Switch-style)

Buy or top up a key at **[xiaohaweb.com](https://xiaohaweb.com/)**. The keys page **Import GrokDesk** button opens `grokdesk://v1/import?...`. GrokDesk backs up `~/.grok/config.toml`, then writes the relay base URL, API-key auth, and Responses-backed `[model.*]` entries. Per-model `api_key` wins over a `grok login` session.

```bash
cd desktop
pnpm install
pnpm tauri dev
pnpm tauri build    # produce NSIS/MSI on Windows, DMG on macOS
```

## Download and install

This Xiaoha fork publishes Windows and macOS installers at [xiaoha-6/grok-desk- Releases](https://github.com/xiaoha-6/grok-desk-/releases):

- Windows x64: `GrokDesk-*-windows-x64-setup.exe`
- macOS Apple Silicon: `GrokDesk-*-macos-arm64.dmg`

The original Apple Silicon ACP workspace DMG from [KAMIENDER/GrokDesk](https://github.com/KAMIENDER/GrokDesk/releases) does **not** register `grokdesk://` import links. Use this fork if you want one-click Xiaoha relay import.

After the first installation, GrokDesk checks GitHub Releases through Sparkle. You can check manually from **GrokDesk → Check for Updates…**, or configure automatic checks and background downloads in **Settings → General → Software updates**. Update archives are authenticated with a dedicated Sparkle EdDSA signature before installation.

The current community build is ad-hoc signed and has not been notarized by Apple. On first launch, Control-click `GrokDesk.app`, choose **Open**, and confirm the macOS prompt. A notarized, warning-free distribution requires an Apple Developer ID certificate, which is not currently available to this project.

## Support

- Official recommended relay: [https://xiaohaweb.com/](https://xiaohaweb.com/)
- QQ after-sales group: `863407368`

## Build from source

```bash
git clone https://github.com/xiaoha-6/grok-desk-.git
cd grok-desk-
./script/build_and_run.sh --verify
```

To build only the Swift package:

```bash
swift build -c release --product GrokDesk
```

The packaged application is written to `dist/GrokDesk.app`. Development builds use ad-hoc signing, so macOS may ask you to confirm the first launch in **System Settings → Privacy & Security**.

To create the drag-to-install DMG:

```bash
./scripts/package-dmg.sh
```

Maintainers can create the DMG, Sparkle ZIP, and signed `appcast.xml` together with:

```bash
./scripts/package-release.sh
```

Pushing a version tag such as `v0.1.3` runs the release workflow. The repository must contain a `SPARKLE_PRIVATE_KEY` Actions secret exported from Sparkle's `generate_keys` tool; the private key must never be committed.

## Record a demo

Launch GrokDesk with a fresh, isolated demo profile and record a privacy-safe
video or GIF:

```bash
./scripts/record-demo.sh --gif
```

The normal GrokDesk profile and Grok Build Sessions are not modified. See the
[demo recording guide](docs/DEMO_RECORDING.md) for monitor selection, the
recommended walkthrough, and privacy notes. [中文说明](docs/DEMO_RECORDING.zh-CN.md)

## Architecture

```text
GrokDesk (SwiftUI)
  ├─ AppModel and local presentation state
  ├─ ACPBridge (Grok Build agent over stdio)
  ├─ local Session and Skill indexes
  └─ isolated per-account GROK_HOME environments
       └─ local Grok Build runtime
```

ACP event names and raw payloads remain authoritative. UI adapters provide richer presentation for known event types without discarding unknown events introduced by newer runtime versions.

## Local data and privacy

GrokDesk stores its UI state and supplemental data in:

```text
~/Library/Application Support/GrokDesk/
```

Grok Build keeps its default data under `~/.grok/`. Multi-account credentials live in isolated `GROK_HOME` directories managed by GrokDesk. Session history remains local and shared rather than being bound to one account, so another healthy account can continue the same Session. GrokDesk does not upload tokens, Sessions, Memory, or workspace files to this repository.

## Contributing

Issues and pull requests are welcome. Please keep credentials, local Session data, generated application bundles, and Grok Build source out of commits.

## License

[MIT](LICENSE)
