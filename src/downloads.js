'use strict';

/**
 * Download handling.
 *
 * In a browser the download shelf tells the user where a file went. Electron has no such
 * affordance: `will-download` fires, the file lands silently, and the user is left guessing —
 * which is exactly what happens today for dsh's session-log export and document preview
 * (both send `Content-Disposition: attachment`). This module restores the missing feedback.
 *
 * The default save location is the user's Downloads folder, and the OS save dialog is offered
 * so the destination is always explicit.
 */

const { Notification, dialog, shell } = require('electron');
const path = require('path');

class DownloadManager {
  /**
   * @param {object} options
   * @param {import('./log').BackendLog} options.log
   */
  constructor({ log }) {
    this.log = log;
    /** @type {import('electron').BrowserWindow|null} */
    this.window = null;
    /** Downloads seen in this session, newest last. Exposed for the tray/menu. */
    this.history = [];
  }

  /**
   * @param {import('electron').BrowserWindow|null} win Parent for dialogs.
   */
  setWindow(win) {
    this.window = win;
  }

  /**
   * Attach the download listener to a session.
   *
   * @param {import('electron').Session} session
   */
  attach(session) {
    session.on('will-download', (_event, item) => {
      this.handle(item);
    });
  }

  /**
   * @param {import('electron').DownloadItem} item
   */
  handle(item) {
    const filename = item.getFilename();
    // Let the user choose where it goes. Without this, `savePath` defaults to the OS download
    // directory and the file appears with no acknowledgement at all.
    item.setSaveDialogOptions({
      title: `保存 ${filename}`,
      defaultPath: path.join(downloadDirectory(), filename),
      buttonLabel: '保存',
    });

    this.log.write(`download started: ${filename}`);

    item.on('updated', (_event, state) => {
      if (state === 'interrupted') {
        this.log.write(`download interrupted: ${filename}`, { source: 'warn' });
      }
    });

    item.once('done', (_event, state) => {
      const target = item.getSavePath() || filename;
      if (state === 'completed') {
        this.log.write(`download completed: ${target}`);
        this.history.push({ path: target, at: new Date().toISOString(), state });
        this.announce(target);
      } else {
        this.log.write(`download ${state}: ${filename}`, { source: 'warn' });
        this.history.push({ path: target, at: new Date().toISOString(), state });
        this.reportFailure(filename, state);
      }
    });
  }

  /**
   * Confirm a completed download and offer to reveal it.
   *
   * A notification is used when nothing is focused; a modal dialog when the window is
   * visible, because a toast while the user is watching the window is easy to miss and the
   * plan explicitly asks for a clear "saved to <path>" prompt.
   *
   * @param {string} target Absolute path the file was written to.
   */
  announce(target) {
    const win = this.window;
    const offline = win === null || win.isDestroyed() || !win.isVisible();

    if (offline && Notification.isSupported()) {
      const notification = new Notification({
        title: '下载完成',
        body: path.basename(target),
      });
      notification.on('click', () => shell.showItemInFolder(target));
      notification.show();
      return;
    }

    void dialog
      .showMessageBox(win ?? undefined, {
        type: 'info',
        title: '下载完成',
        message: `已保存到：\n${target}`,
        detail: '可以打开所在文件夹来查看该文件。',
        buttons: ['打开所在文件夹', '关闭'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((result) => {
        if (result.response === 0) {
          shell.showItemInFolder(target);
        }
      });
  }

  /**
   * @param {string} filename
   * @param {string} state
   */
  reportFailure(filename, state) {
    const win = this.window;
    if (win === null || win.isDestroyed()) {
      return;
    }
    const reason = state === 'cancelled' ? '下载已取消。' : '下载被中断。';
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: '下载未完成',
      message: `${filename}：${reason}`,
      buttons: ['确定'],
      noLink: true,
    });
  }
}

/**
 * Resolve the OS "Downloads" folder without a native dependency.
 *
 * `app.getPath('downloads')` is authoritative, but it is only available after the `ready`
 * event; the fallback keeps this module usable earlier.
 *
 * @returns {string}
 */
function downloadDirectory() {
  try {
    const { app } = require('electron');
    const resolved = app.getPath('downloads');
    if (resolved) {
      return resolved;
    }
  } catch {
    // `app` unavailable or not ready yet.
  }
  return process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Downloads') : process.cwd();
}

module.exports = { DownloadManager, downloadDirectory };
