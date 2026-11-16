import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { withCoverageScore, captureCoverage } from './coverage-support';
import { measuredToolbar, wideToolbar } from './journey-toolbar';

export const run: QaCase = context => withCoverageScore(context, async ({ page }) => {
  const expected = ['panels', 'zoom', 'history', 'transport', 'lcd', 'loop', 'tonality', 'backing', 'instrument'];
  // LoopSpeed is a custom control group, not a CommandSlot. Observe its real
  // toolbar item alongside the other groups rather than requiring a slot label.
  const groups = await page.locator('[data-area="toolbar"] [data-toolbar-item]').evaluateAll(items =>
    items.map(item => item.getAttribute('data-toolbar-item') ?? '').filter(id => !id.startsWith('separator-') && id !== 'menu'));
  const ranks = groups.map(group => expected.indexOf(group));
  context.assert(ranks.every((rank, i) => rank >= 0 && (i === 0 || rank > (ranks[i - 1] ?? -1))),
    `UX02: mounted toolbar groups follow the plan order: ${groups.join(' > ')}`);
  for (const required of expected) {
    context.assert(groups.includes(required), `1440: required toolbar group ${required} is present`);
  }
  const wide = await wideToolbar(context, page);
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    await page.setViewportSize({ width, height });
    await measuredToolbar(context, { page, groups: wide }, `UX02 ${width}`);
    await expect(page.getByTestId('lcd')).toBeVisible();
    const toolbar = page.locator('[data-area="toolbar"]');
    context.assert(await toolbar.locator('[data-toolbar-item="history"]').isVisible() &&
      await toolbar.locator('[data-command="edit.undo"]').first().isVisible(),
      `${width}: undo and the history group stay directly on the toolbar (group 5), optional groups collapse first`);
  }
  await captureCoverage(context, page, 'toolbar-order');
});
