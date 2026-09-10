'use strict';

/**
 * Main window lifecycle: creation, the startup/error surfaces, and window geometry that
 * survives restarts.
 *
 * The window keeps the *most restrictive* `webPreferences` Electron offers: no preload, no
 * Node in the renderer, context isolation on, sandbox on. The shell talks to the page in one
 * direction only, through query parameters on `file://` URLs, and receives instructions back
 * through the custom `dsh-desktop://` scheme. That asymmetry is deliberate — a preload bridge
 * would be a standing attack surface for zero benefit here.
 */

const { BrowserWindow, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');

/** Default size when there is no usable saved geometry. */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 860;

/**
 * How many pixels of the window must remain on a work area for saved geometry to be honoured.
 * Without this check, a window saved on a monitor that is no longer attached would open
 * entirely off-screen and look like a failed launch.
 */
const MIN_VISIBLE_PX = 120;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

class WindowManager {
  /**
   * @param {object} options
   * @param {import('./settings').Settings} options.settings
   * @param {import('./log').BackendLog} options.log
   * @param {string} options.assetsDir
   */
  constructor({ settings, log, assetsDir }) {
    this.settings = settings;
    this.log = log;
    this.assetsDir = assetsDir;
    /** @type {BrowserWindow|null} */
    this.win = null;
    /** @type {NodeJS.Timeout|null} */
    this.geometryTimer = null;
    /** Set by `main.js` to handle `dsh-desktop://` links from the error page. */
    this.actionHandler = null;
    /** Suppresses geometry saving while we are programmatically resizing/moving. */
    this.applyingGeometry = false;
  }

  /**
   * Build (or return) the single main window.
   *
   * @returns {BrowserWindow}
   */
  create() {
    if (this.win !== null && !this.win.isDestroyed()) {
      return this.win;
    }

    const bounds = this.resolveGeometry();

    /** @type {import('electron').BrowserWindowConstructorOptions} */
    const options = {
      width: bounds.width,
      height: bounds.height,
      minWidth: 720,
      minHeight: 520,
      show: false,
      backgroundColor: '#1b1c1d',
      // Native title bar for v1: no custom chrome, no window controls to reimplement.
      autoHideMenuBar: false,
      title: 'DeepSeek Harness Desktop',
      icon: path.join(this.assetsDir, 'icon.ico'),
      webPreferences: {
        // Deliberately absent: `preload`. See the file header.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        // The backend is same-origin HTTP on loopback; nothing here should ever be remote.
        spellcheck: false,
      },
    };

    if (isNumber(bounds.x) && isNumber(bounds.y)) {
      options.x = bounds.x;
      options.y = bounds.y;
    }

    this.win = new BrowserWindow(options);

    if (bounds.maximized) {
      this.win.maximize();
    }

    this.attachGeometryPersistence(this.win);
    this.attachNavigationActions(this.win);

    this.win.on('closed', () => {
      this.win = null;
    });

    return this.win;
  }

  /** @returns {BrowserWindow|null} The live window, or null when none exists. */
  get() {
    return this.win !== null && !this.win.isDestroyed() ? this.win : null;
  }

  /**
   * Decide where to put the window, discarding saved geometry that no longer fits any display.
   *
   * @returns {{x: number|null, y: number|null, width: number, height: number, maximized: boolean}}
   */
  resolveGeometry() {
    const saved = this.settings.get('window');
    const fallback = {
      x: null,
      y: null,
      width: Math.max(720, saved.width || DEFAULT_WIDTH),
      height: Math.max(520, saved.height || DEFAULT_HEIGHT),
      maximized: saved.maximized === true,
    };

    if (!isNumber(saved.x) || !isNumber(saved.y)) {
      // Never positioned before: let Electron centre it on the primary display.
      return fallback;
    }

    // Require a meaningful overlap with *some* current work area.
    const displays = screen.getAllDisplays();
    const visible = displays.some((display) => {
      const area = display.workArea;
      const overlapX =
        Math.min(saved.x + fallback.width, area.x + area.width) - Math.max(saved.x, area.x);
      const overlapY =
        Math.min(saved.y + fallback.height, area.y + area.height) - Math.max(saved.y, area.y);
      return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX;
    });

    if (!visible) {
      this.log.write(
        `saved window geometry (${saved.x},${saved.y}) is outside all displays; using defaults`,
        { source: 'warn' },
      );
      return fallback;
    }

    return { ...fallback, x: saved.x, y: saved.y };
  }

  /**
   * Persist window geometry on move/resize, debounced.
   *
   * @param {BrowserWindow} win
   */
  attachGeometryPersistence(win) {
    const schedule = () => {
      if (this.applyingGeometry) {
        return;
      }
      if (this.geometryTimer !== null) {
        clearTimeout(this.geometryTimer);
      }
      this.geometryTimer = setTimeout(() => {
        this.geometryTimer = null;
        this.persistGeometry(win);
      }, 400);
      if (typeof this.geometryTimer.unref === 'function') {
        this.geometryTimer.unref();
      }
    };

    win.on('resize', schedule);
    win.on('move', schedule);
    // Maximising changes the restored size semantics, so record that separately.
    win.on('maximize', () => {
      this.settings.set({ window: { maximized: true } });
      this.settings.save();
    });
    win.on('unmaximize', () => {
      this.settings.set({ window: { maximized: false } });
      this.settings.save();
    });
  }

  /**
   * Record the current bounds. While maximized, `getBounds()` reports the maximized rectangle,
   * which must not overwrite the restore size — so only the flag is updated then.
   *
   * @param {BrowserWindow} win
   */
  persistGeometry(win) {
    if (win.isDestroyed()) {
      return;
    }
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) {
      return;
    }
    const bounds = win.getBounds();
    this.settings.set({
      window: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
    });
    this.settings.save();
  }

  /**
   * Turn `dsh-desktop://` navigations from the error page into main-process actions.
   *
   * The error page has no preload and no IPC, so its buttons are ordinary links. Routing them
   * through navigation keeps the renderer fully sandboxed while still allowing a few
   * privileged verbs that are explicitly enumerated here.
   *
   * @param {BrowserWindow} win
   */
  attachNavigationActions(win) {
    win.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('dsh-desktop://')) {
        // Everything else is handled by the shared security policy.
        return;
      }
      event.preventDefault();
      const action = this.parseAction(url);
      if (action !== null && this.actionHandler) {
        this.actionHandler(action, url);
      }
    });

    // Links with target="_blank" inside our own local pages (not the dsh UI) also route here.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('dsh-desktop://')) {
        const action = this.parseAction(url);
        if (action !== null && this.actionHandler) {
          this.actionHandler(action, url);
        }
        return { action: 'deny' };
      }
      // The security module installs the real handler for everything else; this window-open
      // path is only reached before that module attaches.
      return { action: 'deny' };
    });
  }

  /**
   * @param {string} url
   * @returns {string|null} The action name, e.g. `retry`.
   */
  parseAction(url) {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^\/action\/([a-z-]+)$/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Show the startup surface.
   *
   * @param {{text?: string, meta?: string}} [state]
   */
  showSplash(state = {}) {
    const win = this.get();
    if (win === null) {
      return;
    }
    const query = new URLSearchParams();
    if (state.text) {
      query.set('text', state.text);
    }
    if (state.meta) {
      query.set('meta', state.meta);
    }
    void win.loadFile(path.join(this.assetsDir, 'splash.html'), {
      search: query.toString() ? `?${query.toString()}` : undefined,
    });
    this.reveal();
  }

  /**
   * Show the failure surface.
   *
   * @param {object} info
   * @param {string} info.message       Human-readable cause (Chinese, shown as the lead line).
   * @param {string} [info.stage]       Machine stage, used to tailor the wording.
   * @param {number|null} [info.exitCode]
   * @param {string|null} [info.nodePath]
   * @param {string|null} [info.dshBin]
   * @param {string|null} [info.dshVersion]
   * @param {string} [info.workspace]
   * @param {string} [info.logFile]
   * @param {string[]} [info.output]    Sanitized trailing backend output.
   */
  showError(info) {
    const win = this.get();
    if (win === null) {
      return;
    }

    const query = new URLSearchParams();
    query.set('message', info.message);
    if (info.stage) {
      query.set('stage', info.stage);
    }
    if (info.exitCode !== null && info.exitCode !== undefined) {
      query.set('exitCode', String(info.exitCode));
    }
    if (info.nodePath) {
      query.set('nodePath', info.nodePath);
    }
    if (info.dshBin) {
      query.set('dshBin', info.dshBin);
    }
    if (info.dshVersion) {
      query.set('dshVersion', info.dshVersion);
    }
    if (info.workspace) {
      query.set('workspace', info.workspace);
    }
    if (info.logFile) {
      query.set('logFile', info.logFile);
    }
    if (info.output && info.output.length > 0) {
      query.set('output', info.output.join('\n'));
    }

    void win.loadFile(path.join(this.assetsDir, 'error.html'), { search: `?${query.toString()}` });
    this.reveal();
  }

  /**
   * Point the window at the authenticated backend URL. The URL carries a one-time token which
   * `frontend-static` exchanges for a 30-day cookie and then 302s to a clean `/`, so the token
   * never lingers in the address bar or in history.
   *
   * @param {string} url
   * @returns {Promise<void>}
   */
  async loadBackend(url) {
    const win = this.get();
    if (win === null) {
      return;
    }
    this.log.write(`loading backend UI on port ${new URL(url).port}`);
    await win.loadURL(url);
    this.reveal();
  }

  /** Show and focus the window, restoring it if minimized. */
  reveal() {
    const win = this.get();
    if (win === null) {
      return;
    }
    if (win.isMinimized()) {
      win.restore();
    }
    if (!win.isVisible()) {
      win.show();
    }
    win.focus();
  }

  /** Hide the window without destroying it, so the backend keeps running in the tray. */
  hide() {
    const win = this.get();
    if (win !== null) {
      win.hide();
    }
  }

  /**
   * Open a path in the OS file manager, selecting it when it is a file.
   *
   * @param {string} target
   */
  revealInFolder(target) {
    if (typeof target !== 'string' || target === '') {
      return;
    }
    if (fs.existsSync(target)) {
      shell.showItemInFolder(target);
      return;
    }
    // A directory that does not exist yet (e.g. logs before first run): open its parent.
    const parent = path.dirname(target);
    if (fs.existsSync(parent)) {
      void shell.openPath(parent);
    }
  }
}

module.exports = { WindowManager, DEFAULT_WIDTH, DEFAULT_HEIGHT, MIN_VISIBLE_PX };
