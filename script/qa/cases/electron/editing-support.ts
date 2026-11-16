import type { Page } from '@playwright/test';
import type { EditingObservation } from '../../../../src/renderer/commands/editing-observation';
import { QaFailure } from '../../lib/contracts';
import type { Point } from './selection-support';

export async function readEditing(page: Page): Promise<EditingObservation> {
  const observation = await page.evaluate(() => window.fretlineEditingObservation?.() ?? null);
  if (!observation) throw new QaFailure('assertion', 'Editing observation is unavailable (FRETLINE_QA renderer required)');
  return observation;
}
export async function eventIdOf(page: Page, label: string): Promise<string> {
  const labels: unknown = JSON.parse(await page.getByTestId('harness-labels').textContent() ?? '{}');
  const entry = typeof labels === 'object' && labels !== null ? Object.entries(labels).find(([, value]) => value === label) : undefined;
  if (!entry) throw new QaFailure('assertion', `Unknown beat label ${label}`);
  return entry[0];
}
/** Viewport centre of the first note head drawn for a beat, so a click selects the note rather than the beat. */
export async function notePoint(page: Page, label: string): Promise<Point> {
  const eventId = await eventIdOf(page, label);
  const map: unknown = JSON.parse(await page.getByTestId('score-hit-map').textContent() ?? 'null');
  const notes = typeof map === 'object' && map !== null && 'notes' in map && Array.isArray(map.notes) ? map.notes : [];
  const note: unknown = notes.find((candidate: unknown) => typeof candidate === 'object' && candidate !== null && 'eventId' in candidate && candidate.eventId === eventId);
  if (typeof note !== 'object' || note === null || !('bounds' in note) || typeof note.bounds !== 'object' || note.bounds === null) throw new QaFailure('assertion', `Beat ${label} has no note head bounds`);
  const bounds: object = note.bounds;
  if (!('x' in bounds) || !('y' in bounds) || !('width' in bounds) || !('height' in bounds)) throw new QaFailure('assertion', 'Invalid note head rectangle');
  const { x, y, width, height } = bounds;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') throw new QaFailure('assertion', 'Invalid note head rectangle');
  const box = await page.getByTestId('score-engine').boundingBox();
  if (!box) throw new QaFailure('assertion', 'Score canvas is not visible');
  return { x: box.x + x + width / 2, y: box.y + y + height / 2 };
}
export const frets = (observation: EditingObservation, eventId: string): readonly (readonly [number, number])[] => observation.events[eventId]?.notes ?? [];
export async function waitForFret(page: Page, eventId: string, fret: number): Promise<EditingObservation> {
  await page.waitForFunction(([id, value]) => window.fretlineEditingObservation?.().events[id]?.notes.some(([, current]) => current === value) === true, [eventId, fret] as const, { timeout: 5000 });
  return readEditing(page);
}
/** Rendered fret digits inside the engine SVG; the number must appear in the drawing, not only in the model. */
export const renderedFretCount = (page: Page, fret: number) => page.locator('[data-testid="score-engine"] svg text', { hasText: new RegExp(`^${fret}$`) }).count();
