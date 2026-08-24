# GrokDesk desktop (Windows / macOS)

Cross-platform helper for this GrokDesk fork:

1. Detect whether official **Grok Build** is installed (`~/.grok/bin/grok` or `%USERPROFILE%\.grok\bin\grok.exe`).
2. One-click install from the official xAI scripts — never a third-party binary.
3. Import a 小哈 / Xiaoha relay into `config.toml`, including `grokdesk://v1/import` links from the keys page.

The original SwiftUI app under `Sources/` remains the macOS ACP workspace. This Tauri app is the Windows (and macOS) connector.

## Official Grok install

- macOS / Linux: `curl -fsSL https://x.ai/cli/install.sh | bash`
- Windows PowerShell: `irm https://x.ai/cli/install.ps1 | iex`

## Dev

```bash
cd desktop
pnpm install
pnpm tauri dev
```

## Release builds

Build on the target OS:

```bash
pnpm tauri build
```

Windows artifacts: `src-tauri/target/release/bundle/nsis/` and `msi/`  
macOS artifacts: `src-tauri/target/release/bundle/dmg/` and `macos/`
