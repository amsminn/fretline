import { expect, it, vi } from 'vitest';
import { buildPlayback, PlaybackTransport } from '../../src/renderer/audio/transport';
import type { PlaybackDriver, PlaybackPosition } from '../../src/renderer/audio/transport';
import { CursorSurface, playbackCursor, visualTick } from '../../src/renderer/audio/cursor';
import { fixtureDocument } from '../domain/fixtures';
import { indexDocument } from '../../src/domain/event-time';
import { visibleHitMap } from '../../src/renderer/score/visible-hit-map';
import type { ScoreDocument } from '../../src/domain/document';
import type { ScoreHit } from '../../src/renderer/score/overlay';

const displayFrame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));

class CursorClock implements PlaybackDriver {
  position: PlaybackPosition = { tick: 0, seconds: 0, total: 32, bpm: 120 };
  private readonly listeners = new Set<(position: PlaybackPosition) => void>();
  start(tick: number): void { this.position = { ...this.position, tick, seconds: tick / 1920 }; }
  reset(tick: number): void { this.start(tick); }
  subscribe(listener: (position: PlaybackPosition) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  advance(tick: number): void { this.start(tick); for (const listener of this.listeners) listener(this.position); }
  destroy(): void { this.listeners.clear(); }
}

async function mountedCursor(score: ScoreDocument = fixtureDocument('loop-eight-bars')) {
  const parent = document.createElement('div'); const host = document.createElement('div');
  parent.append(host); document.body.append(parent);
  const driver = new CursorClock();
  const transport = new PlaybackTransport(async () => driver);
  transport.setDocument(score, 1);
  const surface = new CursorSurface(transport, () => {});
  surface.setDocument(score);
  const generation = visibleHitMap.begin(score, host).generation;
  const index = indexDocument(score);
  const beats: ScoreHit[] = score.tracks.flatMap((track, trackIndex) => [...index.events].flatMap(([eventId, location]) =>
    track.staves.includes(location.staff) ? [{ generation, eventId, trackId: track.id,
      staffId: location.staff.id, voiceId: location.voiceId, measureId: location.measureId,
      startQ: location.startQ, endQ: location.endQ, system: 0,
      bounds: { x: Number(location.startQ.n) / Number(location.startQ.d) * 20, y: trackIndex * 100, width: 10, height: 80 } }] : []));
  const map = { generation, beats, notes: [] };
  visibleHitMap.publish(map);
  await transport.play(0);
  await displayFrame();
  const cursor = parent.querySelector<HTMLElement>('[data-testid="playback-cursor"]');
  if (!cursor) throw new TypeError('Cursor fixture did not mount');
  return { cursor, driver, map, score, surface, close: (): void => {
    surface.destroy(); transport.destroy(); visibleHitMap.clear(generation); parent.remove();
  } };
}

it('maps repeated audio occurrences back to the same written event with distinct occurrence IDs', () => {
  const built = buildPlayback(fixtureDocument('alternate-endings'));
  const first = playbackCursor(built, 0);
  const repeat = playbackCursor(built, 11520);
  expect(first?.eventId).toBe(repeat?.eventId);
  expect(first?.occurrenceId).not.toBe(repeat?.occurrenceId);
  expect(repeat?.playbackStartQ).toEqual({ n: '12', d: '1' });
});

it('draws the frame for the instant it is seen: one refresh ahead, minus the device output latency', () => {
  const playing = { status: 'playing', tick: 960, bpm: 120 } as const;
  // 120 bpm at 960 ppq is 1920 ticks per second.
  expect(visualTick(playing, 30720, 0.012)).toBeCloseTo(960 + 23.04, 6);
  expect(visualTick(playing, 30720, 0.012 - 0.03)).toBeCloseTo(960 - 34.56, 6);
  expect(visualTick({ ...playing, bpm: 60 }, 30720, 0.012)).toBeCloseTo(960 + 11.52, 6);
});

it('keeps the exact transport tick when not playing and never leaves the sounding timeline', () => {
  expect(visualTick({ status: 'paused', tick: 960, bpm: 120 }, 30720, 0.012)).toBe(960);
  expect(visualTick({ status: 'stopped', tick: 0, bpm: 120 }, 30720, 0.012)).toBe(0);
  expect(visualTick({ status: 'playing', tick: 30715, bpm: 120 }, 30720, 0.012)).toBe(30719);
  expect(visualTick({ status: 'playing', tick: 10, bpm: 120 }, 30720, -0.05)).toBe(0);
});

it('uses the selected track and clears the cursor outside the sounding timeline', () => {
  const built = buildPlayback(fixtureDocument('loop-eight-bars'));
  const a = playbackCursor(built, 960, 0);
  const b = playbackCursor(built, 960, 1);
  expect(a?.eventId).not.toBe(b?.eventId);
  expect(a?.writtenStartQ).toEqual(b?.writtenStartQ);
  expect(playbackCursor(built, -1)).toBeNull();
  expect(playbackCursor(built, 32 * 960)).toBeNull();
});

it('keeps unchanged multitrack cursor geometry without DOM mutations or detached lines', async () => {
  const mounted = await mountedCursor();
  const observer = new MutationObserver(() => {});
  observer.observe(mounted.cursor, { attributes: true, subtree: true, childList: true });
  try {
    expect(mounted.cursor.childElementCount).toBe(2);
    const line = mounted.cursor.firstElementChild;
    // Layout publication may race a clock tick without changing any geometry.
    visibleHitMap.publish({ ...mounted.map, beats: mounted.map.beats.map(hit =>
      ({ ...hit, bounds: { ...hit.bounds } })) });
    mounted.driver.advance(100);
    await displayFrame();
    expect(mounted.cursor.firstElementChild).toBe(line);
    expect(observer.takeRecords()).toHaveLength(0);
  } finally { observer.disconnect(); mounted.close(); }
});

it('redraws cursor geometry when the score layout changes within the same beat', async () => {
  const mounted = await mountedCursor();
  try {
    visibleHitMap.publish({ ...mounted.map, beats: mounted.map.beats.map(hit =>
      ({ ...hit, bounds: { ...hit.bounds, x: hit.bounds.x + 40 } })) });
    expect(mounted.cursor.style.transform).toBe('translate(40px,0px)');
  } finally { mounted.close(); }
});

it('updates the sounding occurrence when a repeat returns to the same written beat', async () => {
  const mounted = await mountedCursor(fixtureDocument('alternate-endings'));
  try {
    const eventId = mounted.cursor.dataset['eventId'];
    const occurrenceId = mounted.cursor.dataset['occurrenceId'];
    mounted.driver.advance(11520);
    await displayFrame();
    expect(mounted.cursor.dataset['eventId']).toBe(eventId);
    expect(mounted.cursor.dataset['occurrenceId']).not.toBe(occurrenceId);
  } finally { mounted.close(); }
});

it('detaches the playback cursor from the previous score when the document closes', async () => {
  const mounted = await mountedCursor();
  try {
    mounted.surface.setDocument(null);
    expect(mounted.cursor.parentElement).toBeNull();
  } finally { mounted.close(); }
});

it('redraws the sounding beat synchronously when a hidden document becomes visible', async () => {
  const mounted = await mountedCursor();
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
  try {
    const initial = mounted.cursor.dataset['eventId'];
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    mounted.driver.advance(960);
    expect(mounted.cursor.dataset['eventId']).toBe(initial);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mounted.cursor.dataset['eventId']).toBe(playbackCursor(buildPlayback(mounted.score), 960)?.eventId);
  } finally {
    frame.mockRestore();
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    mounted.close();
  }
});
