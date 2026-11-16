import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackBuild, PlaybackDriver, PlaybackPosition } from '../../src/renderer/audio/transport';
import { LoopClock, RangeSynth } from '../../src/renderer/audio/loop-range';
import { transportRuntime } from '../../src/renderer/commands/transport';
import { bindCommandKeys } from '../../src/renderer/commands/registry';
import { LoopSpeed } from '../../src/renderer/toolbar/LoopSpeed';
import { ServicesContext } from '../../src/renderer/shell/services';
import { TooltipProvider } from '../../src/renderer/ui';
import { PointerController } from '../../src/renderer/editor/pointer';
import { caretSelection, rangeSelection, selectionStore } from '../../src/renderer/editor/selection-state';
import { rangeEdges } from '../../src/renderer/editor/selection-overlay';
import { beatHit, centerOf, syntheticHitMap } from './selection-fixture';
import { openFixture, services } from './shell-harness';

/** Browser audio hardware boundary. Musical projection and transport are real. */
class Parameter {
  value = 1;
  setTargetAtTime(value: number): void { this.value = value; }
}
class Node {
  readonly gain = new Parameter(); readonly pan = new Parameter();
  readonly threshold = new Parameter(); readonly knee = new Parameter(); readonly ratio = new Parameter();
  readonly attack = new Parameter(); readonly release = new Parameter();
  connect(): void {}
  disconnect(): void {}
}
class AudioClock {
  readonly currentTime = 0; readonly destination = new Node();
  createGain(): Node { return new Node(); }
  createStereoPanner(): Node { return new Node(); }
  createDynamicsCompressor(): Node { return new Node(); }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}
class Driver implements PlaybackDriver {
  position: PlaybackPosition;
  clock: LoopClock;
  playing = false;
  constructor(build: PlaybackBuild) { this.clock = new LoopClock(build, 1); this.position = this.clock.position(0, false); }
  start(tick: number): void { this.playing = true; this.position = this.clock.position(this.clock.seconds(tick), false); }
  reset(tick: number): void { this.playing = false; this.position = this.clock.position(this.clock.seconds(tick), false); }
  async replace(build: PlaybackBuild): Promise<number> {
    this.clock = new LoopClock(build, 1); this.position = this.clock.position(0, false); return 0;
  }
  subscribe(): () => void { return () => {}; }
  destroy(): void { this.playing = false; }
}
const disposers: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('AudioContext', AudioClock);
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array()));
  Object.defineProperty(window, 'desktop', { configurable: true, value: {} });
  vi.spyOn(RangeSynth.prototype, 'create').mockImplementation(async build => new Driver(build));
});
afterEach(() => {
  cleanup(); for (const dispose of disposers.splice(0)) dispose();
  selectionStore.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function setup() {
  const context = services();
  const project = await openFixture(context.documents, 'loop-eight-bars', 'Loop test');
  const runtime = transportRuntime(context);
  disposers.push(runtime.bind(() => {}));
  disposers.push(bindCommandKeys(context.registry, { target: document, platform: 'mac',
    state: () => ({ playing: runtime.transport.getSnapshot().status === 'playing', dialog: false }) }));
  const map = syntheticHitMap(project.score, 1);
  const pointer = new PointerController({
    hitMap: () => map, generation: () => 1,
    rangeEdges: () => rangeEdges(selectionStore.getSnapshot().selection, map),
    onGesture: gesture => {
      switch (gesture.kind) {
        case 'range':
          selectionStore.set(rangeSelection(project.score, gesture.anchor, gesture.focus));
          selectionStore.setDragging(gesture.phase === 'drag'); break;
        case 'caret': selectionStore.set(caretSelection(project.score, gesture.hit)); break;
        case 'track': case 'cancelled': case 'rejected': break;
        default: { const exhaustive: never = gesture; return exhaustive; }
      }
    },
  });
  const drag = (from: string, to: string, handle?: 'start' | 'end') => {
    pointer.down({ ...centerOf(map, from), clicks: 1, ...(handle ? { handle } : {}) });
    pointer.move(centerOf(map, to)); pointer.up(centerOf(map, to));
  };
  return { context, runtime, map, pointer, drag };
}

describe('drag passage transport wiring', () => {
  it.each([
    ['m2b2', 'm3b3', 5, 11], ['m3b3', 'm2b2', 5, 11], ['m4b3', 'm5b2', 14, 18],
  ] as const)('Space starts the exact %s to %s passage', async (from, to, start, end) => {
    const { runtime, drag } = await setup();
    drag(from, to); await runtime.toggleLoop(); await runtime.play();
    expect(runtime.loop.range).toEqual({ startQ: { n: String(start), d: '1' }, endQ: { n: String(end), d: '1' } });
    expect(runtime.transport.build?.projection.occurrences.reduce((sum, visit) => sum + Number(visit.spanQ.n) / Number(visit.spanQ.d), 0)).toBe(end - start);
    expect(runtime.transport.getSnapshot().tick).toBe(0);
  });
  it('commits handle resize only at pointer-up and cancels the old projection', async () => {
    const { runtime, drag, pointer, map } = await setup();
    drag('m2b2', 'm3b3'); await runtime.toggleLoop(); await runtime.play();
    const generation = runtime.transport.getSnapshot().generation;
    pointer.down({ ...centerOf(map, 'm3b3'), clicks: 1, handle: 'end' });
    pointer.move(centerOf(map, 'm4b1')); await Promise.resolve();
    expect(runtime.transport.getSnapshot().generation).toBe(generation);
    pointer.up(centerOf(map, 'm4b1'));
    await vi.waitFor(() => expect(runtime.transport.getSnapshot().generation).toBeGreaterThan(generation));
    expect(runtime.transport.getSnapshot().status).toBe('playing');
    expect(runtime.loop.range).toEqual({ startQ: { n: '5', d: '1' }, endQ: { n: '13', d: '1' } });
    expect(runtime.transport.getSnapshot().generation).toBeGreaterThan(generation);
    expect(RangeSynth.prototype.create).toHaveBeenCalledTimes(1);
  });
  it('replaces an active range while an outside caret seek stays clamped', async () => {
    const { runtime, drag, map } = await setup();
    drag('m2b2', 'm3b3'); await runtime.toggleLoop(); await runtime.play();
    runtime.seekWritten(beatHit(map, 'm1b1').startQ);
    expect(runtime.transport.getSnapshot().tick).toBe(0);
    drag('m4b3', 'm5b2');
    await vi.waitFor(() => expect(runtime.loop.range?.startQ.n).toBe('14'));
    expect(runtime.loop.range?.endQ.n).toBe('18');
  });
  it.each(['playing', 'paused'] as const)('disabling loop while %s preserves selection and the stop origin', async status => {
    const { runtime, drag } = await setup();
    drag('m2b2', 'm3b3'); await runtime.toggleLoop(); await runtime.play();
    runtime.transport.seek(1920); const selection = selectionStore.getSnapshot().selection;
    if (status === 'paused') await runtime.play();
    await runtime.toggleLoop();
    expect([runtime.loop.enabled, runtime.transport.getSnapshot().status, runtime.transport.getSnapshot().tick]).toEqual([false, status, 7 * 960]);
    expect(selectionStore.getSnapshot().selection).toBe(selection);
    runtime.stop();
    expect(runtime.transport.getSnapshot()).toMatchObject({ status: 'stopped', tick: 5 * 960 });
  });
  it('pause retains position and Stop returns to range start', async () => {
    const { runtime, drag } = await setup();
    drag('m2b2', 'm3b3'); await runtime.toggleLoop(); await runtime.play();
    runtime.transport.seek(2880); await runtime.play();
    expect(runtime.transport.getSnapshot()).toMatchObject({ status: 'paused', tick: 2880 });
    await runtime.play(); runtime.stop();
    expect(runtime.transport.getSnapshot()).toMatchObject({ status: 'stopped', tick: 0 });
    expect(runtime.loop.range?.startQ.n).toBe('5');
  });
  it('plays only a range that was dragged while paused, and the whole score again after a click releases it', async () => {
    const { runtime, map, drag } = await setup();
    const score = runtime.services.documents.getSnapshot().active?.project.score;
    if (!score) throw new RangeError('Missing fixture score');
    await runtime.play(); await runtime.play();
    expect(runtime.transport.getSnapshot().status).toBe('paused');
    drag('m2b2', 'm3b3'); await runtime.play();
    expect(runtime.transport.getSnapshot().status).toBe('playing');
    expect([runtime.loop.range?.startQ.n, runtime.loop.range?.endQ.n]).toEqual(['5', '11']);
    expect(runtime.transport.build?.projection.occurrences).toHaveLength(2);
    await runtime.play();
    selectionStore.set(caretSelection(score, beatHit(map, 'm5b1')));
    await runtime.play();
    expect(runtime.loop.range).toBeNull();
    expect(runtime.transport.build?.projection.occurrences).toHaveLength(8);
  });
  it('no selection loops the whole arrangement and Stop remembers the starting caret', async () => {
    const { runtime, map } = await setup();
    const score = runtime.services.documents.getSnapshot().active?.project.score;
    if (!score) throw new RangeError('Missing fixture score');
    selectionStore.set(caretSelection(score, beatHit(map, 'm2b2')));
    await runtime.toggleLoop(); await runtime.play(); runtime.transport.seek(12000); runtime.stop();
    expect(runtime.transport.getSnapshot().tick).toBe(4800);
    expect(runtime.loop.range).toBeNull();
    expect(runtime.transport.build?.projection.occurrences).toHaveLength(8);
  });
  it('F9, toolbar, and menu execute the same state, and 50% retains the selected range', async () => {
    const { context, runtime, drag } = await setup();
    render(<ServicesContext.Provider value={context}><TooltipProvider><LoopSpeed /></TooltipProvider></ServicesContext.Provider>);
    fireEvent.keyDown(document, { key: 'F9' });
    expect(screen.getByRole('button', { name: '구간 반복' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '구간 반복' }));
    expect(runtime.loop.enabled).toBe(false);
    act(() => { context.registry.execute('sound.loop', 'editing'); });
    expect(runtime.loop.enabled).toBe(true);
    drag('m2b2', 'm3b3'); await runtime.play(); await runtime.setLoopRate(50);
    expect(runtime.loop.rate).toBe(0.5);
    const build = runtime.transport.build;
    if (!build) throw new RangeError('Missing playback projection');
    expect(new LoopClock(build, runtime.loop.rate).duration).toBe(6);
  });
});
