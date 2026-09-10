'use strict';

/**
 * Persistent shell settings, stored as JSON under the app's `userData` directory
 * (`%APPDATA%\dsh-desktop\settings.json` by default — the directory is pinned explicitly by
 * `main.js` via `app.setPath('userData', ...)` so it never shifts with `productName`).
 *
 * Design notes:
 * - Reads are *permissive*: every field is individually type-checked against its default, and
 *   unknown keys are preserved on disk-write only insofar as we never delete what we do not
 *   understand... (we do drop them, deliberately: the file is ours, and forward-compat matters
 *   less than never resurrecting a corrupt value. Unknown keys are therefore ignored on read
 *   and absent from the next write.)
 * - Writes are *atomic*: write a sibling temp file, then `rename` over the target, so a crash
 *   mid-write can never leave a truncated settings file.
 * - Saving is debounced, because window `resize`/`move` fire continuously while dragging.
 */

const fs = require('fs');
const path = require('path');

/** Debounce window for {@link Settings#save}, in milliseconds. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * @typedef {object} WindowGeometry
 * @property {number|null} x
 * @property {number|null} y
 * @property {number} width
 * @property {number} height
 * @property {boolean} maximized
 */

/**
 * @typedef {object} SettingsShape
 * @property {string|null} workspace      Working directory handed to the backend process.
 * @property {string|null} nodePath       Explicit `node.exe` to use; null means auto-resolve.
 * @property {string|null} dshBin         Explicit `.../@deepseek-ai/dsh/lib/bin.js`; null means auto-resolve.
 * @property {string|null} dshVersion     Cached `dsh --version` output, informational only.
 * @property {'ask'|'tray'|'quit'} closeBehavior What closing the main window does.
 * @property {WindowGeometry} window      Last known window geometry.
 */

/** Factory for a fresh default object; never share a mutable default between callers. */
function defaultSettings() {
  return {
    workspace: null,
    nodePath: null,
    dshBin: null,
    dshVersion: null,
    closeBehavior: 'ask',
    window: { x: null, y: null, width: 1280, height: 860, maximized: false },
  };
}

const CLOSE_BEHAVIORS = ['ask', 'tray', 'quit'];

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Coerce a persisted geometry number, falling back when it is not a usable finite number.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

class Settings {
  constructor() {
    /** @type {SettingsShape} */
    this.values = defaultSettings();
    /** @type {string|null} */
    this.file = null;
    /** @type {NodeJS.Timeout|null} */
    this.saveTimer = null;
    /** @type {(() => void)|null} Called after a successful disk write (used for logging). */
    this.onSaved = null;
  }

  /**
   * Bind the settings file to `userData` and load whatever is already there.
   *
   * @param {string} userDataDir Absolute path to the app's userData directory.
   * @returns {{loaded: boolean, error: string|null}} Whether an existing file was read cleanly.
   */
  init(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    fs.mkdirSync(userDataDir, { recursive: true });

    if (!fs.existsSync(this.file)) {
      return { loaded: false, error: null };
    }

    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.values = this.validate(JSON.parse(raw));
      return { loaded: true, error: null };
    } catch (error) {
      // A corrupt settings file must not stop the app: fall back to defaults and report.
      this.values = defaultSettings();
      return { loaded: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Validate an arbitrary parsed JSON value into a complete settings object.
   * Every field is checked independently, so one bad field cannot discard the rest.
   *
   * @param {unknown} input
   * @returns {SettingsShape}
   */
  validate(input) {
    const defaults = defaultSettings();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return defaults;
    }

    /** @type {Record<string, unknown>} */
    const source = /** @type {any} */ (input);
    const rawWindow =
      source.window !== null && typeof source.window === 'object' && !Array.isArray(source.window)
        ? /** @type {Record<string, unknown>} */ (source.window)
        : {};

    return {
      workspace: isNonEmptyString(source.workspace) ? source.workspace.trim() : null,
      nodePath: isNonEmptyString(source.nodePath) ? source.nodePath.trim() : null,
      dshBin: isNonEmptyString(source.dshBin) ? source.dshBin.trim() : null,
      dshVersion: isNonEmptyString(source.dshVersion) ? source.dshVersion.trim() : null,
      closeBehavior: CLOSE_BEHAVIORS.includes(/** @type {any} */ (source.closeBehavior))
        ? /** @type {'ask'|'tray'|'quit'} */ (source.closeBehavior)
        : defaults.closeBehavior,
      window: {
        x: typeof rawWindow.x === 'number' && Number.isFinite(rawWindow.x) ? rawWindow.x : null,
        y: typeof rawWindow.y === 'number' && Number.isFinite(rawWindow.y) ? rawWindow.y : null,
        width: Math.max(640, finiteOr(rawWindow.width, defaults.window.width)),
        height: Math.max(480, finiteOr(rawWindow.height, defaults.window.height)),
        maximized: rawWindow.maximized === true,
      },
    };
  }

  /**
   * Read a single settings value.
   *
   * @template {keyof SettingsShape} K
   * @param {K} key
   * @returns {SettingsShape[K]}
   */
  get(key) {
    return this.values[key];
  }

  /**
   * Merge a patch into the in-memory settings. Does **not** touch the disk; call {@link save}.
   *
   * @param {Partial<SettingsShape>} patch
   */
  set(patch) {
    this.values = this.validate({ ...this.values, ...patch });
  }

  /** Schedule an atomic write, coalescing bursts of updates (window drag/resize). */
  save() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    // Never hold the event loop open just to write settings.
    if (typeof this.saveTimer.unref === 'function') {
      this.saveTimer.unref();
    }
  }

  /** Write immediately, cancelling any pending debounced write. */
  flush() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.file === null) {
      return;
    }

    const temporary = `${this.file}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(this.values, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, this.file);
      if (this.onSaved) {
        this.onSaved();
      }
    } catch (error) {
      // Settings are a convenience, not a correctness requirement — report, never throw.
      if (this.onSaved) {
        this.onSaved(error instanceof Error ? error.message : String(error));
      }
    }
  }
}

module.exports = { Settings, defaultSettings, CLOSE_BEHAVIORS };
