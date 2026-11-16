import { app, BrowserWindow, protocol, screen, session } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationUrl, assetBody, contentSecurityPolicy, documentNonce, isApplicationUrl, nonceBody, resolveAssetPath } from './protocol';
import { installApplicationMenu } from './menu';
import { applicationLanguage, applicationSettings, registerIpcHandlers } from './ipc';
import { setLanguage } from '../renderer/i18n/language';
import type { WindowBounds } from './settings';
import { coordinateClose } from './window-close';
import { registerPlaybackThrottling } from './playback-throttling';

const directory = dirname(fileURLToPath(import.meta.url));
const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);
app.enableSandbox();
app.setName('Fretline');
// QA runs must never read or write the user's real Fretline data (recovery, preferences, recent files).
// A QA launch uses FRETLINE_USER_DATA when pinned (relaunch scenarios); otherwise an isolated temporary
// directory that is removed when the app quits.
if (process.env['FRETLINE_QA'] === '1') {
  const pinned = process.env['FRETLINE_USER_DATA'];
  const userData = pinned ?? mkdtempSync(join(tmpdir(), 'fretline-qa-userdata-'));
  app.setPath('userData', userData);
  if (!pinned) app.once('will-quit', () => rmSync(userData, { recursive: true, force: true }));
  const parent = process.env['FRETLINE_QA_PARENT_PID'];
  if (parent !== undefined) {
    const parentPid = Number(parent);
    if (!/^[1-9]\d*$/.test(parent) || !Number.isSafeInteger(parentPid)) app.exit(70);
    const watchdog = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
        if (!pinned) rmSync(userData, { recursive: true, force: true });
        app.exit(70);
      }
    }, 1_000);
    watchdog.unref();
    app.once('will-quit', () => clearInterval(watchdog));
  }
}

// QA runs drive the app through the debugging protocol, so the window never needs to appear on the user's screen.
const headlessQa = process.env['FRETLINE_QA'] === '1' && process.env['FRETLINE_QA_HEADLESS'] === '1';
const qaUsesProductionThrottling = process.env['FRETLINE_QA_THROTTLING'] === 'production';
if (headlessQa) app.dock?.hide();

/** A remembered position is reused only while some display still shows at least part of the title area. */
function restoredBounds(): WindowBounds {
  const settings = applicationSettings().get();
  const fallback = { width: 1440, height: 900 };
  if (!settings.restoreWindow || !settings.window) return fallback;
  const { width, height, x, y } = settings.window;
  if (x === undefined || y === undefined) return { width, height };
  const visible = screen.getAllDisplays().some(display => {
    const area = display.workArea;
    return x + width > area.x + 64 && x < area.x + area.width - 64 && y >= area.y - 8 && y < area.y + area.height - 64;
  });
  return visible ? { width, height, x, y } : { width, height };
}
function rememberBounds(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = (): void => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const { width, height, x, y } = window.getNormalBounds();
    applicationSettings().setWindow({ width, height, x, y });
  };
  const schedule = (): void => { clearTimeout(timer); timer = setTimeout(save, 500); };
  window.on('resize', schedule);
  window.on('move', schedule);
  window.once('closed', () => clearTimeout(timer));
}
function createWindow(): void {
  const window = new BrowserWindow({
    ...restoredBounds(),
    title: 'Fretline',
    show: !headlessQa,
    webPreferences: {
      backgroundThrottling: !headlessQa || qaUsesProductionThrottling,
      preload: join(directory, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  registerPlaybackThrottling(window);
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  rememberBounds(window);
  coordinateClose(window);
  void window.loadURL(applicationUrl);
}

void app.whenReady().then(() => {
  const root = join(directory, '../renderer');
  protocol.handle('app', async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const asset = await resolveAssetPath(root, request.url);
    if (!asset) return new Response(null, { status: 404 });
    const nonce = documentNonce();
    const body = request.method === 'HEAD' ? null : nonceBody(asset, assetBody(asset, new Uint8Array(await readFile(asset)), process.env), nonce);
    return new Response(body, {
      headers: {
        'Content-Type': contentTypes[extname(asset)] ?? 'application/octet-stream',
        'Content-Security-Policy': contentSecurityPolicy(nonce),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isApplicationUrl(details.url) && !details.url.startsWith('devtools:') });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  setLanguage(applicationLanguage());
  installApplicationMenu();
  registerIpcHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => app.quit());
