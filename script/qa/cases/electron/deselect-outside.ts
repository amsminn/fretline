import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { loopInput } from './drag-loop-support';

type Point = { readonly x: number; readonly y: number };

/** A dragged range is released by a click anywhere in the score area that is not on a beat, and by Escape. */
export const run: QaCase = context => withImportApp(context, resolve('tests/fixtures/projects/loop-eight-bars.fretline'), async surface => {
  const input = await loopInput({ context, ...surface });
  const { page } = surface;
  const selection = page.locator('[data-overlay-kind="selection"]');
  const box = async (testId: string): Promise<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }> => {
    const bounds = await page.getByTestId(testId).boundingBox();
    if (!bounds) throw new QaFailure('assertion', `${testId} has no bounds`);
    return bounds;
  };
  const betweenStaves = async (): Promise<Point> => {
    const rows = await selection.evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { x: rect.x + rect.width / 2, top: rect.top, bottom: rect.bottom }; }));
    const upper = rows.reduce((a, b) => (b.top < a.top ? b : a));
    const lower = rows.filter(row => row.top > upper.bottom).reduce((a, b) => (b.top < a.top ? b : a));
    return { x: upper.x, y: (upper.bottom + lower.top) / 2 };
  };
  const places: readonly (readonly [string, () => Promise<Point>])[] = [
    ['the area below the page', async () => { const credit = await box('engine-credit'); const scroll = await box('score-scroll'); return { x: scroll.x + scroll.width / 2, y: Math.min(credit.y + credit.height + 10, scroll.y + scroll.height - 4) }; }],
    ['the engine credit line', async () => { const credit = await box('engine-credit'); return { x: credit.x + credit.width - 20, y: credit.y + credit.height / 2 }; }],
    ['the padding left of the page', async () => { const scroll = await box('score-scroll'); return { x: scroll.x + 6, y: scroll.y + 200 }; }],
    ['the page margin above the title', async () => { const page_ = await box('editor-surface'); return { x: page_.x + 60, y: page_.y + 12 }; }],
    ['the gap between the notation staff and the tablature staff', betweenStaves],
  ];
  for (const [name, at] of places) {
    await input.drag(5, 10);
    await expect(selection).toHaveCount(12);
    const point = await at();
    await page.mouse.click(point.x, point.y);
    await expect(selection, `A click on ${name} releases the range`).toHaveCount(0);
    context.assert(true, `A click on ${name} (${Math.round(point.x)}, ${Math.round(point.y)}) releases the range`);
  }
  await input.drag(5, 10);
  await expect(selection).toHaveCount(12);
  await input.key('Escape');
  await expect(selection).toHaveCount(0);
  context.assert(true, 'Escape releases the range');
  await input.shot('released.png');
});
