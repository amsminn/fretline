import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { atQuarter, captureCoverage, withCoverageScore } from './coverage-support';
import { scoreOf } from './journey-support';

export const run: QaCase = context => withCoverageScore(context, async ({ page }) => {
  const tracks = (await scoreOf(page)).tracks;
  const second = tracks[1]; const third = tracks[2];
  context.assert(second !== undefined && third !== undefined, 'Fixture has three independently named tracks');
  if (!second || !third) throw new TypeError('Fixture lacks navigation targets');
  await page.getByTestId('lcd-track').click();
  await page.getByRole('option', { name: `2. ${second.name}`, exact: true }).click();
  await expect(page.locator('[data-track-row][aria-selected="true"]')).toHaveAttribute('data-track-row', second.id);
  await expect(page.getByTestId('score-scroll')).toHaveAttribute('data-shown-tracks', second.id);
  await page.getByTestId('track-name').nth(2).click();
  await expect(page.getByTestId('lcd-track')).toContainText(`3. ${third.name}`);
  await expect(page.getByTestId('score-scroll')).toHaveAttribute('data-shown-tracks', third.id);
  await atQuarter(page, 0);
  await page.keyboard.press('Meta+ArrowUp');
  await expect(page.getByTestId('lcd-track')).toContainText(`2. ${second.name}`);
  await page.keyboard.press('Meta+ArrowDown');
  await expect(page.getByTestId('lcd-track')).toContainText(`3. ${third.name}`);
  const grid = page.getByTestId('bar-grid');
  const cell = grid.locator('[role="row"]').nth(3).locator('[data-bar="3"]');
  await cell.click();
  await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.anchor.startQ)).toEqual({ n: '12', d: '1' });
  context.assert(true, 'Dropdown, bottom track row, Cmd+Up/Down and bottom bar grid navigate the live score');
  await captureCoverage(context, page, 'track-navigation');
});
