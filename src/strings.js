'use strict';

/**
 * Every user-facing string the shell owns, in one place.
 *
 * Scope note — this table covers **the shell's own chrome**: the native menu, the tray, the
 * window title, the right-click menu, download prompts, and the shell's error messages. It does
 * **not** and cannot cover the dsh web UI rendered inside the window: that ships from
 * `@deepseek-ai/dsh-client-ui-*` packages and carries its own, independent localization
 * (`dsh-client-locale` plus whatever Chinese each plugin author hard-coded). The shell only
 * isolates that page; it never rewrites its text.
 *
 * Language selection deliberately inspects more than `app.getLocale()`. On a machine whose
 * Windows *UI* language is English but whose regional format and language list are Chinese,
 * Chromium reports `en-US` and a naive check produces an English menu bar for a Chinese user.
 * See {@link isChineseSystem} in `menu.js`.
 *
 * Functions are used where a value is interpolated, so no string needs runtime concatenation
 * and translations stay free to reorder placeholders.
 */

/** @typedef {typeof ZH} StringTable */

const ZH = {
  // Native application menu.
  file: '文件',
  switchWorkspace: '切换工作区…',
  openLogs: '打开日志文件夹',
  openDownloads: '打开下载文件夹',
  restartBackend: '重启后端',
  browserOpen: '在浏览器中打开',
  quit: '退出',
  edit: '编辑',
  undo: '撤销',
  redo: '重做',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
  view: '视图',
  reload: '重新加载',
  forceReload: '强制重新加载',
  toggleDevTools: '开发者工具',
  resetZoom: '实际大小',
  zoomIn: '放大',
  zoomOut: '缩小',
  fullscreen: '全屏',
  help: '帮助',
  about: '关于',
  showWindow: '显示主窗口',
  trayTooltip: 'DeepSeek Harness Desktop',
  windowTitle: 'DeepSeek Harness 桌面版',

  // Shared dialog vocabulary.
  ok: '确定',
  cancel: '取消',
  close: '关闭',
  save: '保存',

  // Workspace.
  workspaceTitle: '选择工作区目录',
  workspaceButton: '使用此目录',
  workspaceChangedTitle: '工作区已切换',

  // Backend / browser hand-off.
  backendMissingTitle: '后端未运行',
  backendMissingMessage: '后端当前没有运行，无法在浏览器中打开。',

  // About.
  aboutTitle: '关于 DeepSeek Harness Desktop',
  aboutShellVersion: (version) => `外壳版本：${version}`,
  aboutElectron: (version) => `Electron：${version}`,
  aboutNode: (version) => `Node（外壳）：${version}`,
  aboutDsh: (version) => `dsh：${version}`,
  aboutPort: (port) => `后端端口：${port}`,
  aboutWorkspace: (path) => `工作区：${path}`,
  aboutDshHome: (path) => `DSH_HOME：${path}`,
  aboutSettings: (path) => `设置文件：${path}`,
  aboutLogs: (path) => `日志文件：${path}`,
  unknown: '未知',
  notRunning: '未运行',
  notInitialized: '未初始化',

  // Manual binary pickers shown on the error surface.
  pickDshTitle: '选择 dsh 的 lib/bin.js',
  pickDshButton: '使用此文件',
  pickDshFilter: 'dsh bin.js',
  pickDshWrongTitle: '文件可能不正确',
  pickDshWrongMessage: '选中的文件不是 bin.js，仍将尝试使用它。',
  pickNodeTitle: '选择 node.exe',
  pickNodeButton: '使用此文件',
  pickNodeFilter: 'node.exe',

  // Close behaviour.
  closeTitle: '关闭窗口',
  closeMessage: '要退出应用，还是最小化到托盘继续在后台运行？',
  closeDetail: '最小化到托盘后，正在执行的长任务不会被中断。',
  closeToTray: '最小化到托盘',
  closeQuit: '退出应用',
  closeRemember: '记住我的选择',

  // Downloads.
  downloadSaveTitle: (filename) => `保存 ${filename}`,
  downloadSavedTitle: '下载完成',
  downloadSavedMessage: (target) => `已保存到：\n${target}`,
  downloadSavedDetail: '可以打开所在文件夹来查看该文件。',
  downloadOpenFolder: '打开所在文件夹',
  downloadFailedTitle: '下载未完成',
  downloadFailedMessage: (filename, reason) => `${filename}：${reason}`,
  downloadCancelled: '下载已取消。',
  downloadInterrupted: '下载被中断。',

  // Right-click (context) menu.
  ctxCopyAsPlainText: '复制纯文本',
  ctxOpenLinkInBrowser: '在浏览器中打开链接',
  ctxCopyLinkAddress: '复制链接地址',
  ctxCopyImage: '复制图片',
  ctxCopyImageAddress: '复制图片地址',
  ctxInspectElement: '检查元素',

  // Splash / startup status.
  startingBackend: '正在启动后端…',
  loadingUi: '正在加载界面…',
  restartingBackend: '后端已停止，正在自动重启…',
  restartingManually: '正在重启后端…',
  restartAttempt: (attempt, seconds) => `第 ${attempt} 次尝试 · ${seconds} 秒后`,

  // Backend failure messages.
  unknownError: '未知错误',
  backendStartFailed: '后端启动失败',
  nodeMissing:
    '找不到 Node.js。请安装 Node.js，或在错误页手动指定 node.exe 的位置。',
  dshMissing:
    '找不到 dsh 入口文件（@deepseek-ai/dsh/lib/bin.js）。npx 缓存可能已被回收，请在错误页手动指定位置。',
  readyTimeout: (seconds) => `等待后端就绪超时（${seconds} 秒内未打印启动地址）。`,
  restartsExhausted: (code, attempts) =>
    `后端已停止（退出码 ${code}），并已用尽 ${attempts} 次自动重启。`,
  backendStartFailedShort: '后端启动失败',
};

const EN = {
  // Native application menu.
  file: 'File',
  switchWorkspace: 'Switch Workspace…',
  openLogs: 'Open Logs Folder',
  openDownloads: 'Open Downloads Folder',
  restartBackend: 'Restart Backend',
  browserOpen: 'Open in Browser',
  quit: 'Exit',
  edit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  view: 'View',
  reload: 'Reload',
  forceReload: 'Force Reload',
  toggleDevTools: 'Developer Tools',
  resetZoom: 'Actual Size',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  fullscreen: 'Full Screen',
  help: 'Help',
  about: 'About',
  showWindow: 'Show Main Window',
  trayTooltip: 'DeepSeek Harness Desktop',
  windowTitle: 'DeepSeek Harness Desktop',

  // Shared dialog vocabulary.
  ok: 'OK',
  cancel: 'Cancel',
  close: 'Close',
  save: 'Save',

  // Workspace.
  workspaceTitle: 'Choose Workspace Folder',
  workspaceButton: 'Use This Folder',
  workspaceChangedTitle: 'Workspace Changed',

  // Backend / browser hand-off.
  backendMissingTitle: 'Backend Not Running',
  backendMissingMessage: 'The backend is not running, so it cannot be opened in the browser.',

  // About.
  aboutTitle: 'About DeepSeek Harness Desktop',
  aboutShellVersion: (version) => `Shell version: ${version}`,
  aboutElectron: (version) => `Electron: ${version}`,
  aboutNode: (version) => `Node (shell): ${version}`,
  aboutDsh: (version) => `dsh: ${version}`,
  aboutPort: (port) => `Backend port: ${port}`,
  aboutWorkspace: (path) => `Workspace: ${path}`,
  aboutDshHome: (path) => `DSH_HOME: ${path}`,
  aboutSettings: (path) => `Settings file: ${path}`,
  aboutLogs: (path) => `Log file: ${path}`,
  unknown: 'unknown',
  notRunning: 'not running',
  notInitialized: 'not initialized',

  // Manual binary pickers shown on the error surface.
  pickDshTitle: "Choose dsh's lib/bin.js",
  pickDshButton: 'Use This File',
  pickDshFilter: 'dsh bin.js',
  pickDshWrongTitle: 'File May Be Incorrect',
  pickDshWrongMessage: 'The selected file is not bin.js; it will still be tried.',
  pickNodeTitle: 'Choose node.exe',
  pickNodeButton: 'Use This File',
  pickNodeFilter: 'node.exe',

  // Close behaviour.
  closeTitle: 'Close Window',
  closeMessage: 'Quit the app, or minimise to the tray and keep running in the background?',
  closeDetail: 'Minimising to the tray keeps long-running tasks alive.',
  closeToTray: 'Minimise to Tray',
  closeQuit: 'Quit App',
  closeRemember: 'Remember my choice',

  // Downloads.
  downloadSaveTitle: (filename) => `Save ${filename}`,
  downloadSavedTitle: 'Download Complete',
  downloadSavedMessage: (target) => `Saved to:\n${target}`,
  downloadSavedDetail: 'You can open the containing folder to find this file.',
  downloadOpenFolder: 'Open Containing Folder',
  downloadFailedTitle: 'Download Incomplete',
  downloadFailedMessage: (filename, reason) => `${filename}: ${reason}`,
  downloadCancelled: 'The download was cancelled.',
  downloadInterrupted: 'The download was interrupted.',

  // Right-click (context) menu.
  ctxCopyAsPlainText: 'Copy as Plain Text',
  ctxOpenLinkInBrowser: 'Open Link in Browser',
  ctxCopyLinkAddress: 'Copy Link Address',
  ctxCopyImage: 'Copy Image',
  ctxCopyImageAddress: 'Copy Image Address',
  ctxInspectElement: 'Inspect Element',

  // Splash / startup status.
  startingBackend: 'Starting backend…',
  loadingUi: 'Loading interface…',
  restartingBackend: 'Backend stopped; restarting automatically…',
  restartingManually: 'Restarting backend…',
  restartAttempt: (attempt, seconds) => `Attempt ${attempt} · retrying in ${seconds}s`,

  // Backend failure messages.
  unknownError: 'Unknown error',
  backendStartFailed: 'Backend failed to start',
  nodeMissing: 'Node.js was not found. Install Node.js, or choose node.exe manually on the error page.',
  dshMissing:
    'The dsh entry point (@deepseek-ai/dsh/lib/bin.js) was not found. The npx cache may have been collected — choose the location manually on the error page.',
  readyTimeout: (seconds) =>
    `Timed out waiting for the backend (no startup address printed within ${seconds}s).`,
  restartsExhausted: (code, attempts) =>
    `The backend stopped (exit code ${code}) and all ${attempts} automatic restarts were used.`,
  backendStartFailedShort: 'Backend failed to start',
};

/** Both tables must expose the same keys; the checks below run at load time. */
const LOCALES = { zh: ZH, en: EN };

/**
 * Fail fast if a language table drifts, rather than discovering a missing key as `undefined`
 * rendered into a dialog.
 *
 * Validation is deliberately shallow (key set only): a value may legitimately be a string or a
 * formatting function, so a stricter type check would be noise.
 */
function assertTablesMatch() {
  const zhKeys = Object.keys(ZH).sort();
  const enKeys = Object.keys(EN).sort();
  const missingInEn = zhKeys.filter((key) => !(key in EN));
  const missingInZh = enKeys.filter((key) => !(key in ZH));

  if (missingInEn.length > 0 || missingInZh.length > 0) {
    throw new Error(
      `locale tables out of sync — missing in en: [${missingInEn}], missing in zh: [${missingInZh}]`,
    );
  }
}

assertTablesMatch();

/* -------------------------------------------------------------------------- *
 * Language selection
 * -------------------------------------------------------------------------- */

/**
 * @template T
 * @param {() => T} fn
 * @returns {T|null}
 */
function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Collect every locale-ish signal available, so language selection is not fooled by a
 * mismatch between Chromium and Windows.
 *
 * This machine is exactly that case: the regional format is `zh-CN` but the Windows *UI*
 * language is `en-US`. Chromium reports the UI language, so `app.getLocale()` says `en-US`
 * while the user is plainly running a Chinese system — a naive check would therefore produce
 * an English menu bar and an English window title on a Chinese machine. Reading Windows' own
 * per-user language list fixes that.
 *
 * `electron` is required lazily so this module stays loadable outside an Electron process
 * (which is what the unit checks rely on).
 *
 * @returns {{chromiumLocale: string, systemLocale: string, locales: string[], windowsLanguages: string[]}}
 */
function collectLocaleSignals() {
  /** @type {string[]} */
  let windowsLanguages = [];
  try {
    const { execFileSync } = require('child_process');
    const output = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Control Panel\\International\\User Profile', '/v', 'Languages'],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );
    // Value looks like:  Languages  REG_MULTI_SZ  en-US\0zh-Hans-CN
    const match = output.match(/REG_MULTI_SZ\s+(.+)/);
    if (match) {
      windowsLanguages = match[1]
        .split(/\\0/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  } catch {
    // Registry unavailable (policy, non-Windows): fall back to the other signals.
  }

  const { app } = require('electron');
  const chromiumLocale = safeCall(() => app.getLocale()) ?? '';
  const systemLocale = safeCall(() => app.getSystemLocale()) ?? '';

  const locales = [
    process.env.DSH_DESKTOP_LANG ?? '',
    chromiumLocale,
    systemLocale,
    ...windowsLanguages,
    process.env.LANG ?? '',
    process.env.LC_ALL ?? '',
  ].filter(Boolean);

  return { chromiumLocale, systemLocale, locales, windowsLanguages };
}

/**
 * Decide the UI language from every available signal.
 *
 * Chinese wins if *any* signal says so: a user with Chinese anywhere in their language list
 * would rather see Chinese than English. `DSH_DESKTOP_LANG` overrides everything, which is what
 * the smoke tests use to exercise both tables deterministically.
 *
 * @returns {'zh'|'en'}
 */
function detectLocale() {
  const override = (process.env.DSH_DESKTOP_LANG ?? '').trim().toLowerCase();
  if (override.startsWith('zh')) {
    return 'zh';
  }
  if (override.startsWith('en')) {
    return 'en';
  }

  const { locales } = collectLocaleSignals();
  return locales.some((locale) => /^zh\b|^zh[-_]/i.test(locale)) ? 'zh' : 'en';
}

/**
 * @param {'zh'|'en'|string} [id]
 * @returns {StringTable}
 */
function getStrings(id) {
  return LOCALES[id] ?? ZH;
}

module.exports = {
  STRINGS: LOCALES,
  ZH,
  EN,
  getStrings,
  assertTablesMatch,
  detectLocale,
  collectLocaleSignals,
  safeCall,
};
