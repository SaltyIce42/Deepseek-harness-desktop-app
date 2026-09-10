'use strict';

/**
 * Native application menu and system tray.
 *
 * The browser gives the dsh UI a pile of affordances for free — reload, devtools, zoom, print
 * — that a bare Electron window does not have. The View menu restores the ones that matter so
 * the desktop build is not a downgrade.
 *
 * This module also owns **language selection** for the whole shell; the strings themselves live
 * in `strings.js`.
 *
 * The tray is what makes "close to tray" meaningful: it is the only way back to a window that
 * has been hidden while the backend keeps running.
 */

const { Menu, Tray, app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const { STRINGS, collectLocaleSignals, detectLocale, getStrings } = require('./strings');

/**
 * Ask Chromium to load the Simplified-Chinese locale pack.
 *
 * Electron exposes `--lang` as a command-line switch. It must be appended **before** `ready`,
 * because Chromium consumes the switch during browser-process startup; calling it later has no
 * effect. Without this the shell's menu labels would be translated but Chromium's own surfaces
 * would stay English.
 */
function applyLanguageSwitch() {
  if (detectLocale() !== 'zh') {
    return;
  }
  try {
    app.commandLine.appendSwitch('lang', 'zh-CN');
  } catch {
    // Not fatal: the shell's own menus are still translated.
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
   * @param {import('./strings').StringTable} options.strings Localized UI strings.
   */
  constructor({ actions, log, assetsDir, mode, strings }) {
    this.actions = actions;
    this.log = log;
    this.assetsDir = assetsDir;
    this.mode = mode;
    this.strings = strings ?? getStrings(detectLocale());
    /** @type {Tray|null} */
    this.tray = null;
  }

  /** Install the application menu, replacing any default Electron menu. */
  installMenu() {
    const s = this.strings;
    const a = this.actions;

    this.log.write(
      `ui language: ${detectLocale()} (chromium=${collectLocaleSignals().chromiumLocale})`,
    );

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
   * Add the @2x icon as a second representation so Electron can pick per scale factor instead
   * of blurring a 16px icon on a 200% display.
   *
   * @returns {import('electron').NativeImage|null}
   */
  loadTrayIcon() {
    const standard = path.join(this.assetsDir, 'tray.png');
    const hidpi = path.join(this.assetsDir, 'tray@2x.png');

    if (!fs.existsSync(standard)) {
      return null;
    }

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

module.exports = { AppChrome, applyLanguageSwitch, STRINGS };
