'use strict';

/**
 * Backend log capture.
 *
 * The backend prints its readiness line as
 * `dsh web: http://127.0.0.1:<port>/?token=<token>`, and that token is a login credential.
 * Everything written through this module is therefore passed through {@link sanitize} first,
 * so the on-disk log can be pasted into a bug report or committed without leaking it.
 *
 * The log lives in `logs/backend.log` next to the app (not in `userData`) so it is easy to
 * find next to the backend it describes. Rotation is size-based with a single `.1` generation,
 * which is enough to survive one runaway session without unbounded growth.
 */

const fs = require('fs');
const path = require('path');

/** Rotate once the active log exceeds this size. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Hard per-line cap, so a pathological single line cannot fill the disk. */
const MAX_LINE_LENGTH = 16 * 1024;

/**
 * Redact secrets from arbitrary text.
 *
 * Covers the concrete shapes this app can produce:
 * - `token=<value>` inside a query string (the readiness URL)
 * - bare `token=<value>` / `token: <value>` in prose or YAML
 * - `Authorization: Bearer <value>`
 * - `?token=...` variants in any casing
 *
 * @param {string} text
 * @returns {string}
 */
function sanitize(text) {
  if (typeof text !== 'string' || text === '') {
    return '';
  }

  return (
    text
      // ?token=abc123 / &token=abc123 (preserve the delimiter, mask the value)
      .replace(/([?&]token=)[^&\s"'#]+/gi, '$1***')
      // token=abc123 / token: abc123 / "token": "abc123"
      .replace(/(\btoken\b\s*[:=]\s*["']?)[^&\s"',}]+/gi, '$1***')
      // Bearer tokens
      .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***')
  );
}

/** Clip a single line to {@link MAX_LINE_LENGTH} so one bad line cannot balloon the log. */
function clampLine(line) {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…[truncated]` : line;
}

/** Local `YYYY-MM-DD HH:mm:ss.SSS` timestamp, which is what a human reading the log wants. */
function timestamp() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.` +
    `${pad(now.getMilliseconds(), 3)}`
  );
}

class BackendLog {
  /**
   * @param {string} logsDir Directory that will hold `backend.log`.
   */
  constructor(logsDir) {
    this.dir = logsDir;
    this.file = path.join(logsDir, 'backend.log');
    this.rotatedFile = path.join(logsDir, 'backend.1.log');
    fs.mkdirSync(logsDir, { recursive: true });
    this.write(`${'='.repeat(60)}\nsession start`, { stamp: true });
  }

  /** @returns {number} Current size of the active log, or 0 when absent. */
  size() {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  /** Move the active log aside when it has grown past the cap. Best-effort. */
  rotateIfNeeded() {
    try {
      if (this.size() < MAX_LOG_BYTES) {
        return;
      }
      // `rename` overwrites an existing destination on Windows and POSIX alike.
      fs.renameSync(this.file, this.rotatedFile);
    } catch {
      // Rotation is hygiene, never correctness — a failure must not disturb the app.
    }
  }

  /**
   * Append sanitized text to the log.
   *
   * @param {string} text May contain newlines; each becomes its own stamped line.
   * @param {{stamp?: boolean, source?: string}} [options]
   *   `stamp` prefixes each line with a timestamp; `source` labels the stream (e.g. `stderr`).
   */
  write(text, options = {}) {
    if (typeof text !== 'string' || text === '') {
      return;
    }
    const { stamp = true, source = null } = options;

    const body = sanitize(text)
      .split(/\r?\n/)
      // Trailing newline in a chunk yields an empty final element; drop only those.
      .filter((line, index, all) => line !== '' || index < all.length - 1)
      .map((line) => {
        const decorated = source === null ? line : `[${source}] ${line}`;
        const clamped = clampLine(decorated);
        return stamp ? `${timestamp()} ${clamped}` : clamped;
      })
      .join('\n');

    if (body === '') {
      return;
    }

    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, `${body}\n`, 'utf8');
    } catch {
      // If the log cannot be written the app must still run; there is nowhere to report this.
    }
  }

  /**
   * Read the last `count` lines of sanitized log text, for display on the error page.
   *
   * @param {number} [count]
   * @returns {string[]}
   */
  tail(count = 20) {
    try {
      const content = fs.readFileSync(this.file, 'utf8');
      const lines = content.split(/\r?\n/).filter((line) => line !== '');
      return lines.slice(-count);
    } catch {
      return [];
    }
  }
}

module.exports = { BackendLog, sanitize, MAX_LOG_BYTES };
