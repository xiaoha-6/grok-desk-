# GrokDesk desktop (Windows / macOS)

Cross-platform GrokDesk workspace for this fork. The Windows/Linux UI is a React workspace that follows the original Swift GrokDesk: grouped ACP tool timeline, accounts/quota, official `grok login`, skills, and a full-window settings pane.

1. Detect whether official **Grok Build** is installed (`~/.grok/bin/grok` or `%USERPROFILE%\.grok\bin\grok.exe`).
2. One-click install from the official xAI scripts — never a third-party binary.
3. Import a 小哈 / Xiaoha relay into `config.toml`, including `grokdesk://v1/import` links from the keys page.
4. Open the same ACP chat workspace as macOS GrokDesk (`grok agent --model … stdio`), not a CLI console.

The original SwiftUI app under `Sources/` remains the native macOS workspace. This Tauri app is the Windows (and Linux) desktop GUI.

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

Cross-compiling the Windows installer from macOS:

```bash
pnpm build
cd src-tauri
PATH="/usr/bin:$PATH" cargo xwin build --release --target x86_64-pc-windows-msvc --features custom-protocol
```

`--features custom-protocol` is required. Without it the exe opens `http://localhost:1420` and Windows shows ERR_CONNECTION_REFUSED.
