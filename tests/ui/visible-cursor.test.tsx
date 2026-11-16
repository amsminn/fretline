import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rendering } from '@coderline/alphatab/core';
import { ScoreView } from '../../src/renderer/score/ScoreView';
import type { ScoreHitMap } from '../../src/renderer/score/overlay';
import { CursorSurface } from '../../src/renderer/audio/cursor';
import { PlaybackTransport } from '../../src/renderer/audio/transport';
import type { PlaybackDriver, PlaybackPosition } from '../../src/renderer/audio/transport';
import { fixtureDocument } from '../domain/fixtures';
import { EditorScoreView } from '../../src/renderer/editor/EditorScoreView';
import { caretSelection, SelectionStore } from '../../src/renderer/editor/selection-state';
import { useState } from 'react';
import type { ScoreDocument } from '../../src/domain/document';
import { DesignOverlay } from '../../src/renderer/score/DesignOverlay';

class ClockDriver implements PlaybackDriver {
  position: PlaybackPosition = { tick: 0, seconds: 0, total: 16, bpm: 120 };
  private readonly listeners = new Set<(position: PlaybackPosition) => void>();
  start(tick: number): void { this.position = { ...this.position, tick, seconds: tick / 1920 }; }
  reset(tick: number): void { this.start(tick); }
  subscribe(listener: (position: PlaybackPosition) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  advance(tick: number): void {
    this.start(tick);
    for (const listener of this.listeners) listener(this.position);
  }
  destroy(): void { this.listeners.clear(); }
}

let surface: CursorSurface | undefined;
let transport: PlaybackTransport | undefined;
const fonts = { load: async (): Promise<readonly FontFace[]> => [], ready: Promise.resolve() };

beforeEach(() => {
  // happy-dom does not implement font loading, canvas metrics or resize delivery.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(918);
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => {
    const context = { font: '', measureText: (text: string) => {
      const px = Number(/([\d.]+)px/.exec(context.font)?.[1] ?? 11);
      return { width: text.length * px * 0.6, actualBoundingBoxAscent: px * 0.7, actualBoundingBoxDescent: px * 0.2 };
    } };
    return context;
  } });
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback([{ target, contentRect: new DOMRect(0, 0, 918, 700),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this);
    }
    disconnect(): void {}
    unobserve(): void {}
  });
});

afterEach(() => {
  surface?.destroy(); transport?.destroy(); cleanup();
  surface = undefined; transport = undefined;
  vi.unstubAllGlobals();
});

function ScoreWithSymbols({ score }: { readonly score: ScoreDocument }) {
  const [map, setMap] = useState<ScoreHitMap>();
  return <div>
    <ScoreView document={score} onRendered={setMap} />
    <DesignOverlay document={score} map={map} offset={{ x: 0, y: 0 }} scale={1} design={false}
      onSymbol={() => {}} onLineBreak={() => {}} onSpacing={() => {}} />
  </div>;
}

it('advances playback through printed symbols without remeasuring or mutating their overlay', async () => {
  const score = fixtureDocument('loop-eight-bars');
  const driver = new ClockDriver();
  transport = new PlaybackTransport(async () => driver);
  transport.setDocument(score, 1);
  surface = new CursorSurface(transport, () => {});
  surface.setDocument(score);
  render(<ScoreWithSymbols score={score} />);
  await waitFor(() => expect(surface?.getHitMap()?.beats.length).toBeGreaterThan(0));
  const engine = screen.getByTestId('score-engine');
  const labels = [...engine.querySelectorAll('text')];
  expect(labels.length).toBeGreaterThan(0);
  const bounds = labels.map(label => vi.spyOn(label, 'getBoundingClientRect'));
  const mutations: MutationRecord[] = [];
  const overlay = screen.getByTestId('design-overlay');
  const observer = new MutationObserver(records => mutations.push(...records));
  observer.observe(overlay, { attributes: true, childList: true, subtree: true });
  try {
    await act(async () => { await transport?.play(0); });
    const cursor = screen.getByTestId('playback-cursor');
    const initial = cursor.dataset['eventId'];
    for (let beat = 1; beat <= 8; beat++) {
      await act(async () => {
        driver.advance(beat * 960);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
    }
    expect(cursor.dataset['eventId']).not.toBe(initial);
    expect(bounds.map(spy => spy.mock.calls.length)).toEqual(labels.map(() => 0));
    expect([...mutations, ...observer.takeRecords()]).toEqual([]);
  } finally {
    observer.disconnect();
    for (const spy of bounds) spy.mockRestore();
  }
});

it('clears rendered score chunks when the score view unmounts', async () => {
  const score = fixtureDocument('loop-eight-bars');
  const view = render(<ScoreView document={score} />);
  const engine = screen.getByTestId('score-engine');
  await waitFor(() => expect(engine.childElementCount).toBeGreaterThan(0));
  view.unmount();
  expect(engine.childElementCount).toBe(0);
});

it.each([1, 3])('uses the visible %i-track beat bounds without a second engraving', async trackCount => {
  const score = fixtureDocument('loop-eight-bars');
  const driver = new ClockDriver();
  transport = new PlaybackTransport(async () => driver);
  transport.setDocument(score, 1);
  surface = new CursorSurface(transport, () => {});
  surface.setDocument(score);
  const engravings = vi.spyOn(rendering.ScoreRenderer.prototype, 'renderScore');
  let visible: ScoreHitMap | undefined;
  render(<ScoreView document={score} trackIds={score.tracks.slice(0, trackCount).map(track => track.id)}
    onRendered={map => { visible = map; }} />);
  await waitFor(() => expect(visible?.beats.length).toBeGreaterThan(0));
  await waitFor(() => expect(surface?.getHitMap()?.beats.length).toBeGreaterThan(0));
  await act(async () => { await transport?.play(5 * 960); });

  const hit = visible?.beats.find(beat => beat.trackId === score.tracks[0]?.id && beat.startQ.n === '5');
  if (!hit) throw new RangeError('Missing visible beat');
  const cursor = screen.getByTestId('playback-cursor');
  expect(cursor.hidden).toBe(false);
  expect({ transform: cursor.style.transform, height: cursor.style.height })
    .toEqual({ transform: `translate(${hit.bounds.x}px,${hit.bounds.y}px)`, height: `${hit.bounds.height}px` });
  expect(surface.getHitMap()).toBe(visible);
  const sounding = visible?.beats.filter(beat => beat.startQ.n === '5') ?? [];
  expect([...cursor.children].map(line => line instanceof HTMLElement ? {
    eventId: line.dataset['eventId'], transform: line.style.transform, height: line.style.height, width: line.style.width,
  } : null)).toEqual(sounding.slice(1).map(other => ({
    eventId: other.eventId, transform: `translate(${other.bounds.x - hit.bounds.x}px,${other.bounds.y - hit.bounds.y}px)`,
    height: `${other.bounds.height}px`, width: '2px',
  })));
  expect(engravings).toHaveBeenCalledTimes(1);
});

it('clears every consumer during relayout and rejects an old press and a late render completion', async () => {
  const score = fixtureDocument('loop-eight-bars');
  const driver = new ClockDriver();
  transport = new PlaybackTransport(async () => driver);
  transport.setDocument(score, 1);
  surface = new CursorSurface(transport, () => {});
  surface.setDocument(score);
  const engravings = vi.spyOn(rendering.ScoreRenderer.prototype, 'renderScore');
  const selection = new SelectionStore();
  const published: ScoreHitMap[] = [];
  const onRendered = (map: ScoreHitMap): void => { published.push(map); };
  const view = render(<EditorScoreView document={score} store={selection} onRendered={onRendered} />);
  await waitFor(() => expect(published.at(-1)?.beats.length).toBeGreaterThan(0));
  await act(async () => { await transport?.play(960); });
  const previous = surface.getHitMap();
  const hit = previous?.beats[0];
  if (!hit) throw new RangeError('Missing initial beat');
  act(() => selection.set(caretSelection(score, hit)));
  const editor = screen.getByTestId('editor-surface');
  const point = { clientX: hit.bounds.x + hit.bounds.width / 2, clientY: hit.bounds.y + hit.bounds.height / 2 };
  fireEvent.pointerDown(editor, { ...point, button: 0, buttons: 1, detail: 1 });
  const cursor = screen.getByTestId('playback-cursor');
  const oldFonts = Promise.withResolvers<readonly FontFace[]>();
  const freshFonts = Promise.withResolvers<readonly FontFace[]>();
  const oldRequested = Promise.withResolvers<void>();
  const freshRequested = Promise.withResolvers<void>();
  vi.spyOn(fonts, 'load')
    .mockImplementationOnce(() => { oldRequested.resolve(); return oldFonts.promise; })
    .mockImplementationOnce(() => { freshRequested.resolve(); return freshFonts.promise; });

  view.rerender(<EditorScoreView document={score} store={selection} zoom={1.5} onRendered={onRendered} />);
  await act(async () => { await oldRequested.promise; });
  expect(published.at(-1)?.beats).toEqual([]);
  expect(surface.getHitMap()).toBe(published.at(-1));
  expect(cursor.hidden).toBe(true);
  expect(screen.queryByTestId('editor-caret')).toBeNull();
  expect(screen.queryByTestId('score-overlay')).toBeNull();
  view.rerender(<EditorScoreView document={score} store={selection} zoom={0.8} onRendered={onRendered} />);
  await act(async () => { await freshRequested.promise; });
  const current = published.at(-1);
  await act(async () => { oldFonts.resolve([]); await oldFonts.promise; });
  expect(surface.getHitMap()).toBe(current);
  expect(cursor.hidden).toBe(true);
  await act(async () => { freshFonts.resolve([]); await freshFonts.promise; });
  await waitFor(() => expect(published.at(-1)?.beats.length).toBeGreaterThan(0));

  const fresh = surface.getHitMap();
  expect(fresh).toBe(published.at(-1));
  expect(fresh?.generation).not.toBe(previous?.generation);
  const sounding = fresh?.beats.find(beat => beat.eventId === cursor.dataset['eventId']);
  if (!sounding) throw new RangeError('Missing fresh cursor beat');
  expect({ hidden: cursor.hidden, transform: cursor.style.transform, height: cursor.style.height })
    .toEqual({ hidden: false, transform: `translate(${sounding.bounds.x}px,${sounding.bounds.y}px)`, height: `${sounding.bounds.height}px` });
  fireEvent.pointerMove(editor, { clientX: point.clientX + 10, clientY: point.clientY, buttons: 1 });
  fireEvent.pointerUp(editor, point);
  expect(selection.getSnapshot()).toEqual({ selection: caretSelection(score, hit), dragging: false, rejected: 1 });
  expect(engravings).toHaveBeenCalledTimes(2);
});

it('advances on displayed staves when the active audio track is hidden', async () => {
  const score = fixtureDocument('loop-eight-bars');
  const displayed = score.tracks[1];
  if (!displayed) throw new RangeError('Missing second track');
  const driver = new ClockDriver();
  transport = new PlaybackTransport(async () => driver);
  transport.setDocument(score, 1);
  surface = new CursorSurface(transport, () => {});
  surface.setDocument(score);
  surface.setTrack(0);
  let visible: ScoreHitMap | undefined;
  render(<ScoreView document={score} trackIds={[displayed.id]} onRendered={map => { visible = map; }} />);
  await waitFor(() => expect(visible?.beats.length).toBeGreaterThan(0));
  await act(async () => { await transport?.play(2 * 960); });
  const hit = visible?.beats.find(beat => beat.startQ.n === '2');
  if (!hit) throw new RangeError('Missing displayed beat');
  const cursor = screen.getByTestId('playback-cursor');
  expect(cursor.hidden).toBe(false);
  expect(cursor.dataset['eventId']).toBe(hit.eventId);
  expect(new Set(surface.getHitMap()?.beats.map(beat => beat.trackId))).toEqual(new Set([displayed.id]));
  act(() => transport?.seek(3 * 960));
  const next = visible?.beats.find(beat => beat.startQ.n === '3');
  expect(cursor.dataset['eventId']).toBe(next?.eventId);
  expect(cursor.style.transform).toBe(`translate(${next?.bounds.x}px,${next?.bounds.y}px)`);
});
