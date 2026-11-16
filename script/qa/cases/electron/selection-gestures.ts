import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { withElectron } from '../../lib/electron';
import { beatPoint, dragBeats, dragBetween, openEditorHarness, rangeText, readSelection, selectionRects } from './selection-support';
import type { SelectionObservation } from './selection-support';

const record = async (context: QaContext, page: Page, step: string, log: SelectionObservation[]): Promise<SelectionObservation> => {
  const selection = await readSelection(page);
  log.push({ ...selection, kind: `${step}: ${selection.kind ?? 'none'}` });
  context.log(`${step}: ${JSON.stringify(selection)}`);
  await page.screenshot({ path: resolve(context.evidence, `${step}.png`) });
  return selection;
};

/** UX05/06/08: OS-style pointer drags, handle resize, Global View blocks and keyboard selection on the real rendered score. */
export const run: QaCase = async context => {
  await withElectron(context, async ({ page }) => {
    await openEditorHarness(page);
    const endpoints: SelectionObservation[] = [];
    await page.screenshot({ path: resolve(context.evidence, 'before.png') });

    await page.mouse.click((await beatPoint(page, 'm1b1')).x, (await beatPoint(page, 'm1b1')).y);
    const caret = await record(context, page, '01-click-caret', endpoints);
    context.assert((caret.kind === 'caret' || caret.kind === 'noteSet') && caret.range === null && caret.anchor === 'm1b1', 'Click alone sets a caret on m1b1 and never a range');
    context.assert(await page.getByTestId('editor-caret').count() === 1, 'Caret line is drawn at the clicked beat');

    await dragBeats(page, 'm2b2', 'm3b3');
    const forward = await record(context, page, '02-drag-m2b2-m3b3', endpoints);
    context.assert(rangeText(forward) === '[5/1,11/1)' && forward.direction === 'forward', `Drag m2b2->m3b3 selects [5,11) (${rangeText(forward)})`);
    context.assert(await selectionRects(page) === 6, `Blue overlay covers exactly six beats, excluding m2b1 and m3b4 (${await selectionRects(page)})`);
    context.assert(await page.getByTestId('selection-handle-start').count() === 1 && await page.getByTestId('selection-handle-end').count() === 1, 'Both range handles are shown');

    await dragBeats(page, 'm3b3', 'm2b2');
    const reverse = await record(context, page, '03-drag-reverse', endpoints);
    context.assert(rangeText(reverse) === '[5/1,11/1)' && reverse.direction === 'reverse' && reverse.anchor === 'm3b3',
      `Reverse drag yields the same range with reverse direction (${rangeText(reverse)}, anchor ${reverse.anchor})`);

    const endHandle = await page.getByTestId('selection-handle-end').boundingBox();
    if (!endHandle) throw new QaFailure('assertion', 'End handle has no bounds');
    await dragBetween(page, { x: endHandle.x + endHandle.width / 2, y: endHandle.y + endHandle.height / 2 }, await beatPoint(page, 'm3b4'));
    const resized = await record(context, page, '04-handle-resize', endpoints);
    context.assert(rangeText(resized) === '[5/1,12/1)', `Dragging the end handle to m3b4 snaps the range to [5,12) (${rangeText(resized)})`);

    await dragBeats(page, 'm4b3', 'm5b2');
    const cross = await record(context, page, '05-drag-cross-system', endpoints);
    context.assert(rangeText(cross) === '[14/1,18/1)', `Cross-system drag m4b3->m5b2 selects [14,18) (${rangeText(cross)})`);

    const scrollBefore = await page.getByTestId('score-scroll').evaluate(element => element.scrollTop);
    const viewport = await page.getByTestId('score-scroll').boundingBox();
    if (!viewport) throw new QaFailure('assertion', 'Score viewport missing');
    const start = await beatPoint(page, 'm4b1');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 6, start.y + 2);
    await page.mouse.move(start.x + 6, viewport.y + viewport.height - 6, { steps: 4 });
    await page.waitForFunction(previous => (document.querySelector('[data-testid="score-scroll"]')?.scrollTop ?? 0) > previous + 40, scrollBefore, { timeout: 5000 });
    await page.mouse.up();
    const scrolled = await record(context, page, '06-edge-autoscroll', endpoints);
    context.assert(scrolled.kind === 'timeRange' && scrolled.dragging === false, 'Holding the pointer at the viewport edge autoscrolls and the drag continues to a later beat');

    const grid = page.getByTestId('bar-grid');
    const gridBox = await grid.boundingBox();
    if (!gridBox) throw new QaFailure('assertion', 'Global View bar grid missing');
    await dragBetween(page, { x: gridBox.x + 36, y: gridBox.y + 40 }, { x: gridBox.x + 60, y: gridBox.y + 40 });
    await beatPoint(page, 'm2b1');
    const blocks = await record(context, page, '07-global-view-blocks', endpoints);
    context.assert(rangeText(blocks) === '[4/1,12/1)' && blocks.trackIds.length === 3, `Global View block drag selects whole bars 2-3 on every track (${rangeText(blocks)})`);
    context.assert(await selectionRects(page) === 24, `Overlay highlights all three tracks across bars 2-3 (${await selectionRects(page)} rects)`);

    const first = await beatPoint(page, 'm1b1');
    await page.mouse.click(first.x, first.y, { clickCount: 3 });
    const triple = await record(context, page, '08-triple-click', endpoints);
    context.assert(rangeText(triple) === '[0/1,32/1)' && triple.trackIds.length === 1, `Triple click selects the whole first track (${rangeText(triple)})`);

    await page.mouse.click((await beatPoint(page, 'm2b2', 1)).x, (await beatPoint(page, 'm2b2', 1)).y);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    const extended = await record(context, page, '09-shift-arrows', endpoints);
    context.assert(rangeText(extended) === '[5/1,8/1)' && extended.focus === 'm2b4', `Shift+Right twice extends the caret to [5,8) (${rangeText(extended)})`);
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    const backwards = await record(context, page, '10-shift-left', endpoints);
    context.assert(rangeText(backwards) === '[4/1,6/1)' && backwards.direction === 'reverse', `Shift+Left past the anchor reverses the range (${rangeText(backwards)})`);

    await page.keyboard.press('Meta+a');
    const all = await record(context, page, '11-cmd-a', endpoints);
    context.assert(rangeText(all) === '[0/1,32/1)', `Cmd+A selects the active track (${rangeText(all)})`);
    await page.keyboard.press('Escape');
    const cleared = await record(context, page, '12-escape', endpoints);
    context.assert(cleared.kind === null && await selectionRects(page) === 0, 'Escape clears the selection and the overlay');
    context.assert(await page.locator('.at-cursor-beat, .at-selection').count() === 0, 'alphaTab built-in selection stays disabled; only the app overlay draws');
    await writeFile(resolve(context.evidence, 'selection-endpoints.json'), JSON.stringify(endpoints, null, 2));
  });
};
