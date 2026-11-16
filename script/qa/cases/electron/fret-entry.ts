import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { readEditing, renderedFretCount, waitForFret } from './editing-support';
import { atQuarter, captureCoverage, withCoverageScore } from './coverage-support';

export const run: QaCase = context => withCoverageScore(context, async ({ page }) => {
  const first = await atQuarter(page, 0);
  const original = await readEditing(page);
  const twelves = await renderedFretCount(page, 12);
  await page.keyboard.press('1'); await waitForFret(page, first, 1);
  await page.keyboard.press('2'); await waitForFret(page, first, 12);
  await expect.poll(() => renderedFretCount(page, 12)).toBe(twelves + 1);
  context.assert((await readEditing(page)).past === original.past + 1, 'Two numeric digits edit the clicked beat as one fret gesture');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await readEditing(page)).selection?.focus.startQ).toEqual({ n: '1', d: '1' });
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await readEditing(page)).selection?.focus.eventId).toBe(first);
  const string = (await readEditing(page)).string;
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await readEditing(page)).string).toBe(string + 1);
  await page.keyboard.press('7'); await waitForFret(page, first, 7);
  context.assert((await readEditing(page)).events[first]?.notes.some(([s, fret]) => s === string + 1 && fret === 7) === true,
    'Down then 7 enters the fret on the adjacent tablature string');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await readEditing(page)).string).toBe(string);
  const staff = (await readEditing(page)).selection?.scope.staffIds;
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await readEditing(page)).selection?.scope.staffIds).not.toEqual(staff);
  await page.keyboard.press('Shift+Tab');
  await expect.poll(async () => (await readEditing(page)).selection?.scope.staffIds).toEqual(staff);
  context.assert((await readEditing(page)).selection?.focus.startQ.n === '0', 'Tab and Shift+Tab navigate notation staves while retaining written time');
  await captureCoverage(context, page, 'fret-entry');
});
