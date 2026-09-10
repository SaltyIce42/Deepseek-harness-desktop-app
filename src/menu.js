'use strict';

/**
 * Native application menu and system tray.
 *
 * The browser gives the dsh UI a pile of affordances for free — reload, devtools, zoom, print
 * — that a bare Electron window does not have. The View menu restores the ones that matter so
 * the desktop build is not a downgrade. Menu labels are Chinese when the OS locale is Chinese,
 * falling back to English otherwise.
 *
 * The tray is what makes "close to tray" meaningful: it is the only way back to a window that
 * has been hidden while the backend keeps running.
 */

const { Menu, Tray, app, nativeImage, shell } = require('electron');
const fs = require('fs');
const path = require('path');

/** Menu/UI strings keyed by locale bucket. */
const STRINGS = {
  zh: {
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
  },
  en: {
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
  },
};

/**
 * Pick the Chinese or English string table from the OS locale.
 *
 * @returns {typeof STRINGS.zh}
 */
function pickStrings() {
  try {
    return app.getLocale().toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en;
  } catch {
    return STRINGS.zh;
  }
}

class AppChrome {
  /**
   * @param {object} options
   * @param {object} options.actions Callbacks wired by `main.js`.
   * @param {() => void} options.actions.showWindow
   * @param {() => void} options.actions.switchWorkspace
   * @param {() => void} options.actions.openLogs
   * @param {() => void} options.actions.openDownloads
   * @param {() => void} options.actions.restartBackend
   * @param {() => void} options.actions.openInBrowser
   * @param {() => void} options.actions.about
   * @param {() => void} options.actions.quit
   * @param {import('./log').BackendLog} options.log
   * @param {string} options.assetsDir
   * @param {{isDevelopment: boolean}} options.mode
   */
  constructor({ actions, log, assetsDir, mode }) {
    this.actions = actions;
    this.log = log;
    this.assetsDir = assetsDir;
    this.mode = mode;
    this.strings = pickStrings();
    /** @type {Tray|null} */
    this.tray = null;
  }

  /** Install the application menu, replacing any default Electron menu. */
  installMenu() {
    const s = this.strings;
    const a = this.actions;

    /** @type {import('electron').MenuItemConstructorOptions[]} */
    const template = [
      {
        label: s.file,
        submenu: [
          { label: s.switchWorkspace, click: () => a.switchWorkspace() },
          { type: 'separator' },
          { label: s.restartBackend, click: () => a.restartBackend() },
          { label: s.browserOpen, click: () => a.openInBrowser() },
          { type: 'separator' },
          { label: s.openLogs, click: () => a.openLogs() },
          { label: s.openDownloads, click: () => a.openDownloads() },
          { type: 'separator' },
          { label: s.quit, accelerator: 'Alt+F4', click: () => a.quit() },
        ],
      },
      {
        label: s.edit,
        submenu: [
          { role: 'undo', label: s.undo },
          { role: 'redo', label: s.redo },
          { type: 'separator' },
          { role: 'cut', label: s.cut },
          { role: 'copy', label: s.copy },
          { role: 'paste', label: s.paste },
          { type: 'separator' },
          { role: 'selectAll', label: s.selectAll },
        ],
      },
      {
        label: s.view,
        submenu: [
          { role: 'reload', label: s.reload },
          { role: 'forceReload', label: s.forceReload },
          { role: 'toggleDevTools', label: s.toggleDevTools },
          { type: 'separator' },
          { role: 'resetZoom', label: s.resetZoom },
          { role: 'zoomIn', label: s.zoomIn },
          { role: 'zoomOut', label: s.zoomOut },
          { type: 'separator' },
          { role: 'togglefullscreen', label: s.fullscreen },
        ],
      },
      {
        label: s.help,
        submenu: [{ label: s.about, click: () => a.about() }],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  /**
   * Create the tray icon and its context menu.
   *
   * @returns {Tray|null} Null when no icon could be loaded (e.g. packaged asset missing).
   */
  installTray() {
    if (this.tray !== null) {
      return this.tray;
    }

    const icon = this.loadTrayIcon();
    if (icon === null) {
      this.log.write('tray icon missing; running without a tray', { source: 'warn' });
      return null;
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip(this.strings.trayTooltip);
    // Double-clicking the tray is the muscle-memory way back to a hidden window.
    this.tray.on('double-click', () => this.actions.showWindow());
    this.tray.setContextMenu(this.buildTrayMenu());
    return this.tray;
  }

  /**
   * Prefer the @2x icon when the display scale factor asks for it; `nativeImage` does not
   * upscale for us.
   *
   * @returns {import('electron').NativeImage|null}
   */
  loadTrayIcon() {
    const standard = path.join(this.assetsDir, 'tray.png');
    const hidpi = path.join(this.assetsDir, 'tray@2x.png');

    if (!fs.existsSync(standard)) {
      return null;
    }

    // `@2x` is a filename convention Electron understands: adding both representations to one
    // image lets it choose per scale factor instead of blurring a 16px icon on a 200% display.
    const image = nativeImage.createFromPath(standard);
    if (fs.existsSync(hidpi)) {
      image.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(hidpi) });
    }
    return image;
  }

  /** @returns {import('electron').Menu} */
  buildTrayMenu() {
    const s = this.strings;
    const a = this.actions;
    return Menu.buildFromTemplate([
      { label: s.showWindow, click: () => a.showWindow() },
      { type: 'separator' },
      { label: s.restartBackend, click: () => a.restartBackend() },
      { label: s.browserOpen, click: () => a.openInBrowser() },
      { type: 'separator' },
      { label: s.switchWorkspace, click: () => a.switchWorkspace() },
      { label: s.openLogs, click: () => a.openLogs() },
      { label: s.openDownloads, click: () => a.openDownloads() },
      { type: 'separator' },
      { label: s.quit, click: () => a.quit() },
    ]);
  }

  /** Tear the tray down so the icon does not linger after exit. */
  destroyTray() {
    if (this.tray !== null) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { AppChrome, pickStrings, STRINGS };
