# DSH 桌面端应用（轻量 Electron 外壳）—— 交接方案

> **归档说明（由实施会话添加）**：本文件是原始交接方案，已按计划落地为本仓库。
> 为满足"Public 仓库不得包含本机绝对路径"的验收要求（见 §10 第 17 项），
> 文中所有原始绝对路径已统一替换为 `<项目根>` 占位符；除路径改写外内容未作任何修改。
>
> **本文件是会话交接文件。**
> 上一会话（cwd = `<项目根>\Knowledge Pack`）无法写入 `dsh-desktop\`（在可写工作区之外），
> 也无法用文件之外的方式把方案传递到新会话，因此把方案落在"本会话可写、新会话可读"的交集目录。
>
> **新会话请执行**：读本文件 → 创建 `<项目根>\dsh-desktop\` → 把本文件内容落地为
> `dsh-desktop\docs\PLAN.md` → 删除本文件 `Knowledge Pack\dsh-desktop-PLAN.md` → 然后从 Phase 0 继续。

---

## Phase -1 — 会话交接（已完成）

**背景**：`SessionHeader.cwd` 在会话创建时写死且不可更改，因此项目工作必须在**新会话**（cwd = `<项目根>\`）中进行。而新会话上下文为空，需要把本方案以文件形式交接过去。

**可写与可读的交集只有 `Knowledge Pack\`**（上一会话唯一可写；新会话的根 `<项目根>\` 包含它，故可读可写）。

**用户已完成**：新建 cwd = `<项目根>\` 的会话；用 `/permission` 切到**完全权限 / Full access**；要求新会话读本文件继续。

## 0. 开工门禁（新会话内第一步，全部通过才继续）

- 写临时文件并删除（确认 `<项目根>\` 可写）
- `node --version`、`git --version`（确认可执行工作区外程序）
- 任一失败即停并报告，不猜测、不绕过。

**为什么需要完全权限**：实测在 `workspace-write` 下无法启动工作区外的任何程序——`node.exe`、`tasklist.exe`、`git.exe` 全部返回 `Access is denied`。不切档位就跑不了 `npm install` / `npm start` / `git`。已核实 `dsh-base/cordis.patch.yml:204-241`：`Full access` = `sandbox: danger-full-access` + `approval: never`（同一开关）。

**安全护栏（全权模式下自我约束）**：只在 `<项目根>\dsh-desktop\` 内创建/修改文件；不写 `~/.dsh`；不执行破坏性命令。自动化冒烟测试用独立 `DSH_HOME`（见 §7），不碰真实会话与凭据。

## 1. 目标与成功标准

在 `<项目根>\dsh-desktop\` 建独立 Electron 应用，把现有 `dsh --profile web` 界面装进自己的窗口，双击即用、可常驻托盘，**完整继承**现有 `profiles/web` 环境（插件、会话、设置、凭据）。

1. 双击启动后 5 秒内（预热后）看到 dsh 界面，全程无系统浏览器弹出、无地址栏。
2. 最小化到托盘后后端继续运行（长命令重开窗口后输出连续）。
3. 从托盘退出后任务管理器无残留 `node.exe` / `pwsh.exe`。
4. 重复双击不产生第二个后端进程或第二个端口。
5. 外部链接走系统默认浏览器；输入框右键有原生剪切/复制/粘贴；会话日志导出有落盘提示。
6. 现有插件（`dshmarket`、`@linxin666/dsh-web-all`、`dsh-find-plugin`）与全部会话照常可用。
7. 日志无 `token=` 明文；Public 仓库无本机绝对路径、无任何凭据。
8. `npm run dist` 产出未签名 NSIS 安装包，安装后正常运行。

## 2. 已确认的决策

| 项 | 决策 |
|---|---|
| 路线 | A：轻量 Electron 外壳，包装现有 `dsh --profile web` |
| 集成深度 | 档位 2：独立窗口 + 单实例 + 几何持久化 + 托盘 + 原生菜单 + 关闭到托盘 + 安全收敛 + 崩溃重启与启动进度页 |
| 分发 | 仅本机自用 → 复用系统 Node 与已安装 dsh，不打包运行时、不签名、不自动更新 |
| 位置 | `<项目根>\dsh-desktop\` |
| 语言/构建 | 纯 CommonJS JavaScript + JSDoc，**零构建步骤** |
| 运行时 | 系统 `node`（与今天一致，零 native ABI 风险）；不用 Electron-as-Node |
| 窗口边框 | v1 用系统原生标题栏；自绘标题栏列为后续可选项 |
| preload | 主窗口**不使用 preload** |
| 权限 | 外壳**只做隔离、不加权限**；**绝不修改 `DSH_PERMISSION_MODE`**，原样继承给子进程 |
| 执行分工 | 我全权执行：装依赖、启动应用、自测、跑 git 与推送 |
| 仓库 | GitHub **Public**，名 `dsh-desktop` |

## 3. 事实依据（已核实）

- 启动：`dsh --profile web --no-open --port 0`。`--port 0` 由 `dsh-host-webserver` 支持（OS 分配端口）→ 彻底规避 EADDRINUSE；`--no-open` 置 `openBrowser: false`（`dsh-web-app/lib/startup.js:36-48`），后端不弹系统浏览器。
- 就绪信号：stdout 一行 `dsh web: http://127.0.0.1:<port>/?token=<token>`（`dsh-web-app/lib/index.js:194-211`；`printUrl: true` 在 `cordis.patch.yml:159` 固化）。
- 该 URL 先做 token 兑换：`frontend-static` 把根请求交给 `ctx.connection.authorizeIndex`，写 30 天有效签名 Cookie 后 302 到干净的 `/`。
- 本机 dsh 入口当前解析到 npx 缓存 `...\_npx\1e7f6d9597241db0\node_modules\.bin\dsh.cmd`（该目录在 PATH 上；`%APPDATA%\npm` 无 dsh）。**npx 缓存会被回收，路径必须运行时解析。**
- 用户 `profiles/web` bundles：`dsh-base`、`dsh-web-app`、`dshmarket`、`@linxin666/dsh-web-all`、`dsh-find-plugin`，`patchReload: live`。A 路线下原样生效。
- 原生文件夹选择器 Web 版已内置（`dsh-host-directory-picker-native`），**无需开发**。
- 官方 `apps/desktop`（无端口 + `dsh-app://`）未发布 npm（`@deepseek-ai/dsh-desktop` → 404），官方 Release 无安装包附件，故不走该路线。
- 本机 git：`%ProgramFiles%\Git\cmd\git.exe`（在 PATH）；`gh` **未安装**；`credential.helper = manager`；`init.defaultBranch = main`；`core.autocrlf = true`；`user.name` / `user.email` **未设置**。
- 沙箱语义（`dsh-sandbox-policy`）：*"the immutable `SessionHeader.cwd` recorded at creation is the root for every call in that session"*、*"A switched session keeps its immutable workspace cwd as the writable boundary"*。

## 4. UI/功能一致性说明（前端产物实测）

**界面像素级一致**：同一前端产物、同一后端树、同一套插件。

浏览器外衣必须补齐的 3 处：

| 项 | 网页 | Electron 默认 | 措施 |
|---|---|---|---|
| 右键菜单 | 输入框有剪切/复制/粘贴 | **完全没有**（dsh 前端无自定义右键菜单，`contextmenu` 仅出现在 React 内部事件表） | 主进程 `context-menu` 处理器构建原生菜单 |
| 下载 | 有下载栏/提示 | **静默落盘、零提示**（`dsh-session-log-export`、`dsh-client-ui-sidebar-documentpreview` 确实返回 `Content-Disposition: attachment`） | `session.on('will-download')` + 完成后提示与"在文件夹中显示" |
| F5 / F12 / Ctrl+± | 浏览器自带 | 无 | 视图菜单显式提供 role 项 |

已确认**无需处理**：粘贴图片（前端走 `paste` 的 `clipboardData`，未用 `navigator.clipboard.read`）；外链（前端用 `target="_blank"` + `noopener`，由 `setWindowOpenHandler` 拦下转系统浏览器）；原生目录选择器（host 侧）；"在应用中打开"（A 路线保留 HTTP 路由，故可用——这是 A 优于官方 B 之处）。

**已知且接受的差异**：前端 5 处使用 `localStorage`（面板宽度、提示已读等），桌面端为独立存储分区，与浏览器**互不同步**；会话/设置/凭据在 `$DSH_HOME`（host 侧）完全共享。浏览器扩展不生效。

## 5. 架构与数据流

```
双击 dsh-desktop.exe
   ▼
Electron 主进程 src/main.js
   ├─ 单实例锁 requestSingleInstanceLock()
   ├─ 建窗 → 立刻 loadFile(assets/splash.html)      ← 启动进度页
   ├─ settings.js 读 %APPDATA%\dsh-desktop\settings.json
   ├─ child.js:
   │     解析 node → 解析 dsh bin.js → spawn
   │     spawn(node, [bin.js,'--profile','web','--no-open','--port','0'],
   │           { cwd: workspace, windowsHide: true, env: 脱敏继承 + DSH_DESKTOP=1 })
   │     stdout 扫描 /^dsh web:\s+(https?:\/\/\S+)/ → authenticatedUrl
   │     stdout/stderr → logs/backend.log（token 打码）
   ├─ 就绪探测 GET http://127.0.0.1:<port>/ 期望 200/302/401，250ms×上限 30s
   ├─ win.loadURL(authenticatedUrl)                  ← token 兑换 + 302 到 /
   └─ 安全策略 / 右键菜单 / 下载 / 托盘 / 菜单 / 几何持久化
   ▼
子进程 node → dsh --profile web (127.0.0.1:<随机端口>)
   └─ 共用 $DSH_HOME：sessions / settings.yaml / .credentials.yaml / profiles/web
```

**工作目录语义**：dsh 以调用目录为默认 workspace root。外壳显式传 `cwd = settings.workspace`（默认 `%USERPROFILE%`）；菜单提供"切换工作区…"（原生目录选择器），切换后重启后端并记住。

**env 处理（关键）**：继承父环境后仅删除 `DSH_SESSION_ID`、`DSH_SHELL`、`DSH_WEB_URL`（避免从 dsh 会话内启动时串味），加入 `DSH_DESKTOP=1`。**`DSH_PERMISSION_MODE` 必须原样保留**——它是后端权限总开关。

## 6. 分阶段实现

### Phase 0 — 骨架 + git 与 GitHub
- 读交接文件 → 建 `dsh-desktop\` → 写 `docs\PLAN.md` → 删交接文件。
- `package.json`：`name: dsh-desktop`、`private: true`、`main: src/main.js`、`productName: "DeepSeek Harness Desktop"`；devDependencies：`electron`（取最新稳定版并锁定精确版本；官方用 `^44`，≥40 属已验证区间）、`electron-builder`；scripts：`start`/`dist`/`dist:dir`。
- `electron-builder.yml`：`appId: com.saltyice.dshdesktop`、`asar: true`、`files: [src/**, assets/**, package.json]`、`win.target: [nsis, dir]`、`nsis: { oneClick:false, perMachine:false, allowToChangeInstallationDirectory:true }`、`win.icon: assets/icon.ico`。
- `assets/icon.ico`（多尺寸）与 `assets/tray.png`：由 `@deepseek-ai/dsh-web-frontend/dist/favicon.svg` 转换生成。
- `.gitignore`：`node_modules/`、`dist/`、`out/`、`*.log`、`logs/`、`.dev-home/`、`Thumbs.db`、`Desktop.ini`、`.DS_Store`。
- `.gitattributes`（针对本机 `core.autocrlf=true` 的必要防护）：
  ```
  * text=auto eol=lf
  *.ico binary
  *.png binary
  ```
- `README.md`：启动方式、如何更换 dsh/node 位置、日志位置、打包命令、SmartScreen 说明。
- **git 初始化**（`user.name` / `user.email` 未设，必须先配；邮箱需 GitHub 已验证）：
  ```
  git config --global user.name "<名字>"
  git config --global user.email "<GitHub 已验证邮箱>"
  cd "<项目根>\dsh-desktop"
  git init -b main
  git add -A
  git commit -m "chore: scaffold dsh-desktop electron shell"
  ```
- **GitHub**：`gh` 未安装，故仓库由用户网页创建 → https://github.com/new，名 `dsh-desktop`，Public，**不要勾** README/.gitignore/license（避免分叉历史）。就绪后执行：
  ```
  git remote add origin https://github.com/<用户名>/dsh-desktop.git
  git push -u origin main
  ```
  首次推送弹 Git Credential Manager 浏览器授权，需用户点一下登录。
- **提交**：`chore: scaffold dsh-desktop electron shell`

### Phase 1 — 后端进程管理（`src/child.js`、`src/log.js`）
- **解析 node**：`settings.nodePath` → `DSH_DESKTOP_NODE` → PATH 上的 `node.exe` → `%ProgramFiles%\nodejs\node.exe`。失败 → 错误页 + nodejs.org 链接。
- **解析 dsh 入口（`lib/bin.js`）**，按序：`settings.dshBin` → `DSH_DESKTOP_DSH_BIN` → `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` → `%LOCALAPPDATA%\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js`（glob 取 mtime 最新）→ `$DSH_HOME\profiles\*\node_modules\@deepseek-ai\dsh\lib\bin.js`。命中后跑一次 `node <bin.js> --version` 校验并缓存 `dshVersion`。失败 → 错误页 + "手动选择 dsh 位置…"。
- **spawn**：`windowsHide: true`（官方要求窗口抑制放 spawn 层，不靠 PowerShell `-WindowStyle Hidden`）；`cwd = workspace`；env 见 §5。
- **URL 解析**：逐行匹配 `/^dsh web:\s+(https?:\/\/\S+)/`，兼容尾随 `(LAN: ...)`。
- **日志**：`logs/backend.log`，超 5MB 轮转 `backend.1.log`。写入前把 `([?&])token=[^&\s]+` 替换为 `$1token=***`。
- **孤儿回收**：写 `%APPDATA%\dsh-desktop\backend.json` = `{pid, port, startedAt, clean:false}`。启动时若存在且 `clean === false`，用 `tasklist /FI "PID eq <pid>" /FO CSV /NH` 确认 PID 存活且映像名为 `node.exe`，则 `taskkill /PID <pid> /T /F`，随后删除该文件。
- **退出清理**：`before-quit` 先写 `clean:true` 再 `child.kill()`；3 秒宽限后仍存活则 `taskkill /PID <pid> /T /F`（必须杀进程树，dsh 会拉起 `pwsh`/终端子进程）。
- **重启退避**：非主动退出时 1s → 2s → 4s → 8s，最多 3 次；超出停在错误页，提供"重试"与"打开日志"。
- **提交**：`feat: dsh child supervisor (resolve, spawn, url parse, logs, orphan reaper)`

### Phase 2 — 窗口与启动/错误界面（`src/windows.js`、`assets/splash.html`、`assets/error.html`）
- 单实例：`app.requestSingleInstanceLock()` 失败即 `app.quit()`；`second-instance` 中 `win.show()` + `win.focus()`。
- 主窗口：原生边框、`show:false` 直到 `ready-to-show`；`webPreferences: { nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true, allowRunningInsecureContent:false }`，**不设 preload**。
- 启动流程：先 `loadFile(splash.html)`，后端就绪后 `loadURL(authenticatedUrl)`；`did-fail-load` 静默重试一次，再失败落错误页。
- 几何持久化：`resize`/`move` 防抖 400ms 写 `settings.window`（含 `maximized`）；启动时与所有显示器工作区做相交校验，越界回落默认 1280×860 居中。
- `app.setAppUserModelId('com.saltyice.dshdesktop')`。
- 错误页：脱敏 stderr 末尾 20 行、退出码、日志路径；按钮 重试 / 打开日志 / 切换 dsh 位置 / 退出。
- **提交**：`feat: main window, splash/error surfaces, single instance, geometry`

### Phase 3 — 安全收敛 + 右键菜单 + 下载（`src/security.js`、`src/downloads.js`）
- 在 `app.on('web-contents-created')` 统一挂载，覆盖所有 webContents：
  - `setPermissionRequestHandler` / `setPermissionCheckHandler`：仅放行 `clipboard-sanitized-write`（复制按钮），其余（media/geolocation/notifications/midi/hid/serial/usb 等）一律拒绝。
  - `will-navigate`：仅允许 `origin === http://127.0.0.1:<实际绑定端口>`（端口取自启动 URL，**不写死 3080**）；其它 `http/https` → `shell.openExternal` 并 `preventDefault`；`file:`、`about:` 等直接拦截。
  - `setWindowOpenHandler`：一律 `{ action:'deny' }`，`http/https` 转 `shell.openExternal`（覆盖前端 `target="_blank"` 外链）。
  - `will-attach-webview` → `preventDefault`。
  - 断言 `webPreferences.preload` 未设置。
- **原生右键菜单**：`webContents.on('context-menu', (e, params) => ...)`，按 `params.isEditable` / `editFlags` / `selectionText` / `linkURL` / `mediaType` 构建：可编辑 → 撤销/重做/剪切/复制/粘贴/全选（role 项）；有选中文本 → 复制；在链接上 → 复制链接地址 / 在浏览器中打开（走同一外链策略）；开发模式追加 检查元素。
- **下载**：`session.on('will-download', (event, item) => ...)`，`item.on('done')` 后弹原生通知/对话框"已保存到 `<path>`" + "打开所在文件夹"；托盘与菜单提供"打开下载文件夹"。实现时验证 `item.setSaveDialogOptions()` 能否提供显式"另存为"，可用则升级。
- **提交**：`feat: security policy, native context menu, download handling`

### Phase 4 — 托盘、菜单、关闭行为（`src/menu.js`）
- 托盘：`Tray` + 上下文菜单（显示主窗口 / 在浏览器中打开 / 打开日志 / 打开下载文件夹 / 重启后端 / 退出）；双击托盘显示窗口。
- 原生菜单（按 `app.getLocale()` 选中文或英文，中文优先）：
  - 文件：切换工作区… / 打开日志文件夹 / 退出
  - 编辑：撤销、重做、剪切、复制、粘贴、全选（role 项）
  - 视图：重新加载、强制重新加载、开发者工具、实际大小、放大、缩小、全屏（补齐浏览器快捷键）
  - 帮助：关于（外壳版本 + dsh 版本 + 绑定端口）
- 关闭行为：`settings.closeBehavior ∈ {ask, tray, quit}`，默认 `ask`；`ask` 时 `dialog.showMessageBox` 提供"退出 / 最小化到托盘" + "记住我的选择"复选框。
- 托盘模式下 `window-all-closed` 不退出应用。
- **提交**：`feat: tray, native menu, close-to-tray`

### Phase 5 — 设置持久化（`src/settings.js`）
- 路径：`%APPDATA%\dsh-desktop\settings.json`（`app.setPath('userData', ...)` 显式固定，不随 productName 变动）。
- 结构：
  ```json
  { "workspace": null, "nodePath": null, "dshBin": null, "dshVersion": null,
    "closeBehavior": "ask",
    "window": { "x": null, "y": null, "width": 1280, "height": 860, "maximized": false } }
  ```
- 原子写（临时文件 + `rename`）；读取逐字段类型校验，未知字段宽容（前向兼容）。
- **提交**：`feat: settings persistence`

### Phase 6 — 打包与验收
- `$env:CSC_IDENTITY_AUTO_DISCOVERY='false'` 后 `npm run dist`，产出未签名 NSIS 安装包与 `--dir` 免安装目录。
- README 记录首次运行 SmartScreen 提示（"更多信息 → 仍要运行"）。
- **提交**：`build: packaging config and README`

### 提交节奏
每个 Phase 结束 `git add -A && git commit -m "<上表消息>"`；Phase 0 之后立即 push 建立远端，此后每个 Phase 结束 push 一次，形成可读的过程历史。

## 7. 测试策略（含独立 DSH_HOME，保护真实数据）

- 自动化冒烟测试用**独立 `DSH_HOME`**：`dsh-desktop\.dev-home`（已加入 `.gitignore`）。该目录下 `web` profile 自动从随包模板初始化，只挂 `dsh-base` + `dsh-web-app`，**不含**用户的 `dshmarket`/`@linxin666/dsh-web-all`/`dsh-find-plugin`——正好减少变量，且**完全不碰** `%USERPROFILE%\.dsh` 里的会话与凭据。
- 可自测：启动、URL 解析、窗口出现、托盘、退出后进程树清空（`tasklist`）、几何持久化、日志脱敏、右键菜单、外链拦截。
- **不能**自测：真实模型对话（独立 home 无凭据）。留用户做最终验收。
- 最终验收由用户用真实 `DSH_HOME` 双击运行一次，确认插件与会话照常。

## 8. 文件清单

```
<项目根>\dsh-desktop\
  package.json
  electron-builder.yml
  .gitignore
  .gitattributes
  README.md
  docs\PLAN.md
  assets\icon.ico          多尺寸应用图标
  assets\tray.png          托盘图标 16/32
  assets\splash.html       启动进度页（内联样式，无外部请求）
  assets\error.html        后端启动失败/已停止页
  src\main.js              生命周期、单实例、关闭行为
  src\child.js             解析 node/dsh、spawn、URL 解析、重启退避、孤儿回收
  src\settings.js          默认值、校验、原子读写
  src\security.js          导航白名单、窗口打开、权限、webview、右键菜单
  src\downloads.js         下载落盘提示与"在文件夹中显示"
  src\windows.js           BrowserWindow 创建、几何持久化与越界回落
  src\menu.js              原生菜单与托盘菜单构建
  src\log.js               日志写入、轮转、token 脱敏
```

不新增任何 dsh 侧代码；**不修改** `$DSH_HOME` 下任何文件（`profiles/web` 保持原样，插件与会话零迁移）。

## 9. 边界情况与失败模式

| 情况 | 处理 |
|---|---|
| npx 缓存被回收，dsh 路径失效 | 解析失败 → 错误页 + 手动选择位置；`--version` 缓存失效后重探 |
| node 不在 PATH | 错误页 + nodejs.org 链接 + 手动指定 nodePath |
| 30s 内未打印 URL 行 | 错误页，展示脱敏 stderr 末尾，提供重试 |
| 端口冲突 | 不可能（`--port 0` 由 OS 分配） |
| 重复启动 | 单实例锁 + `second-instance` 聚焦已有窗口 |
| Cookie 过期（30 天）或被清 | 每次启动用新 URL 兑换，天然自愈 |
| 休眠/网络切换导致 WebSocket 断开 | 由 dsh 客户端自带 50%–100% 抖动重连处理，外壳不介入 |
| Electron 被强杀，后端成孤儿 | `backend.json` + 下次启动 PID/映像名核验后 `taskkill /T /F` |
| 用户改坏 `profiles/web/cordis.patch.yml` | 后端 loud fail → 错误页显示 stderr 原因 |
| 窗口几何落在已拔掉的显示器 | 启动时工作区相交校验，越界回落居中 |
| 恶意/意外自定义协议链接 | `shell.openExternal` 仅放行 `http`/`https` |
| 输入框内快捷键失效 | 菜单包含 role 版编辑项 |
| 退出时进程树残留 | `child.kill()` + 3s 后 `taskkill /T /F` |

## 10. 验收清单

1. `npm start` → 启动页 → dsh 界面；全程无系统浏览器弹出。
2. 关闭 → 询问框 → 选"最小化到托盘" → 界面隐藏、托盘图标在；长命令重开后输出连续未中断。
3. 托盘 → 退出 → 任务管理器无残留 `node.exe`/`pwsh.exe`。
4. 应用运行时再双击一次 → 无新窗口、无新端口，仅聚焦已有窗口。
5. 托盘"在浏览器中打开" → 系统浏览器打开，Cookie 有效可直接访问。
6. 菜单"切换工作区…" → 后端重启，界面中 workspace 显示新目录。
7. 手工 `Stop-Process` 掉 node 子进程 → 显示"后端已停止"，按退避自动重启，会话历史完整。
8. `netstat -ano | findstr <port>` → 仅 `127.0.0.1` 监听，无 `0.0.0.0`。
9. 回复中外部链接 → 系统浏览器打开，应用窗口未跳转。
10. 输入框内右键 → 出现原生剪切/复制/粘贴菜单。
11. 触发会话日志导出 → 落盘后有明确提示与"在文件夹中显示"。
12. F5 / Ctrl+Shift+I / Ctrl+± / 全屏 可用。
13. `logs/backend.log` 无 `token=` 明文。
14. **用户用真实 `DSH_HOME` 双击运行** → dshmarket 与皮肤正常，会话列表完整。
15. 重启应用 → 窗口几何、工作区、关闭行为三项均被记住。
16. `npm run dist` → 安装包产出；安装后从开始菜单启动，功能同 1–3。
17. GitHub 仓库：提交历史覆盖各 Phase；`grep -r "C:\\\\Users"` 无本机绝对路径；无凭据文件。

## 11. 假设

- 仅针对 Windows x64；不做跨平台安装包。
- 复用系统已安装的 Node 与 dsh，不打包运行时，不引入代码签名与自动更新。
- dsh 版本以本机已安装者为准；外壳不校验版本上下限，仅在"关于"中显示。
- 模型系统提示仍写"通过 http://127.0.0.1:PORT 的 Web GUI 与用户交互"。该句依然为真（本地 Web GUI 渲染在应用窗口内），v1 接受；可选后续用 profile patch 插件补桌面端语境。
- 应用名与图标暂定 `DeepSeek Harness Desktop` + dsh favicon 转换图，可随时替换。
- GitHub 用户名与提交邮箱由用户在 Phase 0 提供。

## 12. 明确不做（v1）

- 不编译官方 `apps/desktop`（无端口 + `dsh-app://` 架构）。
- 不打包 Node/pnpm 运行时；不做代码签名、自动更新、`dsh://` 深链、文件关联。
- 不注入 CSS/JS 改造页面外观（自绘标题栏、隐藏页头等）。
- 不使用 preload 桥接，不向页面暴露任何 Electron API。
- 不触碰 `$DSH_HOME` 配置，不迁移插件，不修改 `DSH_PERMISSION_MODE`。
- 不提交任何凭据文件或本机绝对路径。
