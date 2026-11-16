import { afterEach, expect, it, vi } from 'vitest';
import { DisplayTransport } from '../../src/renderer/audio/display-transport';
import { PlaybackTransport } from '../../src/renderer/audio/transport';
import type { PlaybackDriver, PlaybackPosition } from '../../src/renderer/audio/transport';
import { fixtureDocument } from '../domain/fixtures';

afterEach(() => vi.unstubAllGlobals());

it('coalesces clock ticks to a display frame and publishes stop immediately', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback); return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  let clock: (position: PlaybackPosition) => void = () => {};
  const driver: PlaybackDriver = {
    position: { tick: 0, seconds: 0, total: 32, bpm: 120 },
    start: () => {}, reset: () => {}, destroy: () => {},
    subscribe: listener => { clock = listener; return () => { clock = () => {}; }; },
  };
  const transport = new PlaybackTransport(async () => driver);
  transport.setDocument(fixtureDocument('loop-eight-bars'), 1);
  const display = new DisplayTransport(transport);
  const observed: number[] = [];
  const unsubscribe = display.subscribe(() => observed.push(display.getSnapshot().tick));
  try {
    await transport.play();
    observed.length = 0;
    clock({ ...driver.position, tick: 100 });
    clock({ ...driver.position, tick: 200 });
    expect([observed, display.getSnapshot().tick, transport.getSnapshot().tick]).toEqual([[], 0, 200]);
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(16);
    expect(observed).toEqual([200]);
    clock({ ...driver.position, tick: 300 });
    transport.stop();
    expect(display.getSnapshot()).toMatchObject({ status: 'stopped', tick: 0 });
    expect(frames.size).toBe(0);
  } finally { unsubscribe(); transport.destroy(); }
});
