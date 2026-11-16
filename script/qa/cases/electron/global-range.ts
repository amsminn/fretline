import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { dragBetween } from './selection-support';
import { captureCoverage, selectedRange, withCoverageScore } from './coverage-support';
import { readAreas } from './shell-support';

export const run: QaCase = context => withCoverageScore(context, async ({ page }) => {
  const grid = await page.getByTestId('bar-grid').boundingBox();
  if (!grid) throw new QaFailure('assertion', 'Global View grid has no bounds');
  await dragBetween(page, { x: grid.x + 36, y: grid.y + 40 }, { x: grid.x + 60, y: grid.y + 40 });
  await expect.poll(() => selectedRange(page)).toMatchObject({ start: 4, end: 12 });
  const range = await selectedRange(page);
  context.assert(range?.tracks.length === 3, 'Global View drag selects whole bars 2–3 across all three tracks');
  const areas = await readAreas(page);
  const controls = await page.locator('[data-track-mute]').first().boundingBox();
  context.assert(controls !== null && controls.y >= areas.score.y + areas.score.height &&
    areas['global-view'].y >= areas.score.y + areas.score.height, 'Track controls remain in the bottom Global View beneath the score');
  await captureCoverage(context, page, 'global-range');
});
