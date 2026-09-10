'use strict';

/**
 * Security policy for every web contents in the app.
 *
 * The renderer is a real web page served over loopback HTTP, so the shell's job is purely
 * subtractive: it never adds capability, it only refuses things the browser would have
 * allowed. The threat model that matters here is a prompt-injected page or a malicious link
 * inside a model response trying to escape the window, open a local file, or reach the OS.
 *
 * Applied from `app.on('web-contents-created')` so it covers the main window *and* anything
 * created later (devtools, unexpected popups) rather than only what we remember to configure.
 */

const { BrowserWindow, clipboard, Menu, shell } = require('electron');

/** Permission types the UI genuinely needs. Everything else is denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/** Schemes that may be handed to the OS browser. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:']);

/**
 * @param {string} url
 * @returns {boolean} True when the URL is safe to open in the user's default browser.
 */
function isSafeExternalUrl(url) {
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Open a URL in the system browser, refusing anything that is not plain http/https.
 *
 * `shell.openExternal` with an attacker-controlled scheme is a well-known remote-code-execution
 * vector (`file:`, `ms-msdt:`, `search-ms:` …), so the scheme check is the whole point.
 *
 * @param {string} url
 * @returns {boolean} True when the URL was handed to the OS.
 */
function openExternal(url) {
  if (!isSafeExternalUrl(url)) {
    return false;
  }
  void shell.openExternal(url);
  return true;
}

class SecurityPolicy {
  /**
   * @param {object} options
   * @param {import('./log').BackendLog} options.log
   * @param {{isDevelopment: boolean}} options.mode
   * @param {import('./strings').StringTable} options.strings Localized UI strings.
   */
  constructor({ log, mode, strings }) {
    this.log = log;
    this.mode = mode;
    this.strings = strings;
    /**
     * Allowed origin, e.g. `http://127.0.0.1:51234`. Set once the backend reports its port —
     * never hard-coded, because the port is OS-assigned on every launch.
     *
     * @type {string|null}
     */
    this.allowedOrigin = null;
    /**
     * Handler for `dsh-desktop://action/<name>` links, set by `main.js`.
     *
     * @type {((action: string) => void)|null}
     */
    this.actionHandler = null;
  }

  /**
   * @param {number} port
   */
  setAllowedPort(port) {
    this.allowedOrigin = `http://127.0.0.1:${port}`;
  }

  /**
   * Attach every policy hook to one `webContents`.
   *
   * @param {import('electron').WebContents} contents
   */
  attach(contents) {
    const { session } = contents;

    // --- Permissions -------------------------------------------------------------
    // Deny by default. `clipboard-sanitized-write` is the sanitized copy path the UI uses for
    // its copy buttons; notably NOT `clipboard-read`, which would let the page read the
    // user's clipboard.
    session.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = ALLOWED_PERMISSIONS.has(permission);
      if (!allowed) {
        this.log.write(`denied permission request: ${permission}`, { source: 'security' });
      }
      callback(allowed);
    });

    session.setPermissionCheckHandler((_wc, permission) => {
      return ALLOWED_PERMISSIONS.has(permission);
    });

    // --- Navigation -------------------------------------------------------------
    contents.on('will-navigate', (event, url) => {
      if (url.startsWith('dsh-desktop://')) {
        event.preventDefault();
        this.dispatchAction(url);
        return;
      }

      // Only the backend we started may load. The token exchange redirects to `/` on the same
      // origin, so the origin check is sufficient and the token cannot be replayed elsewhere.
      if (this.allowedOrigin !== null && url.startsWith(`${this.allowedOrigin}/`)) {
        return;
      }

      event.preventDefault();
      if (isSafeExternalUrl(url)) {
        // A real navigation to an outside site means the UI tried to leave the app; send it
        // to the browser instead of replacing our window.
        this.log.write(`external navigation sent to browser: ${url}`, { source: 'security' });
        openExternal(url);
      } else {
        this.log.write(`blocked navigation: ${url}`, { source: 'security' });
      }
    });

    // --- New windows ------------------------------------------------------------
    // The dsh UI marks external links `target="_blank"`; every one of those must become a
    // browser tab, never an Electron window with our privileges.
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('dsh-desktop://')) {
        this.dispatchAction(url);
        return { action: 'deny' };
      }
      if (isSafeExternalUrl(url)) {
        openExternal(url);
      } else {
        this.log.write(`blocked window.open: ${url}`, { source: 'security' });
      }
      return { action: 'deny' };
    });

    // --- Webviews ---------------------------------------------------------------
    // No page in this app has any business embedding a <webview>.
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      this.log.write('blocked webview attach', { source: 'security' });
    });

    // --- Preload assertion ------------------------------------------------------
    // A regression guard: if someone later adds a preload to the window options, record it
    // rather than silently widening the attack surface.
    const preferences = /** @type {any} */ (contents).getLastWebPreferences?.();
    if (preferences && preferences.preload) {
      this.log.write(`unexpected preload configured: ${preferences.preload}`, { source: 'security' });
    }

    this.attachContextMenu(contents);
  }

  /**
   * @param {string} url
   */
  dispatchAction(url) {
    if (!this.actionHandler) {
      return;
    }
    const match = url.match(/\/action\/([a-z-]+)/);
    if (match) {
      this.actionHandler(match[1]);
    }
  }

  /**
   * Build a native right-click menu appropriate to whatever was clicked.
   *
   * dsh's frontend ships no custom context menu, so without this the Electron window has none
   * at all — including no copy/paste in the composer, which the browser version does provide.
   *
   * @param {import('electron').WebContents} contents
   */
  attachContextMenu(contents) {
    contents.on('context-menu', (_event, params) => {
      const s = this.strings;
      /** @type {import('electron').MenuItemConstructorOptions[]} */
      const template = [];

      if (params.isEditable) {
        template.push(
          { role: 'undo', label: s.undo },
          { role: 'redo', label: s.redo },
          { type: 'separator' },
          { role: 'cut', label: s.cut },
          { role: 'copy', label: s.copy },
          { role: 'paste', label: s.paste },
          // Spelling is disabled in webPreferences, so paste-and-match-style is noise here.
          { type: 'separator' },
          { role: 'selectAll', label: s.selectAll },
        );
      } else if (params.selectionText && params.selectionText.trim() !== '') {
        template.push({ role: 'copy', label: s.copy });
        template.push({
          label: s.ctxCopyAsPlainText,
          click: () => clipboard.writeText(params.selectionText),
        });
      }

      if (params.linkURL !== '') {
        if (template.length > 0) {
          template.push({ type: 'separator' });
        }
        template.push({
          label: s.ctxOpenLinkInBrowser,
          enabled: isSafeExternalUrl(params.linkURL),
          click: () => openExternal(params.linkURL),
        });
        template.push({
          label: s.ctxCopyLinkAddress,
          click: () => clipboard.writeText(params.linkURL),
        });
      }

      if (params.mediaType === 'image' && params.srcURL !== '') {
        if (template.length > 0) {
          template.push({ type: 'separator' });
        }
        template.push({
          label: s.ctxCopyImage,
          click: () => contents.copyImageAt(params.x, params.y),
        });
        template.push({
          label: s.ctxCopyImageAddress,
          click: () => clipboard.writeText(params.srcURL),
        });
      }

      if (template.length === 0) {
        return;
      }

      if (this.mode.isDevelopment) {
        template.push({ type: 'separator' });
        template.push({
          label: s.ctxInspectElement,
          click: () => contents.inspectElement(params.x, params.y),
        });
      }

      const menu = Menu.buildFromTemplate(template);
      // `contents.hostWebContents` is set for webviews; for a normal window the popup resolves
      // the owning window itself.
      const host = /** @type {any} */ (contents).hostWebContents;
      menu.popup(host ? { window: BrowserWindow.fromWebContents(host) ?? undefined } : {});
    });
  }
}

module.exports = { SecurityPolicy, openExternal, isSafeExternalUrl, ALLOWED_PERMISSIONS };
