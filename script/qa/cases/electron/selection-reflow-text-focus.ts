import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withElectron } from '../../lib/electron';
import { beatPoint, dragBeats, openEditorHarness, rangeText, readSelection, selectionRects, waitForEditorScore } from './selection-support';

/** Reflow during a drag is rejected, Escape cancels a drag, and keys typed into a text field never reach the score. */
export const run: QaCase = async context => {
  await withElectron(context, async ({ page }) => {
    await openEditorHarness(page);
    const observations: Record<string, unknown>[] = [];
    const note = async (step: string) => {
      const selection = await readSelection(page);
      observations.push({ step, ...selection });
      context.log(`${step}: ${JSON.stringify(selection)}`);
      await page.screenshot({ path: resolve(context.evidence, `${step}.png`) });
      return selection;
    };

    await dragBeats(page, 'm1b2', 'm1b3');
    const baseline = await note('01-baseline-range');
    context.assert(rangeText(baseline) === '[1/1,3/1)', `Baseline range before the stress steps is [1,3) (${rangeText(baseline)})`);

    const from = await beatPoint(page, 'm2b2');
    const to = await beatPoint(page, 'm3b3');
    const generation = baseline.generation;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 3, from.y + 1);
    await page.mouse.move(to.x, to.y, { steps: 6 });
    const mid = await readSelection(page);
    context.assert(mid.dragging && rangeText(mid) === '[5/1,11/1)', `Drag is live before reflow (${rangeText(mid)})`);
    await page.setViewportSize({ width: 1024, height: 700 });
    await waitForEditorScore(page, generation);
    await page.mouse.move(to.x - 20, to.y, { steps: 2 });
    await page.mouse.up();
    const afterReflow = await note('02-reflow-during-drag');
    context.assert(afterReflow.rejected === 1 && afterReflow.dragging === false, `Release after reflow is rejected once (${afterReflow.rejected})`);
    context.assert(rangeText(afterReflow) === '[1/1,3/1)', `Rejected drag restores the baseline range, nothing from the stale layout (${rangeText(afterReflow)})`);
    context.assert(afterReflow.generation !== generation, `Hit map generation advanced ${generation} -> ${afterReflow.generation}`);

    await page.setViewportSize({ width: 1440, height: 900 });
    await waitForEditorScore(page, afterReflow.generation);
    const start = await beatPoint(page, 'm2b2');
    const end = await beatPoint(page, 'm3b3');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 3, start.y + 1);
    await page.mouse.move(end.x, end.y, { steps: 6 });
    context.assert((await readSelection(page)).dragging, 'Second drag is live before Escape');
    await page.keyboard.press('Escape');
    const cancelled = await note('03-escape-cancels-drag');
    await page.mouse.up();
    const released = await readSelection(page);
    context.assert(!cancelled.dragging && rangeText(cancelled) === '[1/1,3/1)' && rangeText(released) === '[1/1,3/1)',
      `Escape during a drag cancels it and restores the previous range; the later release changes nothing (${rangeText(released)})`);
    context.assert(await selectionRects(page) === 2, `Overlay shows the restored two-beat range (${await selectionRects(page)})`);

    await page.getByTestId('harness-text-input').click();
    await page.keyboard.type('12r');
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Escape');
    const typed = await page.getByTestId('harness-typed').textContent();
    const afterText = await note('04-text-input-no-leak');
    context.assert(typed === '12r', `Typed characters reach the text field (${typed})`);
    context.assert(rangeText(afterText) === '[1/1,3/1)' && afterText.kind === 'timeRange',
      `Cmd+A, Shift+Right and Escape inside a text field leave the score selection untouched (${rangeText(afterText)})`);
    const focusedIsInput = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'harness-text-input');
    context.assert(focusedIsInput, 'Focus stays in the text field after the shortcuts');
    await writeFile(resolve(context.evidence, 'observations.json'), JSON.stringify(observations, null, 2));
  });
};
