import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { waitAudio } from './playback-support';
import { loopInput } from './drag-loop-support';

const total = (page: Page): Promise<number | undefined> => page.evaluate(() => window.fretlinePlaybackObservation?.().state.total);

/** A range dragged while playback is paused bounds the next play; a click in empty space releases it. */
export const run: QaCase = context => withImportApp(context, resolve('tests/fixtures/projects/loop-eight-bars.fretline'), async surface => {
  const input = await loopInput({ context, ...surface });
  const { page } = surface;
  const transport = page.getByTestId('transport');
  await input.key('Space');
  await expect(transport).toHaveAttribute('data-status', 'playing');
  await waitAudio(page, 0.5);
  context.assert(await total(page) === 16, 'Without a selection the whole 16 s score plays');
  await input.key('Space');
  await expect(transport).toHaveAttribute('data-status', 'paused');

  await input.drag(5, 10);
  await input.assertRange(5, 11);
  await input.key('Space');
  await expect(transport).toHaveAttribute('data-status', 'playing');
  context.assert(await total(page) === 3, `Play after dragging while paused covers only the 3 s range (${await total(page)} s)`);
  const ended = await page.waitForFunction(() => window.fretlinePlaybackObservation?.().state.status !== 'playing', undefined, { timeout: 15_000 }).then(() => true, () => false);
  const state = await page.evaluate(() => { const observation = window.fretlinePlaybackObservation?.(); return observation ? { ...observation, hits: undefined } : null; });
  context.assert(ended, `Playback ends at the end of the range (${JSON.stringify(state)})`);
  await input.shot('range-finished.png');

  const box = await page.getByTestId('editor-surface').boundingBox();
  if (!box) throw new TypeError('The score surface has no bounds');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 6);
  await expect(page.locator('[data-overlay-kind="selection"]')).toHaveCount(0);
  context.assert(true, 'A click in the empty space below the last system clears the selection');
  await input.key('Space');
  await expect(transport).toHaveAttribute('data-status', 'playing');
  context.assert(await total(page) === 16, `After releasing the range the whole score plays again (${await total(page)} s)`);
  await input.click(page.locator('[data-command="sound.stop"]').first());
  await input.shot('released.png');
});
