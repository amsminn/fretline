import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withCoverageScore } from './coverage-support';
import { loopInput, inspectLoopCapture } from './drag-loop-support';
import { menuCommand } from './notation-design';
import { waitAudio } from './playback-support';

export const run: QaCase = async context => {
  for (const selected of [true, false]) {
    const evidence = resolve(context.evidence, selected ? 'selected' : 'whole-arrangement');
    await mkdir(evidence, { recursive: true });
    const child = { ...context, evidence };
    await withCoverageScore(child, async surface => {
      const { page } = surface;
      const input = await loopInput({ context: child, ...surface });
      if (selected) { await input.drag(5, 10); await input.assertRange(5, 11); }
      else await input.clickPoint(await input.point(0));
      await page.keyboard.press('F9');
      await expect(page.locator('[data-command="sound.loop"]')).toHaveAttribute('aria-pressed', 'true');
      await page.locator('[data-command="sound.loop"]').click();
      await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().enabled)).toBe(false);
      await menuCommand(surface, 'sound.loop');
      await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().enabled)).toBe(true);
      context.assert(true, 'F9, toolbar and Sound menu toggle the same loop state');
      await page.keyboard.press('Space');
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
      const start = selected ? 5 : 0; const end = selected ? 11 : 32;
      const period = (end - start) / 2;
      await page.waitForFunction(() => (window.fretlinePracticeObservation?.().state.completed ?? 0) >= 3,
        undefined, { timeout: 90_000 });
      await input.shot('playing.png');
      await page.locator('[data-command="sound.stop"]').first().click();
      await waitAudio(page, 0.4); await input.save();
      await inspectLoopCapture(child, { start, end, period, cycles: 3, ids: await input.ids(start, end) });
      context.assert(selected ? await page.evaluate(() => window.fretlineLoopObservation?.().range?.startQ.n) === '5'
        : await page.evaluate(() => window.fretlineLoopObservation?.().range) === null,
      selected ? 'Space plays the selected half-open passage' : 'With no selection, the full arrangement audibly loops');
    });
  }
};
