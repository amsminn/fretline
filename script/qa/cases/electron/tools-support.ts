import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { sha256 } from '../../artifacts';
import { withImportApp } from './import-support';
import type { ImportSurface } from './import-support';

export async function withToolsApp(context: QaContext, action: (surface: ImportSurface) => Promise<void>): Promise<void> {
  const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
  context.versions['toolsFixtureSha256'] = sha256(await readFile(fixture));
  await withImportApp(context, fixture, async surface => {
    const { page } = surface;
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
    await page.waitForFunction(() => Boolean(window.fretlinePlaybackObservation?.().hits?.beats.length) && window.fretlineToolsObservation !== undefined, undefined, { timeout: 20_000 });
    context.log('Opened archived fixture through the production argv/open-file pipeline; tools observation is armed.');
    await action(surface);
  });
}

export const shot = async (context: QaContext, page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: resolve(context.evidence, name) });
  context.log(`Screenshot ${name}`);
};

export const scoreJson = (page: Page): Promise<string> => page.evaluate(() => JSON.stringify(window.fretlineArrangementObservation?.()?.score ?? null));

/** Selects a published beat by clicking the rendered score, exactly as a user would. */
export async function clickFirstBeat(context: QaContext, page: Page): Promise<string> {
  const point = await page.evaluate(() => {
    const engine = document.querySelector('[data-testid="score-engine"]');
    const map = window.fretlinePlaybackObservation?.().hits;
    if (!engine || !map) return null;
    const box = engine.getBoundingClientRect();
    for (const beat of map.beats) {
      const x = box.x + beat.bounds.x + beat.bounds.width / 2; const y = box.y + beat.bounds.y + beat.bounds.height / 2;
      const target = document.elementFromPoint(x, y);
      if (target?.closest('[data-testid="score-view"]') && !target.closest('[data-symbol], [data-design-spacing], [role="dialog"], button')) return { x, y, eventId: beat.eventId };
    }
    return null;
  });
  if (!point) throw new QaFailure('assertion', 'Rendered score has no visible beat to select');
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.focus.eventId)).toBe(point.eventId);
  context.log(`Selected beat ${point.eventId} by pointer`);
  return point.eventId;
}

export async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Meta+e');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '명령 검색' })).toBeFocused();
}
/** Measured overflow can collapse optional tools even at 1440 px. Use the same command surface a user sees. */
export async function toolbarCommand(page: Page, id: string): Promise<void> {
  const direct = page.locator(`[data-area="toolbar"] [data-command="${id}"]`).first();
  if (await direct.isVisible()) { await direct.click(); return; }
  await page.getByTestId('toolbar-overflow').click();
  await page.getByRole('menu').locator(`[data-command="${id}"]`).click();
}
export async function runFromPalette(context: QaContext, page: Page, query: string, commandId: string): Promise<void> {
  await openPalette(page);
  await page.getByRole('combobox', { name: '명령 검색' }).fill(query);
  const options = page.getByTestId('command-palette-results').getByRole('option');
  await expect(options.first()).toHaveAttribute('data-command', commandId);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette')).toBeHidden();
  context.log(`Executed ${commandId} through the command palette query "${query}"`);
}

export async function startTuner(page: Page, frequency: number): Promise<void> {
  await page.getByTestId('tuner-source').click();
  await page.getByRole('option', { name: '테스트 신호', exact: true }).click();
  await page.getByRole('spinbutton', { name: '테스트 주파수' }).fill(String(frequency));
  await page.getByTestId('tuner-start').click();
  await expect(page.getByTestId('tuner')).toHaveAttribute('data-running', 'true');
}
