import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { withElectron } from '../../lib/electron';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';

export type QaNoteHit = {
  readonly generation: number;
  readonly eventId: string;
  readonly noteId: string;
  readonly trackId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export async function readScoreHits(page: Page): Promise<readonly QaNoteHit[]> {
  const text = await page.getByTestId('score-hit-map').textContent();
  const value: unknown = JSON.parse(text ?? 'null');
  if (typeof value !== 'object' || value === null || !('notes' in value) || !Array.isArray(value.notes)) {
    throw new QaFailure('assertion', 'Score hit map is unavailable');
  }
  return value.notes.map((note: unknown): QaNoteHit => {
    if (typeof note !== 'object' || note === null || !('generation' in note) || typeof note.generation !== 'number' ||
      !('noteId' in note) || typeof note.noteId !== 'string' || !('eventId' in note) || typeof note.eventId !== 'string' ||
      !('trackId' in note) || typeof note.trackId !== 'string' || !('bounds' in note) || typeof note.bounds !== 'object' || note.bounds === null) {
      throw new QaFailure('assertion', 'Invalid semantic note hit');
    }
    const bounds = note.bounds;
    if (!('x' in bounds) || typeof bounds.x !== 'number' || !('y' in bounds) || typeof bounds.y !== 'number' ||
      !('width' in bounds) || typeof bounds.width !== 'number' || !('height' in bounds) || typeof bounds.height !== 'number') {
      throw new QaFailure('assertion', 'Invalid semantic note rectangle');
    }
    return { generation: note.generation, noteId: note.noteId, eventId: note.eventId, trackId: note.trackId,
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  });
}

export async function waitForScore(page: Page, previousGeneration?: number): Promise<void> {
  await page.waitForFunction(previous => {
    const view = document.querySelector('[data-testid="score-view"]');
    const generation = Number(view?.getAttribute('data-generation'));
    return view?.getAttribute('aria-busy') === 'false' && generation > 0 && (previous === undefined || generation !== previous);
  }, previousGeneration, { timeout: 30_000 });
}

export async function clickControl(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new QaFailure('assertion', `Control ${testId} is not visible`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function notePoint(page: Page, hit: QaNoteHit): Promise<{ readonly x: number; readonly y: number }> {
  const box = await page.getByTestId('score-engine').boundingBox();
  if (!box) throw new QaFailure('assertion', 'Score canvas is not visible');
  return { x: box.x + hit.x + hit.width / 2, y: box.y + hit.y + hit.height / 2 };
}

export const run: QaCase = async context => {
  await withElectron(context, async ({ application, page }) => {
    await page.evaluate(() => { location.hash = '#/score-harness'; });
    await page.getByTestId('score-harness').waitFor({ state: 'visible' });
    await waitForScore(page);
    const session = await application.context().newCDPSession(page);
    let theme = 'dark';
    let multi = false;
    let zoom = 1;
    for (const width of [1440, 1024]) for (const scale of [1, 2]) for (const desiredTheme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 });
      await session.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 900 : 700, deviceScaleFactor: scale, mobile: false });
      if (theme !== desiredTheme) { await clickControl(page, 'theme-switch'); theme = desiredTheme; }
      for (const desiredZoom of [1, 1.5]) {
        if (zoom !== desiredZoom) { await clickControl(page, zoom < desiredZoom ? 'zoom-in' : 'zoom-out'); zoom = desiredZoom; }
        for (const mode of ['tab', 'standard', 'both', 'multi']) {
          const desiredMulti = mode === 'multi';
          if (multi !== desiredMulti) { await clickControl(page, 'multitrack'); multi = desiredMulti; }
          await clickControl(page, `mode-${mode === 'multi' ? 'both' : mode}`);
          await waitForScore(page);
          const hits = await readScoreHits(page);
          const label = `${width}-${scale}x-${theme}-${zoom * 100}-${mode}`;
          context.assert(new Set(hits.map(hit => hit.trackId)).size === (multi ? 3 : 1), `${label}: requested part count has real note bounds`);
          context.assert(await page.getByTestId('score-engine').locator('svg').count() > 0, `${label}: alphaTab SVG notation rendered`);
          context.assert(await page.locator('.at-cursor-beat, .at-cursor-bar, .at-selection').count() === 0, `${label}: built-in cursor and selection are disabled`);
          const target = hits.find(hit => hit.y + hit.height < 450);
          if (!target) throw new QaFailure('assertion', 'No visible note to select');
          const point = await notePoint(page, target);
          await page.mouse.click(point.x, point.y);
          await page.waitForFunction(noteId => {
            const text = document.querySelector('[data-testid="score-selection"]')?.textContent;
            return text?.includes(noteId) === true;
          }, target.noteId);
          context.assert(await page.locator('[data-overlay-kind="note"]').count() > 0, `${label}: pointer selects domain note and shows app overlay`);
          await page.screenshot({ path: resolve(context.evidence, `${label}.png`) });
          context.log(`${label}: clicked note ${target.noteId} at ${point.x},${point.y}; generation ${target.generation}`);
        }
      }
    }
    await clickControl(page, 'nested-tuplets');
    await waitForScore(page);
    context.assert(await page.locator('[data-tuplet-id]').count() === 4,
      'Nested 3:2 and 5:4 brackets appear independently on standard notation and tab');
    await page.screenshot({ path: resolve(context.evidence, 'nested-tuplets.png') });
    await writeFile(resolve(context.evidence, 'final-hit-map.json'), JSON.stringify(await readScoreHits(page), null, 2));
    await session.send('Emulation.clearDeviceMetricsOverride');
  });
};
