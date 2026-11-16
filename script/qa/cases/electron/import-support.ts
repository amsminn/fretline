import { _electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { QaContext } from '../../lib/contracts';

export type ImportSurface = { readonly application: ElectronApplication; readonly page: Page };
export async function withImportApp(context: QaContext, argv: string | null, action: (surface: ImportSurface) => Promise<void>): Promise<void> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
  const application = await _electron.launch({
    ...(context.app ? { executablePath: resolve(context.app, 'Contents/MacOS/Fretline'), args: argv ? [argv] : [] }
      : { args: [resolve('out/main/index.js'), ...(argv ? [argv] : [])] }),
    env: { ...environment, FRETLINE_QA: '1', FRETLINE_QA_HEADLESS: environment['FRETLINE_QA_HEADLESS'] ?? '1', FRETLINE_QA_PARENT_PID: String(process.pid),
      FRETLINE_QA_EVIDENCE: context.evidence }, timeout: 30_000,
  });
  const child = application.process();
  context.log(`Started built Electron PID ${child.pid}${argv ? ` with argv ${argv}` : ''}`);
  const errors: string[] = [];
  let page: Page | undefined;
  try {
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => context.log(`renderer ${message.type()}: ${message.text()}`));
    Object.assign(context.versions, await application.evaluate(() => process.versions));
    await page.getByTestId('renderer-ready').waitFor({ timeout: 25_000 });
    await action({ application, page });
    context.assert(errors.length === 0, `No uncaught renderer errors: ${errors.join('; ')}`);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: resolve(context.evidence, 'failure.png') });
    throw error;
  } finally {
    // Closing a window with unsaved edits opens the save-changes prompt; teardown is bounded by the owned child.
    const forced = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) { context.log(`Teardown forced: SIGKILL owned Electron ${child.pid}`); child.kill('SIGKILL'); }
    }, 5_000);
    const closed = new Promise<void>(done => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once('exit', () => done()); });
    try { await Promise.race([application.close(), closed]); }
    finally {
      clearTimeout(forced);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(done => child.once('exit', () => done()));
        child.kill('SIGKILL'); await exited;
      }
      let gone = false;
      try { if (child.pid !== undefined) process.kill(child.pid, 0); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') gone = true; else throw error; }
      context.cleanup.push({ name: 'Electron (kill-0 failed)', pid: child.pid, exitCode: child.exitCode,
        signal: child.signalCode, reaped: gone });
      context.log(`Electron teardown PID ${child.pid}: kill-0 fails=${gone}`);
    }
  }
}
export async function chooseThroughOpen(context: QaContext, surface: ImportSurface, path: string | null): Promise<void> {
  // Replace only the permission-blocked native picker. Keyboard, IPC, worker, report,
  // document commit and score rendering are the shipped production paths.
  context.log(`Cmd+O case: STUB dialog.showOpenDialog only (native picker permission blocked); selection=${path ?? 'cancelled'}. Keyboard routing, IPC, worker, document publication and rendering remain production code.`);
  const requestId = crypto.randomUUID();
  await surface.application.evaluate(({ dialog }, selection) => {
    dialog.showOpenDialog = async () => {
      process.env['FRETLINE_QA_PICKER_RECEIPT'] = selection.requestId;
      return { canceled: selection.path === null, filePaths: selection.path ? [selection.path] : [] };
    };
  }, { path, requestId });
  await surface.page.keyboard.press('Meta+o');
  await expect.poll(() => surface.application.evaluate(() => process.env['FRETLINE_QA_PICKER_RECEIPT'])).toBe(requestId);
}
export async function deliverOpenFile(context: QaContext, surface: ImportSurface, path: string): Promise<void> {
  context.log(`Open fixture through production macOS open-file listener: ${path}; no dialog stub and no domain mutation`);
  await surface.application.evaluate(({ app }, selected) => {
    app.emit('open-file', { preventDefault() {} }, selected);
  }, path);
}
export async function inspectReport(context: QaContext, surface: ImportSurface, name: string): Promise<void> {
  const dialog = surface.page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(name);
  await expect(dialog.locator('[data-feature="container.private-fields"][data-status="inventory-unknown"]')).toHaveCount(1);
  await expect(dialog).toContainText('검증 안 됨');
  const hash = createHash('sha256').update(await readFile(resolve('tests/fixtures/gp', name))).digest('hex');
  await expect(surface.page.getByTestId('source-hash')).toContainText(hash);
  context.assert(true, `${name}: feature inventory and independently computed source hash are visible`);
}
export async function acceptCopy(context: QaContext, surface: ImportSurface): Promise<void> {
  await surface.page.getByRole('button', { name: '편집 가능한 사본으로 변환', exact: true }).click();
  await expect(surface.page.getByRole('dialog')).toBeHidden();
  await expect(surface.page.getByTestId('compatibility-badge')).toHaveAttribute('data-dirty', 'true');
  await expect(surface.page.getByTestId('compatibility-badge')).toContainText('편집 사본');
  const score = surface.page.getByTestId('score-view');
  await expect(score).toHaveAttribute('aria-busy', 'false');
  await expect(surface.page.getByTestId('score-engine').locator('svg').first()).toBeVisible();
  const before = await surface.page.evaluate(() => {
    const opened = window.fretlineArrangementObservation?.()?.score;
    if (!opened) throw new TypeError('Opened document observation is missing');
    return JSON.stringify(opened);
  });
  await expect.poll(() => surface.page.evaluate(() => {
    const map = window.fretlinePlaybackObservation?.().hits;
    const view = document.querySelector('[data-testid="score-view"]');
    return map !== undefined && map.beats.length + (map.barSlots?.length ?? 0) > 0 && map.generation === Number(view?.getAttribute('data-generation'));
  })).toBe(true);
  const point = await surface.page.evaluate(() => {
    const engine = document.querySelector('[data-testid="score-engine"]');
    const map = window.fretlinePlaybackObservation?.().hits;
    if (!engine || !map) return null;
    const box = engine.getBoundingClientRect();
    for (const beat of [...map.beats, ...(map.barSlots ?? [])]) {
      const x = box.x + beat.bounds.x + beat.bounds.width / 2;
      const y = box.y + beat.bounds.y + beat.bounds.height / 2;
      const target = document.elementFromPoint(x, y);
      if (target?.closest('[data-testid="score-view"]') &&
        !target.closest('[data-symbol], [data-design-spacing], [role="dialog"], button')) {
        return { x, y, eventId: beat.eventId, barSlot: beat.eventId === undefined ? beat.barSlot : undefined, generation: map.generation };
      }
    }
    return null;
  });
  if (!point) throw new TypeError('Rendered score has no visible beat outside symbol hotspots');
  context.log(`Click published target ${point.eventId ?? JSON.stringify(point.barSlot)}, generation ${point.generation}, at (${point.x}, ${point.y})`);
  await surface.page.mouse.click(point.x, point.y);
  await expect(surface.page.getByRole('dialog')).toHaveCount(0);
  if (point.barSlot) {
    await expect.poll(() => surface.page.evaluate(() => window.fretlineLoopObservation?.().selection?.focus.barSlot)).toEqual(point.barSlot);
    await expect(surface.page.getByTestId('editor-caret')).toBeVisible();
  } else {
    await expect.poll(() => surface.page.evaluate(() => window.fretlineLoopObservation?.().selection?.focus.eventId)).toBe(point.eventId);
  }
  context.assert(await surface.page.evaluate(() => JSON.stringify(window.fretlineArrangementObservation?.()?.score)) === before,
    'Pointer placement preserves every inactive bar and the entire document content');
  context.assert(true, 'Editable copy is dirty, compatibility badge persists, and the observed beat is selected without opening a dialog');
}
