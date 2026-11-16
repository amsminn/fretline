import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { midi } from '@coderline/alphatab/core';
import { SamplePull } from '../../src/renderer/audio/live-synth';
import { MixedEngine } from '../../src/renderer/audio/mixed-engine';
import { buildPlayback, LoopClock } from '../../src/renderer/audio/transport';
import { MasterBus } from '../../src/renderer/audio/master-bus';
import { AudioMixer } from '../../src/renderer/audio/mixer';
import { MixerStore } from '../../src/renderer/state/mixer';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { rationalQ } from '../../src/domain/rational';
import { AudioEnvironment } from './audio-environment';
import type { ScoreDocument } from '../../src/domain/document';
import { Practice } from '../../src/renderer/audio/practice';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function channelDocument(): ScoreDocument {
  const base = fixtureDocument('loop-eight-bars');
  const measure = base.measures[0]; const track = base.tracks[0];
  if (!measure || !track) throw new TypeError('Missing channel fixture template');
  return { ...base, measures: [measure], tracks: Array.from({ length: 16 }, (_, index) => ({
    ...track, id: fixtureId('track', `channel-${index}`),
    staves: track.staves.map((staff, staffIndex) => ({ ...staff, id: fixtureId('staff', `channel-${index}-${staffIndex}`),
      voices: staff.voices.map(voice => ({ ...voice, id: fixtureId('voice', `channel-${index}-${staffIndex}-${voice.number}`),
        bars: voice.bars.slice(0, 1).map(bar => {
          switch (bar.kind) {
            case 'inactive': return bar;
            case 'active': return { ...bar, events: bar.events.map((event, eventIndex) => {
              const label = `channel-${index}-${staffIndex}-${voice.number}-${eventIndex}`;
              switch (event.kind) {
                case 'rest': case 'spacer': return { ...event, id: fixtureId('event', label) };
                case 'noteGroup': return { ...event, id: fixtureId('event', label),
                  notes: event.notes.map((note, noteIndex) => ({ ...note, id: fixtureId('note', `${label}-${noteIndex}`) })) };
                default: { const invalid: never = event; throw new TypeError(String(invalid)); }
              }
            }) };
            default: { const invalid: never = bar; throw new TypeError(String(invalid)); }
          }
        }),
      })),
    })),
  })) };
}

describe('shared sample clock', () => {
  it('prepares backing while old PCM sounds, then retires synth, backing and clicks on the same frame', async () => {
    vi.useFakeTimers();
    const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
    const ports: { readonly messages: unknown[] }[] = [];
    class Port {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      readonly messages: unknown[] = [];
      postMessage(message: unknown): void {
        this.messages.push(message);
        if (Array.isArray(message) && typeof message[0] === 'number') {
          const reply = message[1] === 'latency' ? 0.04 : null;
          queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: [message[0], reply] })));
        }
      }
      close(): void {}
    }
    vi.stubGlobal('AudioWorkletNode', class {
      readonly port = new Port();
      constructor(readonly context: BaseAudioContext) {
        ports.push(this.port);
        queueMicrotask(() => this.port.onmessage?.(new MessageEvent('message', { data: ['ready'] })));
      }
      connect(): void {}
      disconnect(): void {}
    });
    const score = fixtureDocument('loop-eight-bars');
    const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(score);
    const practice = new Practice();
    practice.configure({ mode: 'relative', value: 100, trainer: null, countIn: false, audible: true, visual: true });
    const engine = new MixedEngine(new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2')),
      () => ({ enabled: true, rate: 1 }), practice);
    const requested = Promise.withResolvers<void>();
    const decoded = Promise.withResolvers<void>();
    let destroyedSources = 0;
    try {
      const driver = await engine.create(buildPlayback(score), { mixer, recorder: null, revision: 0,
        backing: { offsetSeconds: 0, source: {
          duration: 20,
          async read(start) {
            if (start >= 7) { requested.resolve(); await decoded.promise; }
            return [new Float32Array(24000), new Float32Array(24000)];
          },
          destroy() { destroyedSources++; },
        } },
      });
      driver.start(0);
      audio.time = 0.1;
      const old = [...audio.starts];
      const next = { ...buildPlayback(score, { followRepeats: false, range: { startQ: rationalQ(14n), endQ: rationalQ(18n) } }), mediaOffset: 7 };
      if (!driver.replace) throw new Error('Missing prepared range replacement');
      const replacing = driver.replace(next);
      await requested.promise;
      expect(old.every(node => node.stop === null)).toBe(true);
      expect(driver.build?.projection.occurrences[0]?.writtenStartQ).toEqual(rationalQ(0n));
      decoded.resolve();
      const frame = await replacing;
      const output = frame / 48000;
      expect(frame - 4800).toBeGreaterThanOrEqual(3600);
      expect(frame - 4800).toBeLessThan(3600 + 128);
      expect(old.every(node => node.stop === output)).toBe(true);
      expect(ports[0]?.messages).toContainEqual(expect.arrayContaining(['schedule', { output, active: false }]));
      const newStarts = audio.starts.slice(old.length);
      expect(newStarts.slice(0, 4).map(node => node.time)).toEqual([output, output, output, output]);
      expect(newStarts[0]?.channels).toHaveLength(1);
      audio.time = output; vi.advanceTimersByTime(8);
      expect(driver.build).toBe(next);
      driver.destroy(true);
      expect(destroyedSources).toBe(1);
    } finally { decoded.resolve(); engine.destroy(); mixer.destroy(); await master.destroy(); }
  });
  it.each([0.5, 1])('replaces a long loop on one frame, fading and cancelling every old lane at rate %s', async rate => {
    vi.useFakeTimers();
    const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
    const score = fixtureDocument('loop-eight-bars');
    const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(score);
    const practice = new Practice();
    practice.configure({ mode: 'relative', value: rate * 100, trainer: null, countIn: false, audible: true, visual: true });
    const engine = new MixedEngine(new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2')),
      () => ({ enabled: true, rate }), practice);
    try {
      const driver = await engine.create(buildPlayback(score), { mixer, recorder: null, revision: 0 });
      driver.start(0);
      audio.time = 0.1;
      audio.bufferPreparationSeconds = 0.01;
      const previous = [...audio.starts];
      const replacement = buildPlayback(score, { followRepeats: false, range: { startQ: rationalQ(14n), endQ: rationalQ(18n) } });
      if (!driver.replace) throw new Error('Active driver must support prepared range replacement');
      const frame = await driver.replace(replacement);
      const time = frame / 48000;
      expect(frame % 128).toBe(0);
      expect(frame - Math.round(audio.time * 48000)).toBeGreaterThanOrEqual(1680);
      expect(frame - Math.round(audio.time * 48000)).toBeLessThanOrEqual(1680 + 128);
      expect(previous.every(node => node.stop === time)).toBe(true);
      const next = audio.starts.slice(previous.length);
      expect(next.filter(node => node.channels.length === 2).slice(0, 3).map(node => node.time)).toEqual([time, time, time]);
      expect(audio.envelopes).toContainEqual({ kind: 'ramp', value: 0, time });
      expect(audio.envelopes.filter(event => event.kind === 'set' && event.value === 1 &&
        Math.abs(event.time - (time - 0.005)) < 1e-9)).toHaveLength(4);
      expect(audio.envelopes).toContainEqual({ kind: 'ramp', value: 1, time: time + 0.005 });
      audio.time = time;
      vi.advanceTimersByTime(8);
      expect(audio.disconnections).toHaveLength(0);
      for (const node of previous) node.finish();
      const acknowledged = audio.disconnections.length;
      vi.advanceTimersByTime(8);
      expect(audio.disconnections.length - acknowledged).toBe(3);
      expect(driver.position.tick).toBe(0);
      expect(driver.position.total).toBe(2 / rate);
      expect((await engine.qaDiagnostics()).alphaSynthCreated).toBe(3);
    } finally { engine.destroy(); mixer.destroy(); await master.destroy(); }
  });
  it('keeps the requested first tick when timer registration passes an uncommitted initial epoch', async () => {
    vi.useFakeTimers();
    const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
    const score = fixtureDocument('loop-eight-bars');
    const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(score);
    const engine = new MixedEngine(new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2')),
      () => ({ enabled: true, rate: 1 }));
    try {
      const driver = await engine.create(buildPlayback(score), { mixer, recorder: null, revision: 0 });
      const interval = globalThis.setInterval;
      vi.spyOn(globalThis, 'setInterval').mockImplementationOnce((handler, delay) => {
        audio.time = 0.05; return interval(handler, delay);
      });
      driver.start(0);
      expect(driver.position.buffering).toBe(true);
      expect(audio.starts).toEqual([]);
      expect(driver.position.tick).toBe(0);
    } finally { engine.destroy(); mixer.destroy(); await master.destroy(); }
  });
  it('keeps the primed first audio block playing when later lookahead preparation is slow', async () => {
    vi.useFakeTimers();
    const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
    const score = channelDocument();
    const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(score);
    const engine = new MixedEngine(new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2')),
      () => ({ enabled: false, rate: 1 }));
    const add = SamplePull.prototype.addSamples;
    let pulls = 0;
    vi.spyOn(SamplePull.prototype, 'addSamples').mockImplementation(function (this: SamplePull, samples) {
      if (++pulls === 17) audio.time += 0.2;
      add.call(this, samples);
    });
    try {
      const driver = await engine.create(buildPlayback(score), { mixer, recorder: null, revision: 0 });
      driver.start(0);
      expect(driver.position.buffering).toBe(false);
      const epoch = audio.starts[0]?.time;
      const audible = audio.starts.filter(buffer =>
        buffer.channels.some(channel => channel.some(sample => Math.abs(sample) > 0.001)));
      expect(audible.filter(buffer => buffer.time === epoch)).toHaveLength(16);
      expect(audible).toHaveLength(16);
    } finally { engine.destroy(); mixer.destroy(); await master.destroy(); }
  });
  it.each(['resume', 'cancel'] as const)('resumes or cancels an exhausted PCM queue: %s', async outcome => {
    vi.useFakeTimers();
    const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
    const score = fixtureDocument('loop-eight-bars');
    const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(score);
    const engine = new MixedEngine(new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2')),
      () => ({ enabled: true, rate: 1 }));
    try {
      const driver = await engine.create(buildPlayback(score), { mixer, recorder: null, revision: 0 });
      driver.start(0, 0.25);
      audio.time = 0.25; vi.advanceTimersByTime(8);
      const scheduled = audio.starts.length;
      audio.time = 2; vi.advanceTimersByTime(8);
      switch (outcome) {
        case 'resume': {
          await vi.advanceTimersToNextTimerAsync();
          const resumed = audio.starts.slice(scheduled);
          expect(resumed.slice(0, 3)).toHaveLength(3);
          for (const buffer of resumed.slice(0, 3)) expect(buffer.time).toBeCloseTo(2.005, 10);
          expect(resumed.every(buffer => buffer.time >= audio.time)).toBe(true);
          break;
        }
        case 'cancel':
          driver.destroy();
          expect(vi.getTimerCount()).toBe(0);
          expect(audio.starts).toHaveLength(scheduled);
          break;
        default: { const invalid: never = outcome; throw new TypeError(String(invalid)); }
      }
    } finally { engine.destroy(); mixer.destroy(); await master.destroy(); }
  });
  it('renders audible finite PCM for every track of the sixteen-track fixture', async () => {
    vi.useFakeTimers();
    const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
    const score = channelDocument();
    const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(score);
    const engine = new MixedEngine(new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2')),
      () => ({ enabled: false, rate: 1 }));
    try {
      const build = buildPlayback(score, { followRepeats: false, range: { startQ: rationalQ(0n), endQ: rationalQ(4n) } });
      const driver = await engine.create(build, { mixer, recorder: null, revision: 0 });
      expect(await engine.qaDiagnostics()).toMatchObject({
        drivers: 1, alphaSynthInstances: 16, alphaSynthCreated: 16, alphaSynthActive: 16, alphaSynthPooled: 0,
      });
      driver.start(0, 0.25); audio.time = 0.25; vi.advanceTimersByTime(8);
      const first = audio.starts.filter(buffer => buffer.time === 0.25);
      expect(first).toHaveLength(16);
      expect(first.map(buffer => ({
        finite: buffer.channels.every(channel => channel.every(Number.isFinite)),
        audible: buffer.channels.some(channel => channel.some(sample => Math.abs(sample) > 0.001)),
      }))).toEqual(Array.from({ length: 16 }, () => ({ finite: true, audible: true })));
      audio.time = 0.4; vi.advanceTimersByTime(8);
      expect(audio.starts).toHaveLength(32);
      driver.destroy();
      expect(await engine.qaDiagnostics()).toMatchObject({
        drivers: 0, alphaSynthInstances: 16, alphaSynthCreated: 16, alphaSynthActive: 0, alphaSynthPooled: 16,
      });
    } finally { engine.destroy(); mixer.destroy(); await master.destroy(); }
  });
  it('uses sync anchor intervals as the synth tempo and backing media origin', () => {
    const score = fixtureDocument('loop-eight-bars');
    const first = score.measures[0]; const third = score.measures[2];
    if (!first || !third) throw new TypeError('Missing sync fixture measures');
    const asset = { id: fixtureId('asset', 'clock-sync'), sha256: 'a'.repeat(64), byteLength: 44, mediaType: 'audio/wav' };
    const document: ScoreDocument = { ...score, assets: [asset], backing: { assetId: asset.id, offsetSeconds: 0,
      syncPoints: [
        { measureId: first.id, pass: 1, offsetQ: rationalQ(0n), mediaSeconds: 2 },
        { measureId: third.id, pass: 1, offsetQ: rationalQ(0n), mediaSeconds: 10 },
      ] } };
    const build = buildPlayback(document);
    const clock = new LoopClock(build, 1);
    expect(build.mediaOffset).toBe(2);
    expect(clock.seconds(8 * 960)).toBe(8);
    expect(clock.position(4, false).tick).toBe(4 * 960);
    expect(new LoopClock(build, 0.5).seconds(8 * 960)).toBe(16);
    const passage = { followRepeats: false, range: { startQ: rationalQ(5n), endQ: rationalQ(7n) } } as const;
    const clipped = buildPlayback(document, passage);
    expect(clipped.mediaOffset).toBe(7);
    expect(new LoopClock(clipped, 1).duration).toBe(2);
    const unanchored = buildPlayback({ ...document, backing: { assetId: asset.id, offsetSeconds: 0.25, syncPoints: [] } }, passage);
    expect(unanchored.mediaOffset).toBe(2.75);
  });
  it.each([0.5, 1, 1.5])('starts every live lane on one epoch and loops without drift at %s', async rate => {
    vi.useFakeTimers();
    const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
    const document = fixtureDocument('loop-eight-bars');
    const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(document);
    const engine = new MixedEngine(new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2')),
      () => ({ enabled: true, rate }));
    try {
      const build = buildPlayback(document, { followRepeats: false, range: { startQ: rationalQ(0n), endQ: rationalQ(1n) } });
      const driver = await engine.create(build, { mixer, recorder: null, revision: 0 });
      driver.start(0, 0.25);
      const duration = Math.round(new LoopClock(build, rate).duration * 48000) / 48000;
      while (audio.time < 0.25 + duration * 3) { audio.time += 0.008; vi.advanceTimersByTime(8); }
      for (let cycle = 0; cycle < 3; cycle++) {
        const start = 0.25 + cycle * duration;
        const lanes = audio.starts.filter(value => Math.abs(value.time - start) < 1e-9);
        expect(lanes).toHaveLength(3);
        expect(lanes.every(lane => lane.channels.some(channel => channel.some(sample => sample !== 0)))).toBe(true);
      }
      const count = audio.starts.length;
      driver.destroy(); audio.time += 1; vi.advanceTimersByTime(1000);
      expect(audio.starts).toHaveLength(count);
    } finally { engine.destroy(); mixer.destroy(); await master.destroy(); }
  });
  it('rejects an aborted generation before allocating any audio lanes', async () => {
    const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
    const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore());
    const controller = new AbortController(); controller.abort();
    const engine = new MixedEngine(new Uint8Array(), () => ({ enabled: false, rate: 1 }));
    await expect(engine.create(buildPlayback(fixtureDocument('loop-eight-bars')),
      { mixer, recorder: null, revision: 0 }, controller.signal)).rejects.toThrow();
    expect(audio.starts).toEqual([]);
    mixer.destroy(); await master.destroy();
  });
  it('isolates channel reuse after fifteen pitched tracks and reserves channel ten for percussion', async () => {
    const score = channelDocument();
    const passage = { followRepeats: false, range: { startQ: rationalQ(0n), endQ: rationalQ(4n) } } as const;
    // Existing projection allocates index modulo fifteen, skipping zero-based channel nine.
    const build = buildPlayback(score, passage);
    expect(build.projection.score.tracks.map(track => track.playbackInfo.primaryChannel))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 0]);
    const percussion = buildPlayback({ ...score, tracks: score.tracks.map((track, index) =>
      index === 0 ? { ...track, instrument: { kind: 'percussion', program: 0, bank: 128 },
        staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => ({ ...voice,
          bars: voice.bars.map(bar => {
            switch (bar.kind) {
              case 'inactive': return bar;
              case 'active': return { ...bar, events: bar.events.map(event => {
                switch (event.kind) {
                  case 'rest': case 'spacer': return event;
                  case 'noteGroup': return { ...event, notes: event.notes.map(note =>
                    ({ id: note.id, kind: 'percussion' as const, midi: 38, articulation: 'snare', techniques: [] })) };
                  default: { const invalid: never = event; throw new TypeError(String(invalid)); }
                }
              }) };
              default: { const invalid: never = bar; throw new TypeError(String(invalid)); }
            }
          }),
        })) })),
      } : track) }, passage);
    expect(percussion.projection.score.tracks[0]?.playbackInfo.primaryChannel).toBe(9);
    const lane = new LoopClock(build, 1).lane(15);
    const notes = lane.events.filter((event): event is midi.NoteOnEvent => event instanceof midi.NoteOnEvent);
    expect(notes.length).toBeGreaterThan(0);
    expect(new Set(notes.map(event => event.track))).toEqual(new Set([15]));
  // Decodes the 16-track perf project and renders real synth blocks; the bound is a hang guard, not a speed assertion.
  }, 60_000);
});
