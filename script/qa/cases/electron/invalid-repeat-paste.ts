import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { QaCase, QaContext } from '../../lib/contracts';
import { withImportApp } from './import-support';
import type { ImportSurface } from './import-support';
import { arrangementInput } from './arrangement-inspectors';
import type { ArrangementInput } from './arrangement-inspectors';

export async function invalidRepeatPaste(context: QaContext, surface: ImportSurface, input: ArrangementInput): Promise<void> {
  const { page } = surface;
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => page.evaluate(() => window.fretlineArrangementObservation?.()?.score.tracks.length)).toBe(3);
  const before = await page.evaluate(() => window.fretlineArrangementObservation?.());
  const history = await page.evaluate(() => window.fretlineEditingObservation?.().past);
  await input.click(page.locator('[data-command="bar.directions"]').first());
  await input.click(page.getByRole('combobox', { name: '진행 지시', exact: true }));
  await input.click(page.getByRole('option', { name: 'D.S.', exact: true }));
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Segno');
  await expect(page.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
  await input.shot('dangling-jump.png');
  await input.click(page.getByRole('button', { name: '취소', exact: true }));
  context.assert(JSON.stringify(await page.evaluate(() => window.fretlineArrangementObservation?.())) === JSON.stringify(before),
    'Dangling D.S. preview rejects and preserves the original');
  await input.click(page.locator('[data-command="bar.meter"]').first());
  await input.fill(page.getByRole('spinbutton', { name: '박 수', exact: true }), '3');
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('discard');
  await expect(page.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
  await input.shot('track-length-conflict.png');
  await input.click(page.getByRole('button', { name: '취소', exact: true }));
  context.assert(JSON.stringify(await page.evaluate(() => window.fretlineArrangementObservation?.())) === JSON.stringify(before),
    'Changing a global bar to a conflicting length preserves every track');
  await input.click(page.locator('[data-command="edit.copyAllTracks"]').first());
  await input.click(page.locator('[data-command="edit.specialPaste"]').first());
  await expect(page.getByRole('dialog')).toBeVisible();
  await input.shot('paste-preview.png');
  await input.click(page.getByRole('button', { name: '취소', exact: true }));
  context.assert(JSON.stringify(await page.evaluate(() => window.fretlineArrangementObservation?.())) === JSON.stringify(before),
    'Cancelling special paste preserves all original notes, relations and metadata');
  context.assert(await page.evaluate(() => window.fretlineEditingObservation?.().past) === history,
    'Rejected previews and cancelled paste create no undo entry');
  await writeFile(resolve(context.evidence, 'unchanged-score.json'), JSON.stringify(before, null, 2));
}
export const run: QaCase = context => withImportApp(context, resolve('tests/fixtures/projects/loop-eight-bars.fretline'),
  surface => invalidRepeatPaste(context, surface, arrangementInput(context, surface)));
