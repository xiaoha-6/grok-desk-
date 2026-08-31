# GrokDesk

<p align="center">
  <img src="Resources/AppIcon.png" width="128" alt="GrokDesk 圖示">
</p>

<p align="center">
  <strong>讓 Grok Build 走出終端。</strong>
</p>

<p align="center">
  直接建構於 <a href="https://github.com/xai-org/grok-build">Grok Build</a> Runtime 之上的原生開源桌面工作台，提供完整 Agent 過程展示、CLI Session 共用與額度感知的多帳號路由。
</p>

<p align="center">
  <a href="README.md">簡體中文</a> · 繁體中文 · <a href="README.en.md">English</a>
</p>

> [!TIP]
> **官方推薦中轉站**：[xiaohaweb.com](https://xiaohaweb.com/) · 前往官網補充 AI 額度，記得翻牆後再訪問<br>
> **QQ 售後群**：`863407368` · 安裝、匯入金鑰、橋接連不上，進群找我們

> [!IMPORTANT]
> GrokDesk 是獨立的社群專案，與 xAI 沒有關聯，也未獲得其認可。Grok 與 Grok Build 是其各自所有者的商標。

GrokDesk 是 Grok Build 的桌面體驗層，而不是另一套通用 Agent。小哈版（`desktop/`）是 **Windows / macOS** 都能用的 Tauri 2 桌面端。檔案、Shell、Git、MCP、Skills、Plugins、Hooks、Memory、Subagent 仍由本機 Grok Build 執行。

## 官方推薦中轉站

額度用完、新電腦還沒 Key，去官網補：

- 官網：[https://xiaohaweb.com/](https://xiaohaweb.com/)（訪問需要翻牆）
- QQ 售後群：`863407368`

金鑰頁點「匯入 GrokDesk」，或打開桌面端 **設定 → 中轉站** 貼上地址和 Key。桌面頂部偶爾也會劃過推薦入口。

## 功能

- 原生會話介面，支援 Markdown、程式碼區塊、表格、連結和附件預覽。
- 按真實執行順序展示思考、檔案與搜尋、命令、Skills、Hooks、計畫、權限、互動和 Runtime 事件。
- 直接讀取並恢復本機 Grok Session，按工作資料夾組織對話，支援封存、搜尋和刪除。
- 選擇工作目錄、模型、推理強度和權限模式；支援停止、追加提示、Context Window 展示和自動上下文壓縮。
- Skills 瀏覽、啟停、斜線觸發；保留未知 ACP / `x.ai/*` 擴充事件。
- 圖片和檔案選擇、拖放、複製貼上以及詳情預覽。
- 多帳號登入、改名、啟停和排序；智慧額度優先、順序、輪詢和固定帳號路由。
- 週/月額度、本輪帳號、Context Window 和 Runtime 狀態視覺化。
- 聊天橋接：Telegram、Discord、Slack、飛書等，桌面回覆能同步出去，平台訊息也能收回來繼續聊。
- 淺色、深色和跟隨系統外觀；English、簡體中文與繁體中文介面。

## 系統需求

- **Windows 10/11**（x64）：使用本倉庫 `desktop/` 下的 Tauri 桌面端
- **macOS 14 Sonoma 或更高版本**：同一套 `desktop/` 連接器，或 SwiftUI ACP 工作台
- 可用的 Grok Build（官方 CLI），或 [小哈中轉站](https://xiaohaweb.com/) API Key

GrokDesk **不包含 Grok Build 原始碼或二進位檔**。啟動時會檢測 `~/.grok/bin/grok`（Windows 為 `%USERPROFILE%\.grok\bin\grok.exe`）、Homebrew 常見目錄和 `PATH`。若未安裝，可點擊「從官方安裝」，只拉取 xAI 官方腳本，不會靜默安裝：

```bash
curl -fsSL https://x.ai/cli/install.sh | bash   # macOS / Linux
```

```powershell
irm https://x.ai/cli/install.ps1 | iex          # Windows PowerShell
```

## 匯入小哈中轉站

在 [xiaohaweb.com](https://xiaohaweb.com/) 開通或補充額度後，金鑰頁點「匯入 GrokDesk」會打開 `grokdesk://v1/import?...`。GrokDesk 備份現有 `~/.grok/config.toml` 後寫入中轉站地址、API Key 和 Responses 模型條目。每個模型上的 `api_key` 優先於 `grok login` 工作階段。

也可在 **設定 → 中轉站** 手動貼上地址和金鑰。

Windows / 跨平台連接器：

```bash
cd desktop
pnpm install
pnpm tauri dev      # 開發
pnpm tauri build    # 在對應系統上打安裝包
```

## 下載與安裝

小哈版 Windows / macOS 安裝包在 [xiaoha-6/grok-desk- Releases](https://github.com/xiaoha-6/grok-desk-/releases)：

- Windows x64：`GrokDesk-*-windows-x64-setup.exe`
- macOS Apple Silicon：`GrokDesk-*-macos-arm64.dmg`

上游 [KAMIENDER/GrokDesk](https://github.com/KAMIENDER/GrokDesk/releases) **不會** 註冊 `grokdesk://` 匯入連結。要一鍵匯入小哈中轉站，請裝本倉庫的安裝包。

當前社群建置使用臨時簽名，尚未通過 Apple 公證。首次啟動時請按住 Control 點擊 `GrokDesk.app`，選擇「打開」，再確認 macOS 提示。

## 售後

- 推薦中轉站：[https://xiaohaweb.com/](https://xiaohaweb.com/)
- QQ 售後群：`863407368`

## 從原始碼建置

```bash
git clone https://github.com/xiaoha-6/grok-desk-.git
cd grok-desk-
./script/build_and_run.sh --verify
```

或只建置 Swift Package：

```bash
swift build -c release --product GrokDesk
```

產生的應用位於 `dist/GrokDesk.app`。開發建置使用臨時簽名，首次打開時 macOS 可能要求在「系統設定 → 隱私權與安全性」中確認。

如需產生拖曳安裝 DMG：

```bash
./scripts/package-dmg.sh
```

## 架構

```text
GrokDesk (desktop / SwiftUI)
  ├─ 本地展示狀態
  ├─ ACPBridge（透過 stdio 連接 Grok Build Agent）
  ├─ 本地 Session 與 Skill 索引
  └─ 各帳號隔離的 GROK_HOME 環境
       └─ 本機 Grok Build Runtime
```

ACP 事件名稱與原始 payload 始終是權威資料。UI 會為已知事件提供更豐富的展示，但不會丟棄新版 Runtime 上報的未知事件。

## 本地資料與隱私

GrokDesk 的 UI 狀態和附加資料保存在：

```text
~/Library/Application Support/GrokDesk/
```

Grok Build 的預設資料仍位於 `~/.grok/`。多帳號憑證保存在獨立的 `GROK_HOME` 中；Session 歷史保持本機共用。金鑰只存在本機，例如中轉站設定和 `~/.grok/bridges.json`。GrokDesk 不會把 Token、Session、Memory 或工作區檔案上傳到本倉庫。

## 參與貢獻

歡迎提交 Issue 與 Pull Request。請勿提交憑證、本地 Session 資料、建置產生的安裝包或 Grok Build 原始碼。

## 授權

[MIT](LICENSE)
