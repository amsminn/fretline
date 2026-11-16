import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeScorePaint, percentile } from '../../script/qa/cases/electron/perf-paint';
import { ProjectionGeneration, projectRequest, receiveProjection } from '../../src/workers/project';
import { fixtureDocument } from '../domain/fixtures';

describe('render edit measurement', () => {
  let now = 0;
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    now = 0;
    frames = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    document.body.innerHTML = '<div data-testid="score-view" data-generation="1" aria-busy="false">' +
      '<div data-testid="score-engine"><svg><text>1</text></svg></div></div>';
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });
  function frame(at: number): void {
    now = at;
    const callbacks = frames;
    frames = [];
    for (const callback of callbacks) callback(at);
  }
  function engine(): Element {
    const element = document.querySelector('[data-testid="score-engine"]');
    if (!element) throw new TypeError('Missing score engine');
    return element;
  }
  function bounds(width: number, height: number): void {
    const svg = engine().querySelector('svg');
    if (!svg) throw new TypeError('Missing SVG');
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, height));
  }
  function generation(value: number): void {
    document.querySelector('[data-testid="score-view"]')?.setAttribute('data-generation', String(value));
  }

  it('waits for changed engraving, fresh generation, layout bounds and a subsequent frame', async () => {
    const { result: promise } = observeScorePaint({ previousGeneration: 1, previousSvg: engine().innerHTML, timeoutMs: 1000 });
    let complete = false;
    void promise.then(() => { complete = true; });
    generation(2);
    bounds(120, 80);
    frame(10);
    await Promise.resolve();
    expect(complete).toBe(false);
    engine().innerHTML = '<svg><text>2</text></svg>';
    bounds(0, 0);
    frame(20);
    await Promise.resolve();
    expect(complete).toBe(false);
    bounds(120, 80);
    frame(30);
    await Promise.resolve();
    expect(complete).toBe(false);
    frame(46);
    expect(await promise).toEqual({ kind: 'painted', elapsedMs: 46, generation: 2, width: 120, height: 80 });
  });

  it('does not accept changed SVG with a stale semantic bounds generation', async () => {
    const { result: promise } = observeScorePaint({ previousGeneration: 1, previousSvg: engine().innerHTML, timeoutMs: 100 });
    engine().innerHTML = '<svg><text>2</text></svg>';
    bounds(120, 80);
    frame(20);
    frame(40);
    frame(100);
    expect(await promise).toEqual({ kind: 'timeout', elapsedMs: 100 });
  });

  it('restarts the frame boundary when engraving changes again before paint', async () => {
    const { result: promise } = observeScorePaint({ previousGeneration: 1, previousSvg: engine().innerHTML, timeoutMs: 100 });
    generation(2);
    engine().innerHTML = '<svg><text>2</text></svg>';
    bounds(120, 80);
    frame(10);
    generation(3);
    engine().innerHTML = '<svg><text>3</text></svg>';
    bounds(120, 80);
    frame(20);
    frame(36);
    expect(await promise).toEqual({ kind: 'painted', elapsedMs: 36, generation: 3, width: 120, height: 80 });
  });

  it('uses nearest rank p50 and p95 over all twenty edit samples', () => {
    const samples = Array.from({ length: 20 }, (_, index) => 20 - index);
    expect([percentile(samples, 0.5), percentile(samples, 0.95)]).toEqual([10, 19]);
    expect(samples[0]).toBe(20);
  });

  it.each([{ samples: [] }, { samples: [NaN] }, { samples: [-1] }])('rejects invalid latency sample sets $samples', ({ samples }) => {
    expect(() => percentile(samples, 0.95)).toThrow(RangeError);
  });
});

it('transfers projection buffers without losing Unicode metadata or note identities', () => {
  const document = fixtureDocument('unison-strings');
  const title = '\uD3B8\uC9D1 \uD83C\uDFB8';
  const generation = new ProjectionGeneration();
  const reply = projectRequest({ version: 1, generation: generation.next(),
    document: { ...document, metadata: { ...document.metadata, title } } });
  if (reply.kind !== 'projected') throw new TypeError(reply.message);
  const transferred = structuredClone(reply, { transfer: [reply.scoreBytes.buffer, reply.settingsBytes.buffer] });
  expect([reply.scoreBytes.byteLength, reply.settingsBytes.byteLength]).toEqual([0, 0]);
  const projection = receiveProjection(transferred, generation);
  expect(projection?.score.title).toBe(title);
  expect([...projection?.identity.notes.keys() ?? []]).toEqual(document.tracks.flatMap(track => track.staves.flatMap(staff =>
    staff.voices.flatMap(voice => voice.bars.flatMap(bar => bar.kind === 'active' ? bar.events.flatMap(event =>
      event.kind === 'noteGroup' ? event.notes.map(note => note.id) : []) : [])))));
});
