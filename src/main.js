'use strict';

/**
 * Application entry point: lifecycle, single-instance handling, and the wiring between the
 * backend supervisor, the window, and the OS chrome (menu/tray).
 *
 * Startup order matters and is deliberate:
 *   1. pin `userData` and read settings   (before `ready`, so paths are stable everywhere)
 *   2. acquire the single-instance lock   (before any window or process exists)
 *   3. reap an orphaned backend           (a previous Electron may have been killed outright)
 *   4. show the window with the splash    (never a blank white frame while waiting)
 *   5. start the backend, then load its URL
 *
 * Security posture: the shell only ever *isolates*; it never grants. In particular
 * `DSH_PERMISSION_MODE` is inherited untouched by the child, so the backend's own permission
 * policy is exactly what the user configured.
 */

const { Notification, app, dialog, shell } = require('electron');
const os = require('os');
const path = require('path');

const { Backend, reapOrphan } = require('./child');
const { DownloadManager, downloadDirectory } = require('./downloads');
const { BackendLog } = require('./log');
const { AppChrome, applyLanguageSwitch } = require('./menu');
const { SecurityPolicy } = require('./security');
const { Settings } = require('./settings');
const { detectLocale, getStrings } = require('./strings');
const { WindowManager } = require('./windows');

const IS_DEVELOPMENT = !app.isPackaged;
const APP_ID = 'com.saltyice.dshdesktop';

// Must run before `ready`: Chromium consumes `--lang` during browser-process startup, so a
// later call would be ignored and native Chromium surfaces would stay English.
applyLanguageSwitch();

/** Resolution order for the dsh home directory, mirroring the CLI's own default. */
function resolveDshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') {
    return process.env.DSH_HOME;
  }
  return path.join(os.homedir(), '.dsh');
}

/**
 * Pin the userData directory to a stable path.
 *
 * Without this, Electron derives it from `productName`, so renaming the product would silently
 * orphan settings, logs and the backend PID file. The env override exists for smoke tests that
 * must not touch the real profile.
 *
 * @returns {string}
 */
function resolveUserDataDir() {
  const override = process.env.DSH_DESKTOP_USER_DATA;
  if (override && override.trim() !== '') {
    return path.resolve(override.trim());
  }
  return path.join(app.getPath('appData'), 'dsh-desktop');
}

app.setAppUserModelId(APP_ID);
app.setName('dsh-desktop');

const userDataDir = resolveUserDataDir();
app.setPath('userData', userDataDir);
// Keep crash dumps and caches inside the pinned directory too, so nothing is scattered.
app.setPath('crashDumps', path.join(userDataDir, 'crash-dumps'));

const logsDir = path.join(userDataDir, 'logs');
const assetsDir = path.join(__dirname, '..', 'assets');

/**
 * UI language for this run, decided once from every available locale signal (Chromium's UI
 * locale, the OS locale, and Windows' per-user language list). The window title and all shell
 * chrome follow it.
 */
const strings = getStrings(detectLocale());

const settings = new Settings();
const log = new BackendLog(logsDir);
const dshHome = resolveDshHome();

const windowManager = new WindowManager({
  settings,
  log,
  assetsDir,
  windowTitle: strings.windowTitle,
});
const downloads = new DownloadManager({ log, strings });
const backend = new Backend({ settings, log, dshHome, stateDir: userDataDir, strings });
const security = new SecurityPolicy({
  log,
  mode: { isDevelopment: IS_DEVELOPMENT },
  strings,
});

/** True once the user has asked to exit, so close-to-tray stops intercepting. */
let quitting = false;
/** Guards against more than one shutdown running at once. */
let shuttingDown = false;

const chrome = new AppChrome({
  actions: {
    showWindow: () => windowManager.reveal(),
    switchWorkspace: () => void switchWorkspace(),
    openLogs: () => windowManager.revealInFolder(logsDir),
    openDownloads: () => windowManager.revealInFolder(downloadDirectory()),
    restartBackend: () => void restartBackend(),
    openInBrowser: () => openInBrowser(),
    about: () => void showAbout(),
    quit: () => requestQuit(),
  },
  log,
  assetsDir,
  mode: { isDevelopment: IS_DEVELOPMENT },
  strings,
});

/* -------------------------------------------------------------------------- *
 * Startup
 * -------------------------------------------------------------------------- */

function bootstrap() {
  const loaded = settings.init(userDataDir);
  if (loaded.error !== null) {
    log.write(`settings file was unreadable (${loaded.error}); using defaults`, {
      source: 'warn',
    });
  }
  settings.onSaved = (error) => {
    if (typeof error === 'string') {
      log.write(`could not write settings: ${error}`, { source: 'warn' });
    }
  };

  log.write(
    `dsh-desktop ${app.getVersion()} starting\n` +
      `      electron=${process.versions.electron} node=${process.versions.node}\n` +
      `      userData=${userDataDir}\n` +
      `      DSH_HOME=${dshHome}`,
  );

  // A previous run may have died before it could stop its backend.
  const reap = reapOrphan(userDataDir, log);
  if (reap.reaped) {
    log.write(`reaped orphaned backend pid=${reap.pid}`, { source: 'warn' });
  }

  chrome.installMenu();
  chrome.installTray();
  windowManager.actionHandler = (action) => void handleAction(action);

  downloads.attach(require('electron').session.defaultSession);

  const win = windowManager.create();
  downloads.setWindow(win);
  windowManager.showSplash({ text: strings.startingBackend });

  win.on('close', (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    void handleCloseRequest();
  });

  void startBackend();
}

/**
 * Start the backend and point the window at it, rendering the error surface on failure.
 *
 * @returns {Promise<void>}
 */
async function startBackend() {
  const result = await backend.start();

  if (!result.ok || !result.url) {
    windowManager.showError(buildErrorInfo(result.error, 'startup'));
    return;
  }

  security.setAllowedPort(backend.port ?? 0);
  windowManager.showSplash({
    text: strings.loadingUi,
    meta: `127.0.0.1:${backend.port}`,
  });

  try {
    await windowManager.loadBackend(result.url);
  } catch (error) {
    // `loadURL` rejects on a failed navigation. Retry once before giving up: the very first
    // load can race the cookie exchange that the readiness URL triggers.
    log.write(
      `first load failed: ${error instanceof Error ? error.message : String(error)}`,
      { source: 'warn' },
    );
    try {
      await windowManager.loadBackend(result.url);
    } catch (secondError) {
      windowManager.showError(buildErrorInfo(secondError, 'load'));
    }
  }
}

/**
 * Assemble everything the error page needs, including sanitized trailing backend output.
 *
 * @param {Error|null|undefined} error
 * @param {string} stage
 * @returns {Parameters<WindowManager['showError']>[0]}
 */
function buildErrorInfo(error, stage) {
  return {
    message: error instanceof Error ? error.message : String(error ?? strings.unknownError),
    stage,
    exitCode: null,
    nodePath: backend.nodePath,
    dshBin: backend.dshBin,
    dshVersion: backend.dshVersion,
    workspace: settings.get('workspace') ?? os.homedir(),
    logFile: log.file,
    output: log.tail(20),
  };
}

/* -------------------------------------------------------------------------- *
 * Backend supervision
 * -------------------------------------------------------------------------- */

backend.on('exit', ({ code }) => {
  if (quitting || shuttingDown) {
    return;
  }
  log.write(`backend exited unexpectedly (code ${code})`);
  backend.handleUnexpectedExit(code);
});

backend.on('restarting', ({ attempt, delayMs }) => {
  windowManager.showSplash({
    text: strings.restartingBackend,
    meta: strings.restartAttempt(attempt, (delayMs / 1000).toFixed(0)),
  });
});

backend.on('failed', ({ error, stage, exitCode }) => {
  if (quitting) {
    return;
  }
  log.write(`backend failure (${stage}): ${error instanceof Error ? error.message : error}`, {
    source: 'error',
  });
  windowManager.showError({ ...buildErrorInfo(error, stage ?? 'unknown'), exitCode: exitCode ?? null });
});

/**
 * Restart the backend on the user's explicit request, resetting the automatic-restart budget.
 *
 * @returns {Promise<void>}
 */
async function restartBackend() {
  log.write('restart requested by user');
  windowManager.showSplash({ text: strings.restartingManually });
  const result = await backend.restart({ resetBackoff: true });
  if (!result.ok || !result.url) {
    windowManager.showError(buildErrorInfo(result.error, 'restart'));
    return;
  }
  security.setAllowedPort(backend.port ?? 0);
  await windowManager.loadBackend(result.url);
}

/* -------------------------------------------------------------------------- *
 * Window actions
 * -------------------------------------------------------------------------- */

/**
 * Let the user pick a different workspace root; the backend must restart to adopt it.
 *
 * @returns {Promise<void>}
 */
async function switchWorkspace() {
  const win = windowManager.get();
  const current = settings.get('workspace') ?? os.homedir();
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: strings.workspaceTitle,
    defaultPath: current,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: strings.workspaceButton,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return;
  }

  const chosen = result.filePaths[0];
  if (chosen === current) {
    return;
  }

  settings.set({ workspace: chosen });
  settings.flush();
  log.write(`workspace changed to ${chosen}`);

  if (Notification.isSupported() && (win === null || !win.isVisible())) {
    new Notification({ title: strings.workspaceChangedTitle, body: chosen }).show();
  }

  await restartBackend();
}

/** Open the running UI in the system browser. The session cookie is shared with the window. */
function openInBrowser() {
  if (backend.authenticatedUrl === null) {
    void dialog.showMessageBox({
      type: 'warning',
      title: strings.backendMissingTitle,
      message: strings.backendMissingMessage,
      buttons: [strings.ok],
      noLink: true,
    });
    return;
  }
  // `authenticatedUrl` still carries the one-time token, which is exactly what a fresh browser
  // session needs; the backend swaps it for a cookie and redirects.
  void shell.openExternal(backend.authenticatedUrl);
}

/** @returns {Promise<void>} */
async function showAbout() {
  const win = windowManager.get();
  const details = [
    strings.aboutShellVersion(app.getVersion()),
    strings.aboutElectron(process.versions.electron),
    strings.aboutNode(process.versions.node),
    strings.aboutDsh(backend.dshVersion ?? strings.unknown),
    strings.aboutPort(backend.port ?? strings.notRunning),
    strings.aboutWorkspace(settings.get('workspace') ?? os.homedir()),
    strings.aboutDshHome(dshHome),
    strings.aboutSettings(settings.file ?? strings.notInitialized),
    strings.aboutLogs(log.file),
  ].join('\n');

  await dialog.showMessageBox(win ?? undefined, {
    type: 'info',
    title: strings.aboutTitle,
    message: 'DeepSeek Harness Desktop',
    detail: details,
    buttons: [strings.ok],
    noLink: true,
  });
}

/* -------------------------------------------------------------------------- *
 * Close behaviour
 * -------------------------------------------------------------------------- */

/**
 * Decide what closing the window means.
 *
 * With the tray available, the default is to *ask* — and to remember the answer, because being
 * asked every single time is its own kind of broken.
 *
 * @returns {Promise<void>}
 */
async function handleCloseRequest() {
  const behavior = settings.get('closeBehavior');

  if (behavior === 'tray') {
    windowManager.hide();
    return;
  }
  if (behavior === 'quit') {
    requestQuit();
    return;
  }

  const win = windowManager.get();
  const result = await dialog.showMessageBox(win ?? undefined, {
    type: 'question',
    title: strings.closeTitle,
    message: strings.closeMessage,
    detail: strings.closeDetail,
    buttons: [strings.closeToTray, strings.closeQuit, strings.cancel],
    defaultId: 0,
    cancelId: 2,
    checkboxLabel: strings.closeRemember,
    checkboxChecked: false,
    noLink: true,
  });

  if (result.response === 2) {
    return;
  }

  const chosen = result.response === 0 ? 'tray' : 'quit';
  if (result.checkboxChecked) {
    settings.set({ closeBehavior: chosen });
    settings.flush();
  }

  if (chosen === 'tray') {
    windowManager.hide();
  } else {
    requestQuit();
  }
}

/** Begin a clean shutdown. */
function requestQuit() {
  quitting = true;
  app.quit();
}

/* -------------------------------------------------------------------------- *
 * Error-page actions
 * -------------------------------------------------------------------------- */

/**
 * @param {string} action
 * @returns {Promise<void>}
 */
async function handleAction(action) {
  switch (action) {
    case 'retry':
      await restartBackend();
      return;

    case 'open-logs':
      windowManager.revealInFolder(log.file);
      return;

    case 'pick-dsh':
      await pickDshBinary();
      return;

    case 'pick-node':
      await pickNodeBinary();
      return;

    case 'open-nodejs':
      void shell.openExternal('https://nodejs.org/en/download');
      return;

    case 'quit':
      requestQuit();
      return;

    default:
      log.write(`unknown action: ${action}`, { source: 'warn' });
  }
}

/**
 * Let the user point the shell at a `bin.js` by hand, for when the npx cache was collected.
 *
 * @returns {Promise<void>}
 */
async function pickDshBinary() {
  const win = windowManager.get();
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: strings.pickDshTitle,
    properties: ['openFile'],
    filters: [{ name: strings.pickDshFilter, extensions: ['js'] }],
    buttonLabel: strings.pickDshButton,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return;
  }

  const chosen = result.filePaths[0];
  if (path.basename(chosen) !== 'bin.js') {
    await dialog.showMessageBox(win ?? undefined, {
      type: 'warning',
      title: strings.pickDshWrongTitle,
      message: strings.pickDshWrongMessage,
      buttons: [strings.ok, strings.cancel],
      defaultId: 1,
      noLink: true,
    });
  }

  settings.set({ dshBin: chosen, dshVersion: null });
  settings.flush();
  log.write(`dsh binary set manually: ${chosen}`);
  await restartBackend();
}

/**
 * @returns {Promise<void>}
 */
async function pickNodeBinary() {
  const win = windowManager.get();
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: strings.pickNodeTitle,
    properties: ['openFile'],
    filters: [{ name: strings.pickNodeFilter, extensions: ['exe'] }],
    buttonLabel: strings.pickNodeButton,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return;
  }

  const chosen = result.filePaths[0];
  settings.set({ nodePath: chosen });
  settings.flush();
  log.write(`node path set manually: ${chosen}`);
  await restartBackend();
}

/* -------------------------------------------------------------------------- *
 * App lifecycle
 * -------------------------------------------------------------------------- */

// A second launch must focus the existing window rather than start a rival backend.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log.write('second instance attempted; focusing existing window');
    windowManager.reveal();
  });

  // Every web contents — the main window and anything created later — gets the same policy.
  app.on('web-contents-created', (_event, contents) => {
    security.attach(contents);
  });

  app.on('window-all-closed', () => {
    // With a tray present the app is expected to outlive its window; without one, staying
    // resident would leave an unreachable process behind.
    if (chrome.tray === null) {
      requestQuit();
    }
  });

  app.on('activate', () => {
    windowManager.reveal();
  });

  // Keep the window reachable from the taskbar even while hidden.
  app.on('before-quit', (event) => {
    if (shuttingDown) {
      return;
    }
    event.preventDefault();
    void shutdown();
  });

  app.whenReady().then(bootstrap);
}

/**
 * Stop the backend, flush settings, and quit for real.
 *
 * The `before-quit` preventDefault above means this runs exactly once, and it is the only place
 * that guarantees the backend process tree is gone before Electron exits (acceptance item 3).
 *
 * @returns {Promise<void>}
 */
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  quitting = true;

  log.write('shutting down');
  chrome.destroyTray();

  try {
    await backend.stop();
  } catch (error) {
    log.write(
      `error while stopping backend: ${error instanceof Error ? error.message : String(error)}`,
      { source: 'warn' },
    );
  }

  settings.flush();
  log.write('shutdown complete');
  app.exit(0);
}

module.exports = { resolveDshHome, resolveUserDataDir };
