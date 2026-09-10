# DeepSeek Harness Desktop

A lightweight Electron shell around the **existing** `dsh --profile web` UI. Double-click to
get a real desktop window instead of a browser tab — no address bar, no browser chrome, tray
support, and the backend keeps running when you close the window.

This is **route A**: the shell hosts the same backend tree, the same `profiles/web`, the same
plugins, the same sessions and the same credentials you already use from the CLI. Nothing is
migrated, and nothing under `$DSH_HOME` is modified.

---

## Requirements

| Requirement | Notes |
|---|---|
| Windows x64 | The only target. No cross-platform packaging. |
| Node.js on `PATH` | Tested with Node 24. The shell runs the CLI with **system** Node, not Electron-as-Node, so there is no native ABI risk. |
| `dsh` installed and working | Any location the resolver can find (see below). |

The shell does **not** bundle a Node runtime, code signing, or auto-update. It reuses what is
already installed.

## Running from source

```powershell
npm install
npm start
```

On first run Electron downloads its own binary (~235 MB) into
`%LOCALAPPDATA%\electron\Cache`. If you are behind a slow connection to GitHub, point it at a
mirror first:

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install
```

## How it starts

```
electron .
  └─ splash window (immediately, never a blank frame)
       └─ spawn: node <dsh>/lib/bin.js --profile web --no-open --port 0
            └─ wait for stdout: "dsh web: http://127.0.0.1:<port>/?token=<token>"
                 └─ probe the port until it answers
                      └─ loadURL(that URL)   ← token is exchanged for a cookie, then 302 → /
```

`--port 0` lets the OS pick a free port, so a port conflict is structurally impossible.
`--no-open` stops the backend from launching your browser.

## Finding Node and dsh

**Node** is resolved in this order:

1. `settings.json` → `nodePath`
2. env var `DSH_DESKTOP_NODE`
3. `node.exe` on `PATH`
4. `%ProgramFiles%\nodejs\node.exe`, then `%ProgramFiles(x86)%`

**dsh** (`@deepseek-ai/dsh/lib/bin.js`) is resolved in this order:

1. `settings.json` → `dshBin`
2. env var `DSH_DESKTOP_DSH_BIN`
3. `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`
4. `%LOCALAPPDATA%\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js` (newest first)
5. `$DSH_HOME\profiles\*\node_modules\@deepseek-ai\dsh\lib\bin.js`

The npx cache **is** garbage-collected from time to time, which is why the path is resolved on
every launch instead of being remembered. If resolution fails, the error page offers
**手动选择 dsh 位置…**.

### Pointing the shell somewhere specific

Edit `%APPDATA%\dsh-desktop\settings.json` directly, or use the error page's picker buttons:

```json
{
  "workspace": "C:\\Users\\You\\projects\\thing",
  "nodePath": "C:\\Program Files\\nodejs\\node.exe",
  "dshBin": "C:\\path\\to\\@deepseek-ai\\dsh\\lib\\bin.js",
  "dshVersion": "0.1.5-rc.1",
  "closeBehavior": "ask",
  "window": { "x": 100, "y": 60, "width": 1280, "height": 860, "maximized": false }
}
```

`workspace` is the directory the backend treats as the workspace root; changing it via
**文件 → 切换工作区…** writes this value and restarts the backend.

## Where things live

| Path | Contents |
|---|---|
| `%APPDATA%\dsh-desktop\settings.json` | Shell settings (pinned to this path, independent of the product name). |
| `%APPDATA%\dsh-desktop\logs\backend.log` | Backend stdout/stderr, **token-redacted**, rotated at 5 MB into `backend.1.log`. |
| `%APPDATA%\dsh-desktop\backend.json` | PID file used to reap an orphaned backend after a hard kill. |
| `$DSH_HOME` (`%USERPROFILE%\.dsh`) | Untouched. Sessions, credentials, plugins and `profiles/web` all live here as before. |

## Features beyond a plain browser tab

| Feature | Why it exists |
|---|---|
| **Native right-click menu** | dsh's frontend ships no context menu, so an Electron window would have none at all — including no cut/copy/paste in the composer. |
| **Download prompts** | Electron downloads land silently. Session-log export and document preview now confirm "saved to …" and offer to open the folder. |
| **View menu** | Restores F5 / Ctrl+Shift+I / Ctrl+± / full screen, which the browser provides for free. |
| **Tray** | Close-to-tray keeps long-running tasks alive; the tray icon is the way back. |
| **Window geometry memory** | Restores size and position, and falls back to a centred default if the saved monitor is gone. |
| **Orphan reaping** | If Electron is killed outright, the next launch kills the leftover backend (verified by PID **and** image name). |
| **Restart with backoff** | 1 s → 2 s → 4 s, three attempts, then an error page with a Retry button. |

### Deliberate differences from the browser

- `localStorage` is **not** shared. The desktop window has its own storage partition, so panel
  widths and dismissed hints start fresh. Sessions, settings and credentials live in
  `$DSH_HOME` on the host side and **are** shared.
- Browser extensions do not apply.
- There is no preload script and no IPC bridge. The page gets no Electron API whatsoever.

## Keyboard and menu reference

| Action | Where |
|---|---|
| Reload / force reload | 视图 |
| DevTools | 视图 → 开发者工具 |
| Zoom / actual size / full screen | 视图 |
| Cut / copy / paste / select all | 编辑, and the right-click menu in text fields |
| Restart backend | 文件 or tray |
| Switch workspace | 文件 or tray |
| Open in system browser | 文件 or tray (opens the authenticated URL) |
| Open logs / downloads folder | 文件 or tray |

## Language

The shell's own chrome is bilingual (Chinese / English) and follows the system language:

- the native menu bar and tray menu
- the OS window title
- the right-click menu
- download and close-confirmation dialogs
- startup and error messages

Detection is deliberately broader than `app.getLocale()`. Chromium reports the Windows **UI**
language, which can be English even on a Chinese machine — on such a system `app.getLocale()`
returns `en-US` while the regional format and language list are `zh-CN`, and a naive check
produces an English menu bar for a Chinese user. The shell therefore also inspects the OS
locale and the per-user language list at
`HKCU\Control Panel\International\User Profile`. **Chinese wins if any signal says Chinese.**

Force a language explicitly when testing:

```powershell
$env:DSH_DESKTOP_LANG = 'en'   # or 'zh'
```

### What the shell cannot localize

The page inside the window is the **dsh web UI**, which ships from `@deepseek-ai/dsh-client-ui-*`
packages. The shell only isolates that page; it never rewrites its text. Those packages carry
their own localization, and their Chinese coverage is uneven — `dsh-client-locale` provides only
a small shared dictionary (确定 / 取消 / 复制 / 重试 …), and each plugin author decides
independently what else to translate. Some plugins (chat, conversation) are largely Chinese;
others (settings, layout) are English-only.

So you may see mixed-language text inside the window. That is upstream's state, not a shell
defect, and changing it would mean patching npm-managed plugin bundles — which would be
overwritten on the next `dsh` update. Enable Chinese there via the app's own language setting in
**设置 → 通用**, which stores `locale.preference` in `$DSH_HOME\settings.yaml`.

## Packaging

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm run dist        # NSIS installer + unpacked dir, into dist\
npm run dist:dir    # unpacked directory only (fastest way to test the packaged app)
```

Output lands in `dist\`. The installer is **unsigned**, so the first launch shows a SmartScreen
warning: choose **更多信息 (More info) → 仍要运行 (Run anyway)**.

Regenerate the icons after changing `assets/icon.svg`:

```powershell
npm run icons
```

## Testing without touching your real profile

The shell honours two environment overrides that make a throwaway smoke test possible:

```powershell
$env:DSH_DESKTOP_USER_DATA = "C:\SaltyIce\Dya project\dsh-desktop\.dev-home\shell"
$env:DSH_HOME             = "C:\SaltyIce\Dya project\dsh-desktop\.dev-home\dsh"
npm start
```

With a fresh `DSH_HOME`, the `web` profile initialises from the bundled template and only loads
`dsh-base` + `dsh-web-app` — none of your plugins. That is intentional: it exercises the shell
while guaranteeing your sessions and credentials are untouched. It also means **you cannot test
a real model conversation there** (no credentials), which is why final acceptance is manual.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "找不到 Node.js" | Node is not on `PATH`. Install it, or pick `node.exe` from the error page. |
| "找不到 dsh 入口文件" | The npx cache was collected. Reinstall dsh, or use the error page's picker. |
| Stuck on the splash for 30 s | The backend never printed its URL. The error page shows the last 20 (redacted) log lines. |
| Window opens off-screen | Saved geometry is validated against current displays; if you still see this, delete the `window` block in `settings.json`. |
| SmartScreen blocks the installer | Expected for unsigned builds: 更多信息 → 仍要运行. |
| A second launch does nothing | By design — the single-instance lock focuses the existing window. |

## Licence

MIT. The bundled brand mark in `assets/icon.svg` is derived from the DeepSeek Harness web
frontend's own favicon; it is present only to identify the application.
