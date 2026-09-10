'use strict';

/**
 * Backend supervisor: locates Node and the `dsh` CLI, spawns the `web` profile, waits for its
 * readiness URL, captures its output, and reaps orphans.
 *
 * Why spawn the CLI instead of importing it: the plan's route A wraps the *existing*
 * `dsh --profile web` server, so the shell inherits the user's `$DSH_HOME`, plugin set,
 * sessions and credentials with zero migration. The shell deliberately never writes to
 * `$DSH_HOME`.
 *
 * Process hygiene is the hard part on Windows. `dsh` spawns `pwsh`/terminal children, so
 * killing the direct child is not enough — see {@link Backend#stop}. If Electron itself is
 * killed outright, the backend survives as an orphan; {@link reapOrphan} handles that on the
 * next launch using a PID file that is only trusted when the PID still maps to `node.exe`.
 *
 * Path resolution never shells out to `where.exe`: it walks `PATH` itself and checks the
 * filesystem. That keeps startup cheap and immune to `PATHEXT`/localisation surprises.
 */

const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { getStrings } = require('./strings');

/** Regex for the backend's readiness line, e.g. `dsh web: http://127.0.0.1:51234/?token=abc`. */
const READY_LINE = /^dsh web:\s+(https?:\/\/\S+)/;

/** `--port 0` makes the OS assign a free port, so EADDRINUSE is structurally impossible. */
const BACKEND_ARGS = ['--profile', 'web', '--no-open', '--port', '0'];

/** Give up waiting for the readiness line after this long. */
const READY_TIMEOUT_MS = 30_000;
/** Poll the port before handing the URL to the window. */
const PROBE_INTERVAL_MS = 250;
/** How long to wait for a graceful `kill()` before escalating to `taskkill /T /F`. */
const KILL_GRACE_MS = 3_000;
/** Restart backoff schedule; the length also caps the number of automatic restarts. */
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000];

/** Environment variables that must not leak in from a parent dsh session. */
const STRIPPED_ENV_KEYS = ['DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL'];

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending backoff must not keep the app alive.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

/**
 * @param {string} candidate
 * @returns {boolean} True when `candidate` is an existing regular file.
 */
function isFile(candidate) {
  if (typeof candidate !== 'string' || candidate === '') {
    return false;
  }
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Find an executable on `PATH`, honouring `PATHEXT`.
 *
 * @param {string} name Bare executable name, e.g. `node`.
 * @returns {string|null} Absolute path, or null when not found.
 */
function findOnPath(name) {
  const pathValue = process.env.PATH || process.env.Path || '';
  if (pathValue === '') {
    return null;
  }

  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);

  for (const dir of pathValue.split(path.delimiter)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (trimmed === '') {
      continue;
    }

    // A bare `node` on PATH usually means `node.exe`; try the exact name first so an
    // extensionless shim still wins, then the PATHEXT variants.
    const bare = path.join(trimmed, name);
    if (isFile(bare)) {
      return bare;
    }
    for (const extension of extensions) {
      const withExtension = `${bare}${extension}`;
      if (isFile(withExtension)) {
        return withExtension;
      }
    }
  }

  return null;
}

/**
 * Locate `node.exe`: explicit setting, then env override, then `PATH`, then the default
 * install location.
 *
 * @param {string|null} configured Value from settings.
 * @returns {string|null}
 */
function resolveNode(configured) {
  const candidates = [
    configured,
    process.env.DSH_DESKTOP_NODE || null,
    // The Electron helper process is a node too, but it must never be used to run the CLI:
    // it lacks a normal stdio contract for a long-lived server. Only real Node is acceptable.
    findOnPath('node'),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'node.exe') : null,
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe')
      : null,
  ];

  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Run `node <bin.js> --version` once to confirm the entry point is real and to report the
 * version in the About dialog. Failure is not fatal — only informational.
 *
 * @param {string} nodePath
 * @param {string} binPath
 * @returns {string|null} Version string, or null when the probe failed.
 */
function probeDshVersion(nodePath, binPath) {
  try {
    const result = spawnSync(nodePath, [binPath, '--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
    const match = text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    return match ? match[0] : text.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Glob `%LOCALAPPDATA%\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js` and return
 * matches newest-first.
 *
 * The npx cache can be garbage-collected at any time, which is exactly why the dsh entry point
 * is resolved at runtime rather than hard-coded.
 *
 * @returns {string[]}
 */
function npxCacheCandidates() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return [];
  }

  const root = path.join(localAppData, 'npm-cache', '_npx');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  /** @type {{file: string, mtime: number}[]} */
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(
      root,
      entry.name,
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    );
    if (!isFile(candidate)) {
      continue;
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(candidate).mtimeMs;
    } catch {
      // Unreadable mtime: keep the candidate, it is still valid.
    }
    found.push({ file: candidate, mtime });
  }

  return found.sort((a, b) => b.mtime - a.mtime).map((item) => item.file);
}

/**
 * Glob `$DSH_HOME\profiles\*\node_modules\@deepseek-ai\dsh\lib\bin.js`.
 *
 * @param {string} dshHome
 * @returns {string[]}
 */
function profileCandidates(dshHome) {
  const root = path.join(dshHome, 'profiles');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(
      root,
      entry.name,
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    );
    if (isFile(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

/**
 * Resolve the dsh entry point in the documented order.
 *
 * @param {{configured: string|null, dshHome: string}} options
 * @returns {string|null}
 */
function resolveDshBin({ configured, dshHome }) {
  const candidates = [
    configured,
    process.env.DSH_DESKTOP_DSH_BIN || null,
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      : null,
    ...npxCacheCandidates(),
    ...profileCandidates(dshHome),
  ];

  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Build the child environment from the parent's, with dsh-session leftovers removed and a
 * desktop marker added.
 *
 * `DSH_PERMISSION_MODE` is deliberately **preserved verbatim**: it is the backend's own
 * permission switch, and this shell only isolates the window — it never grants or revokes
 * permissions.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function buildChildEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  env.DSH_DESKTOP = '1';
  // Keep the child's own colour/encoding expectations predictable in the log file.
  env.FORCE_COLOR = '0';
  return env;
}

/**
 * Ask the port whether anything is listening yet.
 *
 * The readiness line is printed before the socket is necessarily accepting, so this is a
 * genuinely useful gate rather than redundant confirmation. Any HTTP response — including
 * 401/403/404 — proves the server is up; only a transport error means "not yet".
 *
 * @param {string} url Readiness URL, including its token query.
 * @returns {Promise<boolean>}
 */
function probeUrl(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const request = http.get(
      url,
      { timeout: 2_000, headers: { Connection: 'close' } },
      (response) => {
        response.resume();
        finish(true);
      },
    );

    request.on('timeout', () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => finish(false));
  });
}

/**
 * Working directory for the backend. Falls back to the user profile so the default workspace
 * matches what a plain `dsh` launch from a terminal-in-home would use.
 *
 * @param {string|null} workspace
 * @returns {string}
 */
function resolveWorkspace(workspace) {
  if (typeof workspace === 'string' && workspace !== '' && fs.existsSync(workspace)) {
    return workspace;
  }
  return os.homedir();
}

class Backend extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./settings').Settings} options.settings
   * @param {import('./log').BackendLog} options.log
   * @param {string} options.dshHome
   * @param {string} options.stateDir Directory for `backend.json` (the app's userData dir).
   * @param {import('./strings').StringTable} [options.strings] Localized failure messages.
   */
  constructor({ settings, log, dshHome, stateDir, strings }) {
    super();
    this.settings = settings;
    this.log = log;
    this.dshHome = dshHome;
    this.stateFile = path.join(stateDir, 'backend.json');
    // Falls back to the Chinese table so a caller that forgets to inject strings still gets
    // readable messages rather than `undefined` in a dialog.
    this.strings = strings ?? getStrings('zh');

    /** @type {import('child_process').ChildProcess|null} */
    this.child = null;
    /** @type {string|null} */
    this.authenticatedUrl = null;
    /** @type {number|null} */
    this.port = null;
    /** @type {string|null} */
    this.nodePath = null;
    /** @type {string|null} */
    this.dshBin = null;
    /** @type {string|null} */
    this.dshVersion = null;

    /** True while {@link stop} is running, which suppresses restart logic. */
    this.stopping = false;
    /** True once the backend has delivered a URL at least once. */
    this.hasBeenReady = false;
    /** Number of automatic restarts performed in the current failure streak. */
    this.restartCount = 0;
    /** @type {NodeJS.Timeout|null} */
    this.restartTimer = null;
    /** @type {Promise<void>|null} */
    this.startPromise = null;
    /**
     * True when the current child's exit is already accounted for (we stopped it, or its
     * startup failed and the caller is being told). Prevents double-reporting an exit.
     */
    this.exitAccounted = false;
  }

  /** Resolve tool paths and cache the dsh version where it is cheap to do so. */
  resolveTools() {
    this.nodePath = resolveNode(this.settings.get('nodePath'));
    this.dshBin = resolveDshBin({
      configured: this.settings.get('dshBin'),
      dshHome: this.dshHome,
    });

    if (this.nodePath === null || this.dshBin === null) {
      this.dshVersion = null;
      return;
    }

    const cached = this.settings.get('dshVersion');
    const fresh = probeDshVersion(this.nodePath, this.dshBin);
    // A failed probe is informative, not fatal: the backend itself is the real test, so keep
    // the last known version instead of blanking it.
    this.dshVersion = fresh === null ? cached : fresh;
    if (fresh !== null && fresh !== cached) {
      this.settings.set({ dshVersion: fresh });
      this.settings.save();
    }
  }

  /**
   * Start the backend and resolve once its URL is reachable.
   *
   * Never rejects: failures are surfaced through the `failed` event so the caller can render
   * the error page, and through the returned promise for callers that want to await the win.
   *
   * @returns {Promise<{ok: boolean, url?: string, error?: Error}>}
   */
  async start() {
    if (this.startPromise !== null) {
      await this.startPromise;
      return this.authenticatedUrl !== null
        ? { ok: true, url: this.authenticatedUrl }
        : { ok: false, error: new Error(this.strings.backendStartFailedShort) };
    }

    this.stopping = false;
    this.startPromise = this.run();
    const result = await this.startPromise;
    this.startPromise = null;
    return result;
  }

  /**
   * Spawn the child and wait for readiness.
   *
   * @returns {Promise<{ok: boolean, url?: string, error?: Error}>}
   */
  async run() {
    this.resolveTools();

    if (this.nodePath === null) {
      const error = new Error(this.strings.nodeMissing);
      this.emit('failed', { error, stage: 'resolve-node' });
      return { ok: false, error };
    }
    if (this.dshBin === null) {
      const error = new Error(this.strings.dshMissing);
      this.emit('failed', { error, stage: 'resolve-dsh' });
      return { ok: false, error };
    }

    const workspace = resolveWorkspace(this.settings.get('workspace'));
    this.log.write(
      `spawn ${this.nodePath} ${this.dshBin} ${BACKEND_ARGS.join(' ')}\n` +
        `      cwd=${workspace}\n` +
        `      DSH_HOME=${this.dshHome} dsh=${this.dshVersion || 'unknown'}`,
    );

    this.emit('starting', { workspace, nodePath: this.nodePath, dshBin: this.dshBin });

    /** @type {import('child_process').ChildProcess} */
    let child;
    try {
      child = spawn(this.nodePath, [this.dshBin, ...BACKEND_ARGS], {
        cwd: workspace,
        env: buildChildEnv(),
        // Suppress the console window at the spawn layer — the only place it actually works.
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.log.write(`spawn threw: ${failure.message}`, { source: 'error' });
      this.emit('failed', { error: failure, stage: 'spawn' });
      return { ok: false, error: failure };
    }

    this.child = child;
    this.exitAccounted = false;
    this.writeState({ pid: child.pid, port: null, clean: false });

    // Supervise the child from the moment it exists. Lifecycle decisions about *when* a
    // restart is appropriate belong to the owner; this just reports the exit.
    child.on('exit', (code) => {
      if (this.child !== child || this.exitAccounted) {
        return;
      }
      this.child = null;
      this.emit('exit', { code });
    });

    const url = await this.waitForUrl(child);
    if (url === null) {
      this.exitAccounted = true;
      const error = new Error(this.strings.readyTimeout(READY_TIMEOUT_MS / 1000));
      this.emit('failed', { error, stage: 'timeout', exitCode: child.exitCode });
      await this.stop();
      return { ok: false, error };
    }

    this.authenticatedUrl = url;
    this.port = Number(new URL(url).port);
    this.hasBeenReady = true;
    this.restartCount = 0;
    this.writeState({ pid: child.pid, port: this.port, clean: false });
    this.log.write(`ready on 127.0.0.1:${this.port}`);
    this.emit('ready', { url, port: this.port });
    return { ok: true, url };
  }

  /**
   * Watch the child's streams for the readiness line, while forwarding output to the log.
   *
   * @param {import('child_process').ChildProcess} child
   * @returns {Promise<string|null>} The authenticated URL, or null on timeout/early exit.
   */
  waitForUrl(child) {
    return new Promise((resolve) => {
      /** @type {string} */
      let carry = '';
      let settled = false;
      /** @type {NodeJS.Timeout} */
      let timer;

      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        child.off('exit', onExit);
        resolve(value);
      };

      const onStdout = (chunk) => {
        const text = chunk.toString('utf8');
        this.log.write(text, { source: 'out' });
        this.emit('output', { stream: 'out', text });

        // The URL line can straddle two chunks; keep the tail of an unterminated line.
        carry += text;
        const lines = carry.split(/\r?\n/);
        carry = lines.pop() ?? '';

        for (const line of lines) {
          const match = line.match(READY_LINE);
          if (match) {
            // Do not resolve on the printed line alone: confirm the socket accepts.
            void this.confirmReachable(match[1], finish);
          }
        }
      };

      const onExit = (code) => {
        this.log.write(`backend exited during startup (code ${code})`, { source: 'error' });
        finish(null);
      };

      timer = setTimeout(() => finish(null), READY_TIMEOUT_MS);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        this.log.write(text, { source: 'err' });
        this.emit('output', { stream: 'err', text });
      });
      child.on('exit', onExit);
    });
  }

  /**
   * Poll the readiness URL until it answers or the overall deadline expires.
   *
   * @param {string} url
   * @param {(value: string|null) => void} finish
   */
  async confirmReachable(url, finish) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopping || this.child === null) {
        return;
      }
      if (await probeUrl(url)) {
        finish(url);
        return;
      }
      await delay(PROBE_INTERVAL_MS);
    }
  }

  /**
   * Stop the backend and its whole process tree.
   *
   * A graceful `kill()` first, because it lets dsh shut down its own children; `taskkill /T /F`
   * only as a fallback, since dsh reliably spawns `pwsh`/terminal grandchildren that a plain
   * kill would leave behind (plan acceptance item 3).
   *
   * @returns {Promise<void>}
   */
  async stop() {
    const child = this.child;
    this.stopping = true;
    // Mark the pending exit as intentional before anything can observe it, so an expected
    // shutdown never looks like a crash.
    this.exitAccounted = true;

    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      this.writeState({ pid: null, port: null, clean: true });
      return;
    }

    const pid = child.pid;
    this.log.write(`stopping backend pid=${pid}`);

    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
    try {
      child.kill();
    } catch {
      // Already gone, or not killable: the taskkill fallback below covers it.
    }

    const graceful = await Promise.race([exited, delay(KILL_GRACE_MS).then(() => false)]);
    if (!graceful && pid !== undefined) {
      this.log.write(`graceful kill timed out; taskkill /T /F pid=${pid}`, { source: 'warn' });
      killTree(pid);
      // Give the OS a moment to reap so acceptance checks do not race the teardown.
      await Promise.race([exited, delay(1_000)]);
    }

    this.child = null;
    this.authenticatedUrl = null;
    this.port = null;
    // Record a clean shutdown so the next launch does not try to reap us.
    this.writeState({ pid: null, port: null, clean: true });
  }

  /**
   * Restart the backend, resetting the failure streak when asked explicitly by the user.
   *
   * @param {{resetBackoff?: boolean}} [options]
   * @returns {Promise<{ok: boolean, url?: string, error?: Error}>}
   */
  async restart(options = {}) {
    if (options.resetBackoff) {
      this.restartCount = 0;
    }
    await this.stop();
    return this.start();
  }

  /**
   * Decide what to do after an unexpected exit: restart with backoff, or give up.
   *
   * @param {number|null} code
   */
  handleUnexpectedExit(code) {
    if (this.stopping) {
      return;
    }

    this.authenticatedUrl = null;
    this.port = null;
    this.writeState({ pid: null, port: null, clean: true });

    if (this.restartCount >= RESTART_DELAYS_MS.length) {
      this.log.write(`backend exited (code ${code}); restart budget exhausted`, { source: 'error' });
      this.emit('failed', {
        error: new Error(
          this.strings.restartsExhausted(code, RESTART_DELAYS_MS.length),
        ),
        stage: 'exhausted',
        exitCode: code,
      });
      return;
    }

    const backoff = RESTART_DELAYS_MS[this.restartCount];
    this.restartCount += 1;
    this.log.write(
      `backend exited (code ${code}); restart ${this.restartCount}/${RESTART_DELAYS_MS.length} in ${backoff}ms`,
      { source: 'warn' },
    );
    this.emit('restarting', { attempt: this.restartCount, delayMs: backoff, exitCode: code });

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) {
        return;
      }
      void this.start().then((result) => {
        if (!result.ok) {
          // `start()` already emitted `failed`; the budget check above bounds the loop.
          this.handleUnexpectedExit(result.error ? null : 0);
        }
      });
    }, backoff);
    if (typeof this.restartTimer.unref === 'function') {
      this.restartTimer.unref();
    }
  }

  /**
   * Persist `backend.json` for orphan detection on the next launch.
   *
   * @param {{pid: number|null|undefined, port: number|null, clean: boolean}} state
   */
  writeState(state) {
    try {
      fs.writeFileSync(
        this.stateFile,
        `${JSON.stringify({ ...state, startedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // Orphan detection is best-effort; never let it break startup or shutdown.
    }
  }
}

/**
 * Kill a process tree by PID. Used both for teardown and for orphan reaping.
 *
 * @param {number} pid
 * @returns {boolean} True when `taskkill` reported success.
 */
function killTree(pid) {
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check whether a PID currently belongs to a `node.exe` image.
 *
 * The image-name check matters: PIDs are recycled, and killing an unrelated process because
 * our stale PID file happens to match would be far worse than leaving an orphan behind.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isLiveNodeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    const result = spawnSync(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    );
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      return false;
    }
    // Output looks like: "node.exe","12345","Console","1","123,456 K"
    const match = result.stdout.match(/^"([^"]+)","(\d+)"/m);
    return match !== null && match[1].toLowerCase() === 'node.exe' && Number(match[2]) === pid;
  } catch {
    return false;
  }
}

/**
 * Reap a backend left behind when Electron was killed before it could clean up.
 *
 * @param {string} stateDir The app's userData directory.
 * @param {import('./log').BackendLog} log
 * @returns {{reaped: boolean, pid: number|null}}
 */
function reapOrphan(stateDir, log) {
  const stateFile = path.join(stateDir, 'backend.json');
  if (!isFile(stateFile)) {
    return { reaped: false, pid: null };
  }

  /** @type {any} */
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    // Unreadable state file: nothing trustworthy to act on.
    try {
      fs.unlinkSync(stateFile);
    } catch {
      // Ignore.
    }
    return { reaped: false, pid: null };
  }

  // A clean shutdown already killed its backend; nothing to reap.
  if (state === null || typeof state !== 'object' || state.clean !== false) {
    return { reaped: false, pid: null };
  }

  const pid = Number(state.pid);
  if (!isLiveNodeProcess(pid)) {
    log.write(`stale backend state (pid=${state.pid}); nothing to reap`, { source: 'warn' });
    try {
      fs.unlinkSync(stateFile);
    } catch {
      // Ignore.
    }
    return { reaped: false, pid: null };
  }

  log.write(`reaping orphaned backend pid=${pid}`, { source: 'warn' });
  const killed = killTree(pid);
  try {
    fs.unlinkSync(stateFile);
  } catch {
    // Ignore.
  }
  return { reaped: killed, pid };
}

module.exports = {
  Backend,
  reapOrphan,
  killTree,
  isLiveNodeProcess,
  resolveNode,
  resolveDshBin,
  findOnPath,
  buildChildEnv,
  probeDshVersion,
  resolveWorkspace,
  BACKEND_ARGS,
  STRIPPED_ENV_KEYS,
  READY_TIMEOUT_MS,
};
