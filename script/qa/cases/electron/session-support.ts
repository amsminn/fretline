import { _electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';

export type SessionSurface = { readonly application: ElectronApplication; readonly page: Page };
export type QuitReceipt = { readonly quitMs: number; readonly exitCode: number | null; readonly signal: string | null };

/** Pinned userData so settings, recent files and recovery survive the restart the scenarios exercise. */
export async function withSessionApp(context: QaContext, userData: string, action: (surface: SessionSurface) => Promise<void>): Promise<QuitReceipt> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
  const application = await _electron.launch({
    ...(context.app ? { executablePath: resolve(context.app, 'Contents/MacOS/Fretline'), args: [] } : { args: [resolve('out/main/index.js')] }),
    env: { ...environment, FRETLINE_QA: '1', FRETLINE_QA_HEADLESS: '1', FRETLINE_QA_PARENT_PID: String(process.pid),
      FRETLINE_QA_EVIDENCE: context.evidence, FRETLINE_USER_DATA: userData }, timeout: 30_000 });
  const child = application.process();
  context.log(`Started hidden Electron ${child.pid}; pinned userData=${userData}`);
  const errors: string[] = [];
  let page: Page | undefined;
  let quitMs = -1;
  try {
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => context.log(`renderer ${message.type()}: ${message.text()}`));
    Object.assign(context.versions, await application.evaluate(() => process.versions));
    await page.getByTestId('renderer-ready').waitFor({ timeout: 25_000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    await action({ application, page });
    context.assert(errors.length === 0, `No uncaught renderer errors: ${errors.join('; ')}`);
    if (child.exitCode === null && child.signalCode === null) {
      const started = performance.now();
      // Production quit path: app.quit() -> window close -> renderer save-changes flow + recovery flush -> acknowledged close -> exit.
      await application.evaluate(({ app }) => app.quit());
      // A dirty document keeps the save-changes prompt open; that is a scenario failure, not a reason to wait forever.
      let quitDeadline: ReturnType<typeof setTimeout> | undefined;
      const quitTimedOut = new Promise<never>((_, reject) => {
        quitDeadline = setTimeout(() => reject(new TypeError('app.quit() did not exit within 30 s (a save-changes prompt is still open?)')), 30_000);
      });
      try { await Promise.race([exited, quitTimedOut]); } finally { clearTimeout(quitDeadline); }
      quitMs = performance.now() - started;
      context.log(`app.quit() exited the process after ${quitMs.toFixed(0)} ms`);
    } else context.log('Process already exited inside the scenario');
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: resolve(context.evidence, 'failure.png') });
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      // Closing a window with unsaved edits opens the save-changes prompt; teardown is bounded by the owned child.
      const forced = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { context.log(`Teardown forced: SIGKILL owned Electron ${child.pid}`); child.kill('SIGKILL'); }
      }, 5_000);
      const exitedAfterClose = new Promise<void>(done => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once('exit', () => done()); });
      try { await Promise.race([application.close(), exitedAfterClose]); await exitedAfterClose; } finally { clearTimeout(forced); }
    }
    let gone = false;
    try { if (child.pid !== undefined) process.kill(child.pid, 0); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') gone = true; else throw error; }
    context.cleanup.push({ name: 'Session Electron (kill-0 failed)', pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, reaped: gone });
    context.log(`Electron teardown ${child.pid}: kill-0 fails=${gone}`);
  }
  return { quitMs, exitCode: child.exitCode, signal: child.signalCode };
}

export async function createFromTemplate(page: Page, kind: 'guitar' | 'bass' | 'drums'): Promise<void> {
  await page.getByTestId('home').waitFor();
  await page.locator(`[data-template="${kind}"]`).click();
  await waitForEditableScore(page);
}
export async function createThroughDialog(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Meta+n');
  await page.getByTestId('new-score-dialog').waitFor();
  await page.getByTestId('new-score-dialog').locator('input[name="title"]').fill(title);
  await page.getByTestId('create-score').click();
  await expect(page.getByTestId('new-score-dialog')).toBeHidden();
  await waitForEditableScore(page);
}
export async function waitForEditableScore(page: Page): Promise<void> {
  await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => {
    const map = window.fretlinePlaybackObservation?.().hits;
    const view = document.querySelector('[data-testid="score-view"]');
    return map !== undefined && (map.barSlots?.length ?? 0) > 0 && map.generation === Number(view?.getAttribute('data-generation'));
  }), { timeout: 20_000 }).toBe(true);
}
/** Clicks the first published bar slot and types one fret; the caret path is the production bar-slot entry. */
export async function enterFirstNote(context: QaContext, page: Page, fret: string): Promise<void> {
  const point = await page.evaluate(() => {
    const engine = document.querySelector('[data-testid="score-engine"]');
    const map = window.fretlinePlaybackObservation?.().hits;
    if (!engine || !map) return null;
    const box = engine.getBoundingClientRect();
    for (const slot of map.barSlots ?? []) {
      const x = box.x + slot.bounds.x + slot.bounds.width / 2;
      const y = box.y + slot.bounds.y + slot.bounds.height / 2;
      const target = document.elementFromPoint(x, y);
      if (target?.closest('[data-testid="score-view"]') && !target.closest('[data-symbol], [data-design-spacing], [role="dialog"], button')) {
        return { x, y, barSlot: slot.barSlot };
      }
    }
    return null;
  });
  if (!point) throw new TypeError('Template score has no clickable bar slot');
  context.log(`Click bar slot ${JSON.stringify(point.barSlot)} at (${point.x.toFixed(0)}, ${point.y.toFixed(0)}) then type ${fret}`);
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.focus.barSlot)).toEqual(point.barSlot);
  await expect(page.getByTestId('editor-caret')).toBeVisible();
  await page.keyboard.press(fret);
  await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
}
export const noteCount = (page: Page): Promise<number> => page.evaluate(() => {
  const score = window.fretlineArrangementObservation?.()?.score;
  if (!score) throw new TypeError('Missing document observation');
  return score.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice => voice.bars.flatMap(bar =>
    bar.kind === 'active' ? bar.events.filter(event => event.kind === 'noteGroup') : [])))).length;
});
export const scoreJson = (page: Page): Promise<string> => page.evaluate(() => JSON.stringify(window.fretlineArrangementObservation?.()?.score ?? null));
export async function stubSaveDialog(surface: SessionSurface, filePath: string | null): Promise<void> {
  await surface.application.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: target === null, filePath: target ?? '' });
  }, filePath);
}
export async function saveAs(context: QaContext, surface: SessionSurface, filePath: string): Promise<void> {
  await stubSaveDialog(surface, filePath);
  context.log(`Stub native save picker only -> ${filePath}; Cmd+Shift+S runs registry, preload, IPC and the atomic writer`);
  await surface.page.keyboard.press('Meta+Shift+s');
  await expect(surface.page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
}
export const loopObservation = (page: Page) => page.evaluate(() => {
  const observed = window.fretlineLoopObservation?.();
  return observed ? { enabled: observed.enabled, selectionKind: observed.selection?.kind ?? null, range: observed.range } : null;
});
export async function clickMenuItem(application: ElectronApplication, id: string): Promise<void> {
  await expect.poll(() => application.evaluate(({ Menu }, item) => Menu.getApplicationMenu()?.getMenuItemById(item)?.enabled ?? null, id)).toBe(true);
  await application.evaluate(({ Menu }, item) => {
    const entry = Menu.getApplicationMenu()?.getMenuItemById(item);
    if (!entry) throw new TypeError(`Missing menu item ${item}`);
    entry.click();
  }, id);
}
/** The native File > 종료 item (Cmd+Q accelerator) runs app.quit() in main. */
export async function quitThroughMenu(application: ElectronApplication): Promise<void> {
  await clickMenuItem(application, 'file.quit');
}
/** The window's own close (the red traffic-light button sends the same BrowserWindow 'close' event). */
export async function closeThroughWindow(application: ElectronApplication): Promise<void> {
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });
}
export async function expectStillRunning(page: Page): Promise<void> {
  await expect(page.getByTestId('save-changes-dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('[data-testid="document-tab"]').length)).toBeGreaterThan(0);
}
export async function waitForExit(application: ElectronApplication): Promise<number | null> {
  const child = application.process();
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>(done => child.once('exit', () => done()));
  return child.exitCode;
}
export async function captureThemes(page: Page, prefix: string, evidence: string): Promise<void> {
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(async value => {
        if (value === 'light') document.documentElement.dataset['theme'] = 'light'; else delete document.documentElement.dataset['theme'];
        await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
      }, theme);
      await page.screenshot({ path: resolve(evidence, `${prefix}-${width}-${theme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
