import type { Page } from '@playwright/test';
import { QaFailure } from '../../lib/contracts';

export type BeatHit = {
  readonly generation: number; readonly eventId: string; readonly trackId: string; readonly system: number;
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
};
export type SelectionObservation = {
  readonly kind: string | null; readonly direction: string | null;
  readonly range: { readonly startQ: { readonly n: string; readonly d: string }; readonly endQ: { readonly n: string; readonly d: string } } | null;
  readonly anchor: string | null; readonly focus: string | null;
  readonly trackIds: readonly string[]; readonly dragging: boolean; readonly rejected: number; readonly generation: number;
};
export type Point = { readonly x: number; readonly y: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export async function openEditorHarness(page: Page, viewport = { width: 1440, height: 900 }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.evaluate(() => { location.hash = '#/editor-harness'; });
  await page.getByTestId('editor-harness').waitFor({ state: 'visible', timeout: 20_000 });
  await waitForEditorScore(page);
}
export async function waitForEditorScore(page: Page, previousGeneration?: number): Promise<number> {
  await page.waitForFunction(previous => {
    const view = document.querySelector('[data-testid="score-view"]');
    const generation = Number(view?.getAttribute('data-generation'));
    return view?.getAttribute('aria-busy') === 'false' && generation > 0 && (previous === undefined || generation !== previous);
  }, previousGeneration, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  return Number(await page.getByTestId('score-view').getAttribute('data-generation'));
}

export async function readBeats(page: Page): Promise<ReadonlyMap<string, readonly BeatHit[]>> {
  const map: unknown = JSON.parse(await page.getByTestId('score-hit-map').textContent() ?? 'null');
  const labels: unknown = JSON.parse(await page.getByTestId('harness-labels').textContent() ?? '{}');
  if (!isRecord(map) || !Array.isArray(map['beats']) || !isRecord(labels)) throw new QaFailure('assertion', 'Editor hit map is unavailable');
  const byLabel = new Map<string, BeatHit[]>();
  for (const beat of map['beats']) {
    if (!isRecord(beat) || typeof beat['eventId'] !== 'string' || typeof beat['trackId'] !== 'string' || typeof beat['generation'] !== 'number' ||
      typeof beat['system'] !== 'number' || !isRecord(beat['bounds'])) throw new QaFailure('assertion', 'Invalid semantic beat hit');
    const bounds = beat['bounds'];
    if (typeof bounds['x'] !== 'number' || typeof bounds['y'] !== 'number' || typeof bounds['width'] !== 'number' || typeof bounds['height'] !== 'number') {
      throw new QaFailure('assertion', 'Invalid semantic beat rectangle');
    }
    const label = labels[beat['eventId']];
    if (typeof label !== 'string') continue;
    const list = byLabel.get(label) ?? [];
    list.push({ generation: beat['generation'], eventId: beat['eventId'], trackId: beat['trackId'], system: beat['system'],
      x: bounds['x'], y: bounds['y'], width: bounds['width'], height: bounds['height'] });
    byLabel.set(label, list);
  }
  return byLabel;
}

/** Viewport coordinates of a beat's centre; scrolls the beat into the score viewport first so the pointer can reach it. */
export async function beatPoint(page: Page, label: string, trackIndex = 0): Promise<Point> {
  const hit = (await readBeats(page)).get(label)?.[trackIndex];
  if (!hit) throw new QaFailure('assertion', `Beat ${label} (track ${trackIndex}) has no bounds`);
  await page.evaluate(([y, height]) => {
    const scroll = document.querySelector('[data-testid="score-scroll"]');
    const engine = document.querySelector('[data-testid="score-engine"]');
    if (!(scroll instanceof HTMLElement) || !(engine instanceof HTMLElement)) return;
    const top = engine.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop + y;
    if (top < scroll.scrollTop + 40 || top + height > scroll.scrollTop + scroll.clientHeight - 40) scroll.scrollTop = Math.max(0, top - scroll.clientHeight / 2);
  }, [hit.y, hit.height] as const);
  const box = await page.getByTestId('score-engine').boundingBox();
  if (!box) throw new QaFailure('assertion', 'Score canvas is not visible');
  return { x: box.x + hit.x + hit.width / 2, y: box.y + hit.y + hit.height / 2 };
}

export async function readSelection(page: Page): Promise<SelectionObservation> {
  const value: unknown = JSON.parse(await page.getByTestId('editor-selection').textContent() ?? 'null');
  if (!isRecord(value) || typeof value['dragging'] !== 'boolean' || typeof value['rejected'] !== 'number' || !Array.isArray(value['trackIds'])) {
    throw new QaFailure('assertion', 'Editor selection observation is unavailable');
  }
  const range = value['range'];
  const quarter = (q: unknown) => isRecord(q) && typeof q['n'] === 'string' && typeof q['d'] === 'string' ? { n: q['n'], d: q['d'] } : undefined;
  const startQ = isRecord(range) ? quarter(range['startQ']) : undefined;
  const endQ = isRecord(range) ? quarter(range['endQ']) : undefined;
  return {
    kind: typeof value['kind'] === 'string' ? value['kind'] : null, direction: typeof value['direction'] === 'string' ? value['direction'] : null,
    range: startQ && endQ ? { startQ, endQ } : null,
    anchor: typeof value['anchor'] === 'string' ? value['anchor'] : null, focus: typeof value['focus'] === 'string' ? value['focus'] : null,
    trackIds: value['trackIds'].filter((id): id is string => typeof id === 'string'),
    dragging: value['dragging'], rejected: value['rejected'], generation: typeof value['generation'] === 'number' ? value['generation'] : 0,
  };
}
export const rangeText = (selection: SelectionObservation): string =>
  selection.range ? `[${selection.range.startQ.n}/${selection.range.startQ.d},${selection.range.endQ.n}/${selection.range.endQ.d})` : 'none';

export async function dragBetween(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 2, from.y + 1);
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}
export async function dragBeats(page: Page, from: string, to: string, tracks: readonly [number, number] = [0, 0]): Promise<void> {
  const start = await beatPoint(page, from, tracks[0]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 2, start.y + 1);
  const end = await beatPoint(page, to, tracks[1]);
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}
export const selectionRects = (page: Page) => page.locator('[data-overlay-kind="selection"]').count();
