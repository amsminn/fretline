import { expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { withImportApp, deliverOpenFile, inspectReport } from './import-support';
import type { ImportSurface } from './import-support';
import type { NativeInput } from '../../lib/native';

export type RhythmInput = {
  readonly click: (locator: Locator) => Promise<void>;
  readonly key: (key: string) => Promise<void>;
  readonly fill: (locator: Locator, value: string) => Promise<void>;
};
export function rhythmInput(surface: ImportSurface, native?: NativeInput): RhythmInput {
  const keycodes: Readonly<Record<string, readonly [number, readonly string[]]>> = {
    'Meta+1': [18, ['cmd']], 'Meta+2': [19, ['cmd']], 'Meta+3': [20, ['cmd']], 'Meta+4': [21, ['cmd']],
    'Meta+m': [46, ['cmd']], 'Meta+z': [6, ['cmd']], 'Meta+Shift+z': [6, ['cmd', 'shift']], 'Meta+c': [8, ['cmd']],
    'Meta+s': [1, ['cmd']], 'Meta+a': [0, ['cmd']], 'Shift+ArrowRight': [124, ['shift']], 'ArrowRight': [124, []],
    'Escape': [53, []], 'Tab': [48, []], '/': [44, []], '-': [27, []], 'g': [5, []], 'l': [37, []],
    '1': [18, []], '2': [19, []], '3': [20, []], '4': [21, []], '7': [26, []], '8': [28, []],
  };
  const click = async (locator: Locator): Promise<void> => {
    if (!native) { await locator.click(); return; }
    const box = await locator.boundingBox();
    if (!box) throw new QaFailure('assertion', 'Native click target is absent');
    const content = await surface.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds());
    if (!content) throw new QaFailure('infrastructure', 'Native content bounds missing');
    await native(['click', String(content.x + box.x + box.width / 2), String(content.y + box.y + box.height / 2)]);
  };
  const key = async (key: string): Promise<void> => {
    if (!native) { await surface.page.keyboard.press(key); return; }
    const code = keycodes[key];
    if (!code) throw new QaFailure('infrastructure', `Missing OS keycode ${key}`);
    await native(['key', String(code[0]), ...code[1]]);
  };
  return { click, key, fill: async (locator, value) => {
    if (!native) { await locator.fill(value); return; }
    await click(locator); await key('Meta+a');
    for (const digit of value) await key(digit);
    await key('Tab');
  } };
}
export async function ready(surface: ImportSurface): Promise<void> {
  await expect(surface.page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
  await expect(surface.page.getByTestId('score-engine').locator('svg').first()).toBeVisible();
}
export async function selectFirst(surface: ImportSurface, input: RhythmInput): Promise<void> {
  await ready(surface);
  await input.click(surface.page.getByTestId('score-engine').locator('svg text').filter({ hasText: /^3$/ }).first());
  await expect.poll(() => surface.page.evaluate(() => window.fretlineEditingObservation?.().selection?.focus.startQ)).toEqual({ n: '0', d: '1' });
}
export async function repairImport(context: QaContext, surface: ImportSurface, input: RhythmInput): Promise<void> {
  const { page } = surface;
  const source = resolve('tests/fixtures/gp/gp5-notes.gp5');
  const hash = createHash('sha256').update(await readFile(source)).digest('hex');
  await inspectReport(context, surface, 'gp5-notes.gp5');
  await input.click(page.getByRole('button', { name: '취소', exact: true }));
  await expect(page.getByTestId('score-view')).toHaveCount(0);
  context.assert(createHash('sha256').update(await readFile(source)).digest('hex') === hash, 'Cancelling overflow import opens no document and leaves the source untouched');
  await deliverOpenFile(context, surface, source);
  await inspectReport(context, surface, 'gp5-notes.gp5');
  await input.click(page.getByRole('button', { name: '초과 마디 복구 미리보기', exact: true }));
  await expect(page.getByTestId('overflow-repair-preview')).toContainText('마디 1 → 10');
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset['theme'] = value; }, theme);
      await page.screenshot({ path: resolve(context.evidence, `repair-preview-${theme}-${width}.png`) });
    }
  }
  await input.click(page.getByRole('button', { name: '복구하고 편집 사본 열기', exact: true }));
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.fretlineRhythmObservation?.()?.measures.length)).toBe(10);
  await expect.poll(() => page.evaluate(() => window.fretlineEditingObservation?.().past)).toBe(1);
  const after = await page.evaluate(() => window.fretlineRhythmObservation?.());
  await ready(surface);
  await page.screenshot({ path: resolve(context.evidence, 'repaired-score.png') });
  await input.key('Meta+z');
  await expect.poll(() => page.evaluate(() => window.fretlineRhythmObservation?.()?.measures.length)).toBe(1);
  await input.key('Meta+Shift+z');
  await expect.poll(() => page.evaluate(() => window.fretlineRhythmObservation?.()?.measures.length)).toBe(10);
  context.assert(createHash('sha256').update(await readFile(source)).digest('hex') === hash, 'Confirmed repair is one undoable step on a copy; original bytes are unchanged');
  await writeFile(resolve(context.evidence, 'repair-events.json'), JSON.stringify(after, null, 2));
}

export async function complexRhythmEdit(context: QaContext, surface: ImportSurface, input: RhythmInput): Promise<void> {
  await repairImport(context, surface, input);
  // Work on an evidence-owned copy: File > Save writes an already-saved project back to its own path.
  const savePath = resolve(context.evidence, 'complex-rhythm.fretline');
  await copyFile(resolve('tests/fixtures/projects/loop-eight-bars.fretline'), savePath);
  const originalHash = createHash('sha256').update(await readFile(savePath)).digest('hex');
  await deliverOpenFile(context, surface, savePath);
  const { page } = surface;
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.evaluate(() => window.fretlineRhythmObservation?.()?.measures.length)).toBe(8);
  await selectFirst(surface, input);
  await input.key('Shift+ArrowRight'); await input.key('Shift+ArrowRight');
  await input.click(page.locator('[data-command="note.tuplet"]').first());
  await input.fill(page.getByRole('spinbutton', { name: '단위 분모', exact: true }), '4');
  await input.click(page.getByRole('button', { name: '적용', exact: true }));
  await expect.poll(() => page.evaluate(() => window.fretlineRhythmObservation?.()?.tuplets.length)).toBe(1);
  await selectFirst(surface, input);
  await input.key('Shift+ArrowRight'); await input.key('Shift+ArrowRight'); await input.key('/');
  await input.fill(page.getByRole('spinbutton', { name: '단위 분모', exact: true }), '4');
  await page.screenshot({ path: resolve(context.evidence, 'nested-preview.png') });
  await input.click(page.getByRole('button', { name: '적용', exact: true }));
  await expect.poll(() => page.evaluate(() => window.fretlineRhythmObservation?.()?.tuplets.length)).toBe(2);
  // Both standard notation and tab render the two authored bracket levels.
  await expect(page.locator('[data-tuplet-id]')).toHaveCount(4);
  await expect.poll(() => page.locator('[data-tuplet-id]').evaluateAll(nodes =>
    new Set(nodes.map(node => node.getAttribute('data-tuplet-id'))).size)).toBe(2);
  context.assert(true, 'Palette and slash command create two authored bracket levels on both standard notation and tab');
  await selectFirst(surface, input);
  await input.key('Meta+4');
  await expect.poll(() => page.evaluate(() => window.fretlineEditingObservation?.().selection?.scope.voices)).toEqual([4]);
  await input.key('7');
  await expect.poll(() => page.evaluate(() => Object.values(window.fretlineEditingObservation?.().events ?? {}).some(e => e.notes.some(([, fret]) => fret === 7)))).toBe(true);
  await input.key('Meta+m');
  await expect.poll(() => page.evaluate(() => window.fretlineEditingObservation?.().selection?.scope.voices)).toEqual([1, 2, 3, 4]);
  await page.screenshot({ path: resolve(context.evidence, 'nested-four-voices.png') });
  context.assert(true, 'Cmd+4 enters the fourth voice and Cmd+M makes multivoice scope explicit');
  context.assert(await page.locator('[data-command="file.save"]').count() > 0, 'File > Save has a mounted production handler for save/reopen QA');
  await input.key('Meta+s');
  await expect.poll(async () => createHash('sha256').update(await readFile(savePath)).digest('hex') !== originalHash).toBe(true);
  context.log('File > Save rewrote the opened project at its own path (no dialog)');
  const before = await page.evaluate(() => window.fretlineRhythmObservation?.());
  await deliverOpenFile(context, surface, savePath);
  await ready(surface);
  context.assert(JSON.stringify(await page.evaluate(() => window.fretlineRhythmObservation?.())) === JSON.stringify(before), 'Saving and reopening preserves authored rhythm identities and durations');
}
export const run: QaCase = context => withImportApp(context, resolve('tests/fixtures/gp/gp5-notes.gp5'),
  surface => complexRhythmEdit(context, surface, rhythmInput(surface)));
