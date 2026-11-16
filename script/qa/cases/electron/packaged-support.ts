import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { _electron, expect } from '@playwright/test';
import type { QaContext } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import { koreanSystem } from '../../lib/electron';

/** Keep the app cwd outside the checkout while the runner retains its own fixture paths. */
export async function withPackage(context: QaContext, fixture: string,
  action: (surface: ImportSurface) => Promise<void>): Promise<void> {
  const app = resolve(context.app ?? 'dist/mac-arm64/Fretline.app');
  const outside = await mkdtemp(resolve(tmpdir(), 'fretline-package-cwd-'));
  try {
    const input = resolve(outside, 'input.fretline');
    await copyFile(fixture, input);
    const environment = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
    const application = await _electron.launch({
      executablePath: resolve(app, 'Contents/MacOS/Fretline'), args: [input, ...koreanSystem], cwd: outside,
      env: { ...environment, FRETLINE_QA: '1', FRETLINE_QA_HEADLESS: '1',
        FRETLINE_USER_DATA: resolve(outside, 'userData'),
        FRETLINE_QA_PARENT_PID: String(process.pid), FRETLINE_QA_EVIDENCE: context.evidence },
      timeout: 30_000,
    });
    const child = application.process();
    child.stderr?.on('data', (bytes: Buffer) => context.log(`main stderr: ${bytes.toString('utf8')}`));
    context.log(`Packaged Electron started PID ${child.pid}; cwd=${outside}`);
    try {
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => context.log(`renderer ${message.type()}: ${message.text()}`));
      Object.assign(context.versions, await application.evaluate(() => process.versions));
      await page.getByTestId('renderer-ready').waitFor({ timeout: 30_000 });
      const runtime = await application.evaluate(({ app, BrowserWindow }) => ({
        cwd: process.cwd(), packaged: app.isPackaged, app: app.getAppPath(),
        data: app.getPath('userData'), hidden: BrowserWindow.getAllWindows().every(window => !window.isVisible()),
      }));
      context.log(JSON.stringify(runtime));
      context.assert(runtime.packaged && runtime.app === resolve(await realpath(app), 'Contents/Resources/app.asar') &&
        runtime.cwd === await realpath(outside) &&
        runtime.hidden && await realpath(runtime.data) === await realpath(resolve(outside, 'userData')),
      'Real packaged executable runs hidden outside checkout with isolated application data');
      const network = await page.evaluate(async () => {
        const probes = await Promise.all(['https://example.com/', 'http://example.com/'].map(async url => {
          try { await fetch(url); return false; } catch (error) { if (!(error instanceof TypeError)) throw error; return true; }
        }));
        return probes.every(Boolean);
      });
      context.assert(network, 'Production CSP and session policy block HTTP and HTTPS');
      await action({ application, page });
      const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
      context.assert(resources.every(url => /^(app:\/\/fretline\/|blob:|data:)/.test(url) || /^https?:/.test(url)),
        'Renderer loads resources exclusively through package protocol or in-memory URLs');
      context.log(`Resources: ${JSON.stringify(resources)}`);
      await expect(page.getByTestId('renderer-ready')).toBeVisible();
      context.assert(errors.length === 0, `No uncaught renderer errors: ${errors.join('; ')}`);
    } finally {
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try { await application.close(); } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(done => child.once('exit', () => done()));
          child.kill('SIGKILL'); await exited;
        }
        let gone = false;
        try { if (child.pid !== undefined) process.kill(child.pid, 0); }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') gone = true; else throw error; }
        context.cleanup.push({ name: 'Packaged Electron (kill-0 failed)', pid: child.pid,
          exitCode: child.exitCode, signal: child.signalCode, reaped: gone });
        context.log(`Packaged Electron teardown ${child.pid}: kill-0 fails=${gone}`);
      }
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
    context.log(`Removed outside working directory ${outside}`);
  }
}
