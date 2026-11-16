import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { atQuarter, captureCoverage, withCoverageScore } from './coverage-support';
import { assertGpOrder, readAreas } from './shell-support';

export const run: QaCase = context => withCoverageScore(context, async ({ page, application }) => {
  context.log('HEADLESS T02: OS-level window activation/focus, CGEvent clicks and OS screencapture are not performed. DOM focus and hidden-window bounds/screenshots are checked instead.');
  const windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({
    visible: w.isVisible(), minimized: w.isMinimized(), bounds: w.getContentBounds(),
  })));
  context.assert(windows.length === 1 && windows.every(w => !w.visible && !w.minimized &&
    w.bounds.width > 0 && w.bounds.height > 0), 'One real shell window exists hidden, with sane bounds, without showing or minimizing it');
  const areas = await readAreas(page);
  assertGpOrder(context, areas, 'T02 hidden shell', { width: 1440, height: 900 });
  await atQuarter(page, 0);
  let scoreFocused = false;
  for (let press = 0; press < 128 && !scoreFocused; press++) {
    await page.keyboard.press('Tab');
    scoreFocused = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-area="score"]')));
  }
  context.assert(scoreFocused, 'Tab navigation reaches a focusable element inside the real score region');
  await page.keyboard.press('b');
  await expect(page.getByRole('dialog')).toBeVisible();
  context.assert(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
    'Opening the bend dialog moves keyboard focus inside it');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  try {
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-area="score"]'))),
      { timeout: 5_000, message: 'Closing a dialog returns keyboard focus to the score' }).toBe(true);
  } finally {
    const focus = await page.evaluate(() => ({
      tag: document.activeElement?.tagName, role: document.activeElement?.getAttribute('role'),
      symbol: document.activeElement?.getAttribute('data-symbol'),
      area: document.activeElement?.closest('[data-area]')?.getAttribute('data-area'),
      outerHtml: document.activeElement?.outerHTML.slice(0, 1000),
    }));
    context.log(`Post-dialog DOM focus: ${JSON.stringify(focus)}`);
    await writeFile(resolve(context.evidence, 'focus-after-dialog.json'), JSON.stringify(focus, null, 2));
  }
  context.assert(true, 'Closing a dialog restores keyboard focus to the score within the bounded focus-settlement wait');
  await captureCoverage(context, page, 'shell-focus');
});
