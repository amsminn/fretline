import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acknowledgeClose, cancelClose, coordinateClose, isClosePending, receiptDeadlineMs, receiveClose } from '../../src/main/window-close';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue, MenuItemConstructorOptions } from 'electron';
import { PlaybackThrottlingOwner } from '../../src/main/playback-throttling';
import { installApplicationMenu } from '../../src/main/menu';
import { setLanguage } from '../../src/renderer/i18n/language';

const desktop = vi.hoisted(() => ({
  message: vi.fn<(_window: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>(),
  quit: vi.fn<() => void>(),
  menu: vi.fn<(template: MenuItemConstructorOptions[]) => MenuItemConstructorOptions[]>(),
}));
vi.mock('electron', () => ({
  dialog: { showMessageBox: desktop.message },
  app: { quit: desktop.quit, on: () => {}, showAboutPanel: () => {} },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  Menu: { buildFromTemplate: desktop.menu, setApplicationMenu: () => {} },
}));

type Listener = (event: { preventDefault: () => void }) => void;
function fakeWindow() {
  const listeners = new Map<string, Listener[]>();
  const sent: string[] = [];
  let destroyed = false;
  let crashed = false;
  let beforeUnloadBlocked = false;
  let closes = 0;
  const contentsListeners = new Map<string, (() => void)[]>();
  const window = {
    on: (name: string, listener: Listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return window; },
    once: (name: string, listener: Listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return window; },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      for (const listener of listeners.get('closed') ?? []) listener({ preventDefault: () => {} });
    },
    webContents: {
      isCrashed: () => crashed, send: (channel: string) => { sent.push(channel); },
      on: (name: string, listener: () => void) => { contentsListeners.set(name, [...(contentsListeners.get(name) ?? []), listener]); },
    },
    close: () => {
      closes++;
      let prevented = false;
      for (const listener of listeners.get('close') ?? []) listener({ preventDefault: () => { prevented = true; } });
      if (!prevented && !beforeUnloadBlocked) window.destroy();
      return !prevented;
    },
  };
  return { window: window as unknown as BrowserWindow, sent, closes: () => closes, destroyed: () => destroyed, close: () => window.close(),
    rendererEvent: (name: string) => { for (const listener of contentsListeners.get(name) ?? []) listener(); },
    crash: () => { crashed = true; },
    blockBeforeUnload: () => { beforeUnloadBlocked = true; },
  };
}
function closeRequest(fake: ReturnType<typeof fakeWindow>, via: 'window' | 'quit'): () => void {
  if (via === 'window') return () => { fake.close(); };
  desktop.quit.mockImplementation(() => { fake.close(); });
  installApplicationMenu();
  const quit = desktop.menu.mock.calls.flatMap(([template]) => template)
    .flatMap(item => Array.isArray(item.submenu) ? item.submenu : []).find(item => item.id === 'file.quit');
  const click = quit?.click;
  if (typeof click !== 'function') throw new TypeError('Missing native quit action');
  return () => { Reflect.apply(click, undefined, []); };
}
beforeEach(() => {
  vi.useFakeTimers();
  desktop.message.mockReset().mockResolvedValue({ response: 0, checkboxChecked: false });
  desktop.quit.mockReset();
  desktop.menu.mockReset().mockImplementation(template => template);
  setLanguage('ko');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); setLanguage('ko'); });

it('keeps a busy renderer open beyond the receipt deadline until it explicitly approves close', () => {
  const fake = fakeWindow();
  coordinateClose(fake.window);
  expect(fake.close()).toBe(false);
  expect(fake.sent).toEqual(['desktop:close-requested']);
  vi.advanceTimersByTime(receiptDeadlineMs);
  expect(fake.destroyed()).toBe(false);
  expect(isClosePending(fake.window)).toBe(false);
  expect(desktop.message).not.toHaveBeenCalled();
  receiveClose(fake.window);
  acknowledgeClose(fake.window);
  expect(fake.destroyed()).toBe(true);
});

it('cancels a pending close when the renderer is unresponsive but alive', () => {
  const fake = fakeWindow();
  coordinateClose(fake.window);
  fake.close();

  fake.rendererEvent('unresponsive');
  vi.advanceTimersByTime(receiptDeadlineMs * 10);

  expect(fake.destroyed()).toBe(false);
  expect(isClosePending(fake.window)).toBe(false);
  fake.rendererEvent('responsive');
  expect(fake.close()).toBe(false);
  receiveClose(fake.window);
  acknowledgeClose(fake.window);
  expect(fake.destroyed()).toBe(true);
});

it('does not send a close request while the renderer is known to be unresponsive', () => {
  const fake = fakeWindow();
  coordinateClose(fake.window);
  fake.rendererEvent('unresponsive');

  expect(fake.close()).toBe(false);
  vi.advanceTimersByTime(receiptDeadlineMs * 10);

  expect(fake.destroyed()).toBe(false);
  expect(isClosePending(fake.window)).toBe(false);
  expect(fake.sent).toEqual([]);
});

it.each(['window', 'quit'] as const)('offers one native decision for repeated unresponsive %s requests and Wait restores normal closing', async via => {
  const fake = fakeWindow();
  coordinateClose(fake.window);
  const request = closeRequest(fake, via);
  const decision = Promise.withResolvers<MessageBoxReturnValue>();
  desktop.message.mockReturnValueOnce(decision.promise);
  fake.rendererEvent('unresponsive');

  request();
  request();
  vi.advanceTimersByTime(receiptDeadlineMs * 10);

  expect(desktop.message).toHaveBeenCalledOnce();
  expect(fake.destroyed()).toBe(false);
  expect(fake.sent).toEqual([]);
  decision.resolve({ response: 0, checkboxChecked: false });
  await decision.promise;
  expect(fake.destroyed()).toBe(false);
  fake.rendererEvent('responsive');
  request();
  expect(fake.sent).toEqual(['desktop:close-requested']);
  receiveClose(fake.window);
  acknowledgeClose(fake.window);
  expect(fake.destroyed()).toBe(true);
});

it.each(['window', 'quit'] as const)('Close Anyway destroys a hung renderer on %s without waiting for beforeunload', async via => {
  const fake = fakeWindow();
  coordinateClose(fake.window);
  const request = closeRequest(fake, via);
  const decision = Promise.withResolvers<MessageBoxReturnValue>();
  desktop.message.mockReturnValueOnce(decision.promise);
  fake.blockBeforeUnload();
  fake.rendererEvent('unresponsive');

  request();
  decision.resolve({ response: 1, checkboxChecked: false });
  await decision.promise;

  expect(desktop.message).toHaveBeenCalledOnce();
  expect(fake.destroyed()).toBe(true);
  expect(fake.sent).toEqual([]);
});

it.each([
  { language: 'ko', title: 'Fretline이 응답하지 않습니다.', detail: '저장하지 않은 변경 사항이 손실될 수 있습니다.', buttons: ['기다리기', '강제로 닫기'] },
  { language: 'en', title: 'Fretline is not responding.', detail: 'Unsaved changes may be lost.', buttons: ['Wait', 'Close Anyway'] },
] as const)('uses the current $language language and makes Wait the native default and cancellation response', async ({ language, title, detail, buttons }) => {
  const fake = fakeWindow();
  coordinateClose(fake.window);
  setLanguage(language);
  fake.rendererEvent('unresponsive');

  fake.close();
  await vi.advanceTimersByTimeAsync(0);

  expect(desktop.message).toHaveBeenCalledWith(fake.window, {
    type: 'warning', title, message: title, detail, buttons: [...buttons], defaultId: 0, cancelId: 0, noLink: true,
  });
  expect(fake.destroyed()).toBe(false);
});

it('keeps the window open when the native decision is dismissed and permits another decision', async () => {
  const fake = fakeWindow();
  coordinateClose(fake.window);
  fake.rendererEvent('unresponsive');
  desktop.message.mockResolvedValueOnce({ response: -1, checkboxChecked: false });

  fake.close();
  await vi.advanceTimersByTimeAsync(0);

  expect(fake.destroyed()).toBe(false);
  fake.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(desktop.message).toHaveBeenCalledTimes(2);
  expect(fake.destroyed()).toBe(false);
});

it('uses the existing Electron dialog stub under headless QA for an explicit force-close choice', async () => {
  vi.stubEnv('FRETLINE_QA', '1');
  vi.stubEnv('FRETLINE_QA_HEADLESS', '1');
  const fake = fakeWindow();
  coordinateClose(fake.window);
  desktop.message.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
  fake.rendererEvent('unresponsive');

  fake.close();
  await vi.advanceTimersByTimeAsync(0);

  expect(desktop.message).toHaveBeenCalledOnce();
  expect(fake.destroyed()).toBe(true);
});

it('allows a pending close only when the renderer process actually disappears', () => {
  const fake = fakeWindow();
  coordinateClose(fake.window);
  fake.close();

  fake.rendererEvent('render-process-gone');

  expect(fake.destroyed()).toBe(true);
  expect(isClosePending(fake.window)).toBe(false);
});

it('allows closing an already crashed renderer without waiting for an answer', () => {
  const fake = fakeWindow();
  coordinateClose(fake.window);
  fake.crash();
  expect(fake.close()).toBe(true);
  expect(fake.sent).toEqual([]);
});

it('never closes on elapsed time once receipt is confirmed; only an explicit outcome ends the request', () => {
  const fake = fakeWindow();
  coordinateClose(fake.window);
  fake.close();
  receiveClose(fake.window);
  vi.advanceTimersByTime(receiptDeadlineMs * 10);
  expect(fake.destroyed()).toBe(false);
  expect(isClosePending(fake.window)).toBe(true);
  expect(fake.close()).toBe(false);
  expect(fake.sent).toEqual(['desktop:close-requested']);
  cancelClose(fake.window);
  expect(isClosePending(fake.window)).toBe(false);
  expect(fake.close()).toBe(false);
  expect(fake.sent).toEqual(['desktop:close-requested', 'desktop:close-requested']);
  receiveClose(fake.window);
  acknowledgeClose(fake.window);
  expect(fake.destroyed()).toBe(true);
});

it('keeps playback throttling disabled when a close request is cancelled', () => {
  const fake = fakeWindow();
  const allowed: boolean[] = [];
  const owner = new PlaybackThrottlingOwner({
    setAllowed: value => { allowed.push(value); },
    onDidFinishLoad: () => {},
    onRendererGone: () => {},
    onWindowClosed: listener => { fake.window.once('closed', () => { listener(); }); },
  }, true);
  coordinateClose(fake.window);
  owner.setActive(true);
  expect(fake.close()).toBe(false);
  cancelClose(fake.window);
  owner.setActive(true);
  expect(allowed).toEqual([false]);
});
