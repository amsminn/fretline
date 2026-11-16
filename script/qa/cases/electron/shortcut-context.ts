import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { atQuarter, undoTo, withCoverageScore } from './coverage-support';
import { readEditing } from './editing-support';
import { contentHash } from './journey-support';
import { practiceInput } from './practice-support';

export const run: QaCase = context => withCoverageScore(context, async surface => {
  const { page } = surface;
  const first = await atQuarter(page, 0);
  const depth = (await readEditing(page)).past;
  for (const [shorter, longer] of [['+', '-'], ['=', '_']] as const) {
    await page.keyboard.press(shorter);
    await expect.poll(async () => (await readEditing(page)).events[first]?.duration).toBe('8');
    await page.keyboard.press(longer);
    await expect.poll(async () => (await readEditing(page)).events[first]?.duration).toBe('4');
    await undoTo(page, depth);
    await atQuarter(page, 0);
  }
  context.assert((await readEditing(page)).events[first]?.duration === '4', 'Editing +/= shorten and -/_ lengthen the selected beat');
  const hash = await contentHash(page);
  const input = await practiceInput(context, surface);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
  for (const [key, value] of [['+', '105'], ['_', '100'], ['=', '105'], ['-', '100']] as const) {
    await page.keyboard.press(key);
    await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', value);
  }
  await input.open(); await input.fixed(); await input.fill('고정 BPM', '123.45'); await input.apply();
  for (const [key, value] of [['+', '128.45'], ['_', '123.45'], ['=', '128.45'], ['-', '123.45']] as const) {
    await page.keyboard.press(key);
    await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', value);
  }
  await page.locator('[data-command="sound.stop"]').first().click();
  context.assert(await contentHash(page) === hash, 'Playing +/= and -/_ change relative speed by 5% or fixed tempo by 5 BPM without editing notation');
});
