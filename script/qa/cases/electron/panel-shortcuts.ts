import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { atQuarter, captureCoverage, withCoverageScore } from './coverage-support';

export const run: QaCase = context => withCoverageScore(context, async ({ page }) => {
  await atQuarter(page, 0);
  for (const [key, area] of [['F2', 'palette'], ['F8', 'global-view']] as const) {
    await page.keyboard.press(key); await expect(page.locator(`[data-area="${area}"]`)).toBeHidden();
    await page.keyboard.press(key); await expect(page.locator(`[data-area="${area}"]`)).toBeVisible();
    context.assert(true, `${key} hides and restores ${area}`);
  }
  await page.keyboard.press('F3');
  await expect(page.getByTestId('score-scroll')).toHaveAttribute('data-multitrack', 'true');
  await page.keyboard.press('F3');
  await expect(page.getByTestId('score-scroll')).toHaveAttribute('data-multitrack', 'false');
  for (const [key, tab] of [['F6', 'track'], ['F5', 'song']] as const) {
    await page.keyboard.press(key);
    await expect(page.locator('[data-area="inspector"]')).toBeVisible();
    await expect(page.locator(`[data-inspector-tab="${tab}"]`)).toHaveAttribute('data-state', 'active');
    await page.keyboard.press(key);
    await expect(page.locator('[data-area="inspector"]')).toBeHidden();
    await page.keyboard.press(key);
    await expect(page.locator('[data-area="inspector"]')).toBeVisible();
    context.assert(true, `${key} selects ${tab} inspector and toggles its visibility`);
  }
  await page.keyboard.press('F7');
  await expect(page.getByTestId('stylesheet-dialog')).toBeVisible();
  await captureCoverage(context, page, 'stylesheet');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('stylesheet-dialog')).toBeHidden();
});
