import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import { withImportApp } from './import-support';
import type { ImportSurface } from './import-support';
import { ready, rhythmInput, selectFirst } from './complex-rhythm-edit';
import type { RhythmInput } from './complex-rhythm-edit';

export async function partialTupletConflict(context: QaContext, surface: ImportSurface, input: RhythmInput): Promise<void> {
  const { page } = surface;
  await ready(surface);
  await selectFirst(surface, input);
  const before = await page.evaluate(() => window.fretlineRhythmObservation?.());
  const history = await page.evaluate(() => window.fretlineEditingObservation?.().past);
  await input.key('Meta+c');
  await expect.poll(() => page.evaluate(() => window.fretlineEditingObservation?.().rejection?.length ?? 0)).toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toBeVisible();
  context.assert(JSON.stringify(await page.evaluate(() => window.fretlineRhythmObservation?.())) === JSON.stringify(before), 'Copying an incomplete tuplet rejects without changing the original');
  await page.screenshot({ path: resolve(context.evidence, 'partial-copy-rejected.png') });
  await input.key('-');
  await expect.poll(() => page.evaluate(() => window.fretlineEditingObservation?.().rejection?.some(d => d.message.includes('Collision')))).toBe(true);
  await expect(page.getByRole('alert')).toContainText('Collision');
  context.assert(JSON.stringify(await page.evaluate(() => window.fretlineRhythmObservation?.())) === JSON.stringify(before), 'Overlapping duration extension preserves all original events and ratios');
  context.assert(await page.evaluate(() => window.fretlineEditingObservation?.().past) === history, 'Both rejections leave history unchanged');
  await page.screenshot({ path: resolve(context.evidence, 'overlap-rejected.png') });
}
export const run: QaCase = context => withImportApp(context, resolve('tests/fixtures/projects/seven-four.fretline'),
  surface => partialTupletConflict(context, surface, rhythmInput(surface)));
