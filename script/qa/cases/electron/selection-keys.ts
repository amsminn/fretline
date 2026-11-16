import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { atQuarter, captureCoverage, selectedRange, withCoverageScore } from './coverage-support';
import { beatPoint } from './journey-support';

export const run: QaCase = context => withCoverageScore(context, async ({ page }) => {
  const first = await atQuarter(page, 0);
  await page.keyboard.press('Meta+a');
  await expect.poll(() => selectedRange(page)).toMatchObject({ start: 0, end: 32 });
  context.assert((await selectedRange(page))?.tracks.length === 1, 'Cmd+A selects the entire current track only');
  await page.keyboard.press('Escape');
  const point = await beatPoint(page, first);
  await page.mouse.click(point.x, point.y, { clickCount: 3 });
  await expect.poll(() => selectedRange(page)).toMatchObject({ start: 0, end: 32 });
  context.assert((await selectedRange(page))?.tracks.length === 1, 'Triple click selects the entire current track only');
  await atQuarter(page, 5);
  await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => selectedRange(page)).toMatchObject({ start: 5, end: 8 });
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => selectedRange(page)).toMatchObject({ start: 5, end: 7 });
  context.assert((await selectedRange(page))?.tracks.length === 1, 'Shift+arrows extend and contract beat selection in the current track');
  await captureCoverage(context, page, 'selection-keys');
});
