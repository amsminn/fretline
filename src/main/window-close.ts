import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { t } from '../renderer/i18n';

type Pending = { readonly timer: ReturnType<typeof setTimeout> | null };
const acknowledged = new WeakSet<BrowserWindow>();
const pending = new WeakMap<BrowserWindow, Pending>();
export const receiptDeadlineMs = 3_000;

/**
 * Close and quit both route through the renderer: main holds the window, the renderer confirms it
 * RECEIVED the request (which disarms the unresponsive-renderer deadline), runs the save-changes flow
 * for as long as the user needs, and ends it with an explicit outcome: acknowledgeClose (the same window
 * close runs again unblocked, letting a pending quit proceed) or cancelClose. A missed receipt deadline
 * cancels the request. An unresponsive renderer requires a native force-close decision; only that
 * explicit approval, an explicit renderer outcome, or an actually gone renderer permits closing.
 */
export function coordinateClose(window: BrowserWindow): void {
  let unresponsive = false;
  let gone = false;
  let confirming = false;
  const confirmForceClose = async (): Promise<void> => {
    confirming = true;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning', title: t('main.close.unresponsive'), message: t('main.close.unresponsive'),
        detail: t('main.close.unsavedWarning'),
        buttons: [t('main.close.wait'), t('main.close.anyway')], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response === 1 && !window.isDestroyed()) {
        forget(window);
        // The renderer cannot answer beforeunload either; only this explicit choice may bypass it.
        window.destroy();
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(error);
    } finally { confirming = false; }
  };
  window.webContents.on('unresponsive', () => {
    unresponsive = true;
    cancelClose(window);
  });
  window.webContents.on('responsive', () => { unresponsive = false; });
  window.webContents.on('render-process-gone', () => {
    gone = true;
    if (confirming || pending.has(window)) acknowledgeClose(window);
  });
  window.webContents.on('did-finish-load', () => { gone = false; unresponsive = false; });
  window.on('close', event => {
    if (acknowledged.has(window) || gone || window.webContents.isCrashed()) return;
    event.preventDefault();
    if (confirming) return;
    if (unresponsive) { void confirmForceClose(); return; }
    if (pending.has(window)) return;
    window.webContents.send('desktop:close-requested');
    pending.set(window, { timer: setTimeout(() => cancelClose(window), receiptDeadlineMs) });
  });
  window.once('closed', () => { forget(window); });
}
function forget(window: BrowserWindow): void {
  const entry = pending.get(window);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(window);
}
export function receiveClose(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  const entry = pending.get(window);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pending.set(window, { timer: null });
}
export function cancelClose(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  forget(window);
}
export function acknowledgeClose(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || acknowledged.has(window)) return;
  forget(window);
  acknowledged.add(window);
  window.close();
}
export const isClosePending = (window: BrowserWindow): boolean => pending.has(window);
