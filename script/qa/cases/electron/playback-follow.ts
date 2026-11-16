import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { withPlayback, waitAudio } from './playback-support';
import { captureCoverage } from './coverage-support';

export const run: QaCase = context => withPlayback(context, async input => {
  const { page } = input;
  await input.key('Space');
  await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
  await expect(page.getByTestId('transport')).toHaveAttribute('data-follow', 'true');
  const viewport = await page.getByTestId('score-scroll').boundingBox();
  if (!viewport) throw new TypeError('Score scroll region has no bounds');
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.mouse.wheel(0, 300);
  await expect(page.getByTestId('transport')).toHaveAttribute('data-follow', 'false');
  await expect(page.locator('[data-command="sound.resumeFollow"]').first()).toBeVisible();
  await waitAudio(page, 0.5);
  await expect(page.getByTestId('transport')).toHaveAttribute('data-follow', 'false');
  await page.locator('[data-command="sound.resumeFollow"]').first().click();
  await expect(page.getByTestId('transport')).toHaveAttribute('data-follow', 'true');
  await expect(page.getByTestId('playback-cursor')).toBeVisible();
  context.assert(true, 'Manual wheel scrolling suspends follow during playback; Resume auto-scroll restores it explicitly');
  await page.locator('[data-command="sound.stop"]').first().click();
  await captureCoverage(context, page, 'playback-follow');
});
