import { _electron, expect } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import packageMetadata from '../../package.json';
import type { DesktopBridge } from '../../src/preload/index';
import { artifactManifest, fixtureHashes } from './artifacts';
import type { CleanupReceipt } from './lib/contracts';
import { qaPlanHash } from './lib/plan';

// allow: SIZE_OK — one end-to-end bootstrap audit owns the complete sandbox, bridge, asset and teardown receipt.
const { values } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== '--'),
  options: { case: { type: 'string' }, evidence: { type: 'string' } },
  strict: true,
});
const scenario = values.case;
if (scenario !== 'offline-shell' && scenario !== 'rejected-navigation') {
  throw new TypeError(`Unknown bootstrap case: ${scenario}`);
}
if (!values.evidence) throw new TypeError('--evidence is required');
const evidence = resolve(values.evidence);
await mkdir(evidence, { recursive: true });
const actions: string[] = [];
const assertions: { readonly name: string; readonly passed: boolean }[] = [];
const assetStatuses: { readonly url: string; readonly status: number }[] = [];
const errors: string[] = [];
const cleanup: CleanupReceipt[] = [];
let application: ElectronApplication | undefined;
let child: ChildProcess | undefined;
let failure: string | undefined;
let pid: number | undefined;
let closed = false;
const record = (name: string): void => {
  assertions.push({ name, passed: true });
  actions.push(`${new Date().toISOString()} ${name}`);
};
const hash = async (path: string): Promise<string> =>
  createHash('sha256').update(await readFile(path)).digest('hex');
let versions: Readonly<Record<string, string | undefined>> = { bun: process.versions['bun'] };
const environment: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value !== undefined) environment[name] = value;
}
environment['FRETLINE_QA'] = '1';
environment['FRETLINE_QA_HEADLESS'] = '1';

try {
  application = await _electron.launch({
    args: [resolve('out/main/index.js')],
    env: environment,
    timeout: 30_000,
  });
  child = application.process();
  pid = child.pid;
  await application.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_request, callback) => callback({ cancel: true }));
  });
  actions.push('HTTP and HTTPS requests blocked at the Electron session boundary; all shell assets must remain local');
  versions = {
    ...await application.evaluate(() => process.versions),
    bun: process.versions['bun'],
    typescript: packageMetadata.devDependencies.typescript,
    vite: packageMetadata.devDependencies.vite,
    alphatab: packageMetadata.dependencies['@coderline/alphatab'],
    playwright: packageMetadata.devDependencies['@playwright/test'],
  };
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => actions.push(`renderer ${message.type()}: ${message.text()}`));
  page.on('requestfailed', request => actions.push(`request failed: ${request.url()} ${request.failure()?.errorText}`));
  await page.reload();
  record('Reloaded the real shell after HTTP/HTTPS blocking was installed');
  await expect(page.getByTestId('renderer-ready')).toBeVisible();
  await expect(page.getByTestId('home').getByText('alphaTab 로컬 번들', { exact: false })).toBeVisible();
  expect(page.url()).toBe('app://fretline/');
  record('Actual Electron window reached renderer-ready at app://fretline/');
  const isolation = await page.evaluate(() => ({
    require: typeof Reflect.get(window, 'require'),
    process: typeof Reflect.get(window, 'process'),
    fs: typeof Reflect.get(window, 'fs'),
    ipcRenderer: typeof Reflect.get(window, 'ipcRenderer'),
    invoke: typeof Reflect.get(window, 'invoke'),
    bridge: Object.fromEntries(Object.getOwnPropertyNames(window.desktop)
      .map(name => [name, typeof Reflect.get(window.desktop, name)])),
  }));
  expect(isolation).toEqual({
    require: 'undefined', process: 'undefined', fs: 'undefined', ipcRenderer: 'undefined', invoke: 'undefined',
    bridge: {
      bootstrapStatus: 'function',
      exportArtifact: 'function',
      exportArtifactSet: 'function',
      beginExportStream: 'function',
      writeExportStream: 'function',
      commitExportStream: 'function',
      abortExportStream: 'function',
      renderAudio: 'function',
      cancelAudioRender: 'function',
      onAudioRenderProgress: 'function',
      printPdf: 'function',
      printPages: 'function',
      createProject: 'function',
      openDocument: 'function',
      releaseDocument: 'function',
      saveProject: 'function',
      saveProjectAs: 'function',
      readAsset: 'function',
      writeRecovery: 'function',
      listRecovery: 'function',
      restoreRecovery: 'function',
      discardRecovery: 'function',
      pendingOpenFiles: 'function',
      recentFiles: 'function',
      openSelectedFile: 'function',
      onOpenFiles: 'function',
      menuSync: 'function',
      onMenuCommand: 'function',
      recentForget: 'function',
      recentPin: 'function',
      preferences: 'object',
      onCloseRequested: 'function',
      closeWindow: 'function',
      cancelClose: 'function',
      receiveClose: 'function',
      setPlaybackActive: 'function',
    } satisfies Record<keyof DesktopBridge, 'function' | 'object'>,
  });
  const sandboxed = await application.evaluate(({ app, BrowserWindow }) => {
    const rendererPid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
    return app.getAppMetrics().find(metric => metric.pid === rendererPid)?.sandboxed;
  });
  expect(sandboxed).toBe(true);
  record('Renderer cannot access require, process, fs, ipcRenderer or invoke; only allowlisted typed bridge functions are exposed');
  record('Electron OS process metrics confirm the actual renderer is sandboxed');
  const resources = await page.evaluate(() => [
    location.href,
    ...performance.getEntriesByType('resource').map(resource => resource.name),
  ]);
  for (const url of resources) {
    const parsed = new URL(url);
    expect({ protocol: parsed.protocol, host: parsed.host, username: parsed.username, password: parsed.password })
      .toEqual({ protocol: 'app:', host: 'fretline', username: '', password: '' });
  }
  // Chromium fetch, rather than Playwright's HTTP client, supports custom protocols.
  const emitted = await readdir('out/renderer', { recursive: true, withFileTypes: true });
  const assetPaths = emitted.filter(file => file.isFile())
    .map(file => resolve(file.parentPath, file.name).slice(resolve('out/renderer').length));
  const localAssets = await page.evaluate(async paths => {
    return Promise.all(paths.map(async path => {
      const url = new URL(path, location.href).href;
      const response = await fetch(url);
      return { url, status: response.status, csp: response.headers.get('Content-Security-Policy') };
    }));
  }, ['/', ...assetPaths]);
  for (const asset of localAssets) {
    expect(asset.status).toBe(200);
    expect(asset.csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    assetStatuses.push({ url: asset.url, status: asset.status });
  }
  record('Every loaded renderer asset responds 200 from the privileged app origin with CSP');

  switch (scenario) {
    case 'offline-shell': {
      const networkBlocked = await page.evaluate(async () => {
        try {
          await fetch('https://example.com/');
          return false;
        } catch (error) {
          if (error instanceof TypeError) return true;
          throw error;
        }
      });
      expect(networkBlocked).toBe(true);
      record('External network access is blocked while the local shell remains ready');
      break;
    }
    case 'rejected-navigation': {
      for (const url of ['http://example.com/', 'https://example.com/']) {
        await application.evaluate(({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          if (!contents) throw new TypeError('Missing main window');
          delete process.env['FRETLINE_BOOTSTRAP_NAVIGATION_PREVENTED'];
          contents.once('will-frame-navigate', event => setImmediate(() => {
            process.env['FRETLINE_BOOTSTRAP_NAVIGATION_PREVENTED'] = String(event.defaultPrevented);
          }));
        });
        await page.evaluate(url => {
          const link = document.createElement('a');
          link.href = url;
          document.body.append(link);
          link.click();
          link.remove();
        }, url);
        await expect.poll(() => application?.evaluate(() => process.env['FRETLINE_BOOTSTRAP_NAVIGATION_PREVENTED']),
          { timeout: 10_000 }).toBe('true');
        expect(page.url()).toBe('app://fretline/');
        record(`${url} navigation is cancelled and the main window is retained`);
        expect(await page.evaluate(url => window.open(url, '_blank') === null, url)).toBe(true);
      }
      expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
      record('window.open is denied without creating another window');
      const untrustedWindow = application.waitForEvent('window');
      await application.evaluate(async ({ BrowserWindow }, preload) => {
        const attacker = new BrowserWindow({
          show: false,
          webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'qa-untrusted' },
        });
        await attacker.loadURL('data:text/html,<title>Untrusted sender</title>');
      }, resolve('out/preload/index.cjs'));
      const attackerPage = await untrustedWindow;
      const rejected = await attackerPage.evaluate(async () => {
        try {
          await window.desktop.bootstrapStatus();
          return false;
        } catch (error) {
          if (error instanceof Error) return error.message.includes('REJECTED_SENDER');
          throw error;
        }
      });
      expect(rejected).toBe(true);
      await attackerPage.close();
      record('Real IPC from an untrusted sender is rejected by the normal production handler');
      expect(page.url()).toBe('app://fretline/');
      expect(await page.evaluate(() =>
        document.querySelector('[data-testid="renderer-ready"]')?.checkVisibility())).toBe(true);
      record('The original ready view remains visible after all rejected operations');
      break;
    }
  }
  expect(errors).toEqual([]);
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: resolve(evidence, `shell-${width}x${height}.png`) });
  }
  record('Desktop and compact desktop screenshots captured');
} catch (error) {
  if (!(error instanceof Error)) throw error;
  failure = error.stack ?? error.message;
  assertions.push({ name: error.message, passed: false });
  const page = application?.windows()[0];
  if (page && !page.isClosed()) {
    await page.screenshot({ path: resolve(evidence, 'failure.png') });
    await writeFile(resolve(evidence, 'failure.html'), await page.content());
    actions.push(`failure page URL: ${page.url()}`);
  }
} finally {
  if (application) {
    await application.close();
    closed = child !== undefined && (child.exitCode !== null || child.signalCode !== null);
    if (child) cleanup.push({ name: 'Electron', pid, exitCode: child.exitCode, signal: child.signalCode, reaped: closed });
    actions.push(`Electron PID ${pid}: exitCode=${child?.exitCode}, signalCode=${child?.signalCode}`);
  }
  if (!closed) {
    failure ??= 'Electron process did not terminate';
    assertions.push({ name: 'Electron process terminated', passed: false });
  } else record('Electron process terminated');
  await writeFile(resolve(evidence, 'actions.log'), `${actions.join('\n')}\n`);
  await writeFile(resolve(evidence, 'assets.json'), JSON.stringify(assetStatuses, null, 2));
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({
    case: scenario,
    status: failure ? 'FAIL' : 'PASS',
    exitCode: failure ? 1 : 0,
    assertions,
    versions,
    fixtureHashes: await fixtureHashes(),
    buildHashes: { renderer: await hash('out/renderer/index.html') },
    expectedNegativeChildren: [],
    artifacts: await artifactManifest(evidence),
    runner: 'bootstrap',
    headless: true,
    app: null,
    planHash: await qaPlanHash(),
    cleanup,
    failure: failure ? { kind: 'assertion', message: failure } : null,
  }, null, 2));
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
