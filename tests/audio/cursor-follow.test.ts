import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CursorSurface } from '../../src/renderer/audio/cursor';
import { PlaybackTransport } from '../../src/renderer/audio/transport';
import type { PlaybackDriver, PlaybackPosition } from '../../src/renderer/audio/transport';
import { fixtureDocument } from '../domain/fixtures';
import { indexDocument } from '../../src/domain/event-time';
import { visibleHitMap } from '../../src/renderer/score/visible-hit-map';
import type { ScoreHit } from '../../src/renderer/score/overlay';

class ClockDriver implements PlaybackDriver {
  position: PlaybackPosition = { tick: 0, seconds: 0, total: 16, bpm: 120 };
  start(tick: number): void { this.position = { ...this.position, tick, seconds: tick / 1920 }; }
  reset(tick: number): void { this.start(tick); }
  subscribe(): () => void { return () => {}; }
  destroy(): void {}
}

let transport: PlaybackTransport;
let surface: CursorSurface;
let scroller: HTMLDivElement;
let view: HTMLDivElement;
let generation = 0;

/** The score scroller as the shell mounts it: a client box plus a scrollbar gutter on the right and bottom. */
const mountScroller = (): void => {
  scroller = document.createElement('div');
  scroller.className = 'score-scroll';
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 900 });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
  view = document.createElement('div');
  view.dataset['testid'] = 'score-view';
  view.tabIndex = 0;
  scroller.append(view);
  document.body.append(scroller);
};
const press = (target: Element, offset: { readonly x: number; readonly y: number }): void => {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, 'offsetX', { value: offset.x });
  Object.defineProperty(event, 'offsetY', { value: offset.y });
  target.dispatchEvent(event);
};
const scrollTo = (top: number): void => {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
};

beforeEach(async () => {
  mountScroller();
  transport = new PlaybackTransport(async () => new ClockDriver());
  const score = fixtureDocument('loop-eight-bars');
  transport.setDocument(score, 1);
  surface = new CursorSurface(transport, () => {});
  surface.setDocument(score);
  generation = visibleHitMap.begin(score, view).generation;
  const index = indexDocument(score);
  const beats: ScoreHit[] = [...index.events].flatMap(([eventId, location]) =>
    location.staff === score.tracks[0]?.staves[0] ? [{ generation, eventId, trackId: score.tracks[0].id,
      staffId: location.staff.id, voiceId: location.voiceId, measureId: location.measureId,
      startQ: location.startQ, endQ: location.endQ, system: 0,
      bounds: { x: Number(location.startQ.n) * 20, y: 700, width: 10, height: 80 } }] : []);
  visibleHitMap.publish({ generation, beats, notes: [] });
  await transport.play(0);
  expect(transport.getSnapshot()).toMatchObject({ status: 'playing', follow: true });
});
afterEach(() => { surface.destroy(); transport.destroy(); visibleHitMap.clear(generation); scroller.remove(); });

describe('playback follow suspension (UX15)', () => {
  it('keeps following across automatic and layout-induced scrolls, including after a resume', () => {
    scrollTo(120);
    expect(transport.getSnapshot().follow).toBe(true);
    transport.suspendFollow();
    expect(transport.getSnapshot().follow).toBe(false);
    transport.resumeFollow();
    // The toolbar re-lays out when the resume control changes state and the scroller clamps or adjusts scrollTop.
    scrollTo(124);
    scrollTo(126);
    expect(transport.getSnapshot().follow).toBe(true);
  });
  it('suspends on a wheel over the score', () => {
    view.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
    expect(transport.getSnapshot().follow).toBe(false);
  });
  it('suspends on a scroll key inside the score view and ignores the same key elsewhere', () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(transport.getSnapshot().follow).toBe(true);
    view.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(transport.getSnapshot().follow).toBe(false);
  });
  it('suspends on a scrollbar press but not on a press inside the client area or on score content', () => {
    press(view, { x: 10, y: 10 });
    press(scroller, { x: 400, y: 300 });
    expect(transport.getSnapshot().follow).toBe(true);
    press(scroller, { x: 905, y: 300 });
    expect(transport.getSnapshot().follow).toBe(false);
    transport.resumeFollow();
    press(scroller, { x: 400, y: 604 });
    expect(transport.getSnapshot().follow).toBe(false);
  });
  it('suspends on an overlay-scrollbar drag (press in the edge zone, then a scroll before release) but not on a programmatic scroll after release', () => {
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2400 });
    press(scroller, { x: 892, y: 300 });
    expect(transport.getSnapshot().follow).toBe(true);
    scrollTo(300);
    expect(transport.getSnapshot().follow).toBe(false);
    transport.resumeFollow();
    press(scroller, { x: 892, y: 300 });
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    scrollTo(320);
    expect(transport.getSnapshot().follow).toBe(true);
    press(scroller, { x: 400, y: 300 });
    scrollTo(340);
    expect(transport.getSnapshot().follow).toBe(true);
  });
  it('ignores its own follow scroll while armed and removes the pending watch on destroy', async () => {
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2400 });
    Object.defineProperty(scroller, 'getBoundingClientRect', { configurable: true,
      value: () => new DOMRect(0, 0, 900, 600) });
    const cursor = scroller.querySelector<HTMLElement>('[data-testid="playback-cursor"]');
    if (!cursor) throw new TypeError('Missing playback cursor');
    Object.defineProperty(cursor, 'getBoundingClientRect', { configurable: true,
      value: () => new DOMRect(20, 700, 2, 80) });
    Object.defineProperty(cursor, 'scrollIntoView', { configurable: true, value: () => scrollTo(300) });
    press(scroller, { x: 892, y: 300 });
    transport.seek(960);
    expect(transport.getSnapshot().follow).toBe(true);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    scrollTo(320);
    expect(transport.getSnapshot().follow).toBe(false);
    transport.resumeFollow();
    press(scroller, { x: 892, y: 300 });
    surface.destroy();
    scrollTo(340);
    expect(transport.getSnapshot().follow).toBe(true);
  });
});
