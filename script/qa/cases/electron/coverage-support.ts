import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { withImportApp } from './import-support';
import type { ImportSurface } from './import-support';
import { clickBeat, hitsOf, ready } from './journey-support';
import { readEditing } from './editing-support';
import { setTheme } from './shell-support';

export const loopFixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
export async function withCoverageScore(context: QaContext, action: (surface: ImportSurface) => Promise<void>): Promise<void> {
  await withImportApp(context, loopFixture, async surface => {
    await surface.page.setViewportSize({ width: 1440, height: 900 });
    await ready(surface.page);
    context.assert(await surface.page.getByTestId('editor-harness').count() === 0,
      'Interactions run in the mounted production shell, without the editor harness route');
    await action(surface);
  });
}
export async function atQuarter(page: Page, quarter: number): Promise<string> {
  const hit = (await hitsOf(page)).find(hit => Number(hit.startQ.n) / Number(hit.startQ.d) === quarter);
  if (!hit) throw new QaFailure('assertion', `No rendered beat at ${quarter} quarters`);
  await clickBeat(page, hit.eventId);
  return hit.eventId;
}
export async function selectedRange(page: Page) {
  return page.evaluate(() => {
    const selection = window.fretlineLoopObservation?.().selection;
    if (selection?.kind !== 'timeRange') return null;
    const q = (value: { readonly n: string; readonly d: string }) => Number(value.n) / Number(value.d);
    return { start: Math.min(q(selection.anchor.startQ), q(selection.focus.startQ)),
      end: Math.max(q(selection.anchor.endQ), q(selection.focus.endQ)), tracks: selection.scope.trackIds };
  });
}
export async function captureCoverage(context: QaContext, page: Page, prefix: string): Promise<void> {
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
      await page.screenshot({ path: resolve(context.evidence, `${prefix}-${width}-${theme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, 'dark');
  await ready(page);
}
export async function undoTo(page: Page, depth: number): Promise<void> {
  while ((await readEditing(page)).past > depth) {
    const before = (await readEditing(page)).past;
    await page.keyboard.press('Meta+z');
    await expect.poll(async () => (await readEditing(page)).past).toBe(before - 1);
  }
  await ready(page);
}
