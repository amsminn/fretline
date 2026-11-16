import { _electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { QaContext } from './contracts';
import { QaFailure } from './contracts';

export type ElectronSurface = { readonly application: ElectronApplication; readonly page: Page };
type OwnedElectron = { readonly application: ElectronApplication; readonly close: () => Promise<void> };
const launches = new Set<Promise<OwnedElectron>>();

export async function closeElectronApplications(): Promise<void> {
  await Promise.all([...launches].map(async pending => { await (await pending).close(); }));
}

export async function withElectron(context: QaContext, action: (surface: ElectronSurface) => Promise<void>): Promise<void> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    .map(signal => ({ signal, existing: new Set(process.listeners(signal)) }));
  let expectedClose = false;
  const pending = _electron.launch({
    ...(context.app ? { executablePath: resolve(context.app, 'Contents/MacOS/Fretline'), args: [] } : { args: [resolve('out/main/index.js')] }),
    // Hidden window by default; run with FRETLINE_QA_HEADLESS=0 to watch a case.
    env: { ...environment, FRETLINE_QA: '1', FRETLINE_QA_HEADLESS: environment['FRETLINE_QA_HEADLESS'] ?? '1', FRETLINE_QA_PARENT_PID: String(process.pid), FRETLINE_QA_EVIDENCE: context.evidence },
    timeout: 30_000,
  }).then(application => {
    // Playwright Electron installs its own process handlers (SIGINT exits 130).
    // The runner owns interruption evidence, so retain only handlers present before launch.
    for (const { signal, existing } of handlers) {
      for (const listener of process.listeners(signal)) {
        if (!existing.has(listener)) process.off(signal, listener);
      }
    }
    const child = application.process();
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        expectedClose = true;
        // An interruption can arrive before main has created its first window.
        // Playwright's app.quit handshake can then stall; bound it by the owned process group.
        const deadline = setTimeout(() => {
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
            }
          }
        }, 5_000);
        try {
          if (child.exitCode === null && child.signalCode === null) await application.close();
        } finally {
          clearTimeout(deadline);
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>(done => child.once('exit', () => done()));
            child.kill('SIGKILL');
            await exited;
          }
          context.cleanup.push({ name: 'Electron', pid: child.pid, exitCode: child.exitCode, signal: child.signalCode,
            reaped: child.exitCode !== null || child.signalCode !== null });
          context.log(`Electron cleanup PID ${child.pid}: exit=${child.exitCode} signal=${child.signalCode}`);
        }
      })();
      return closing;
    };
    context.log(`Electron started PID ${child.pid}`);
    return { application, close };
  });
  launches.add(pending);
  let owned: OwnedElectron | undefined;
  try {
    owned = await pending;
    const { application } = owned;
    let crashed = false;
    let runtimeError: string | undefined;
    application.on('close', () => { if (!expectedClose) crashed = true; });
    const page = await application.firstWindow();
    // A window proves main has run (and armed its parent watchdog); launch alone
    // only proves Playwright attached to Electron's pre-main debugger.
    console.log(`Electron started PID ${application.process().pid}`);
    page.on('crash', () => { crashed = true; });
    page.on('pageerror', error => { runtimeError = error.message; });
    page.on('console', message => context.log(`renderer ${message.type()}: ${message.text()}`));
    Object.assign(context.versions, await application.evaluate(() => process.versions));
    try {
      await page.getByTestId('renderer-ready').waitFor({ state: 'visible', timeout: 20_000 });
      await action({ application, page });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (crashed) throw new QaFailure('crash', 'Electron application or renderer crashed');
      if (!page.isClosed()) await page.screenshot({ path: resolve(context.evidence, 'failure.png') });
      throw error;
    }
    if (crashed) throw new QaFailure('crash', 'Electron application or renderer crashed');
    context.assert(runtimeError === undefined, `Renderer has no uncaught errors${runtimeError ? `: ${runtimeError}` : ''}`);
  } finally {
    try { await owned?.close(); }
    finally { launches.delete(pending); }
  }
}
