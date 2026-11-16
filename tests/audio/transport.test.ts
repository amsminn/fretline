import { describe, expect, it } from 'vitest';
import { midi } from '@coderline/alphatab/core';
import { PlaybackTransport, buildPlayback } from '../../src/renderer/audio/transport';
import type { PlaybackDriver, PlaybackPosition } from '../../src/renderer/audio/transport';
import { fixtureDocument } from '../domain/fixtures';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qaEvidenceEnabled, writeQaEvidence } from '../../src/main/qa-evidence';
import { Practice } from '../../src/renderer/audio/practice';
import { rationalQ } from '../../src/domain/rational';

/** An output boundary: transport owns lifecycle; the driver owns the audio clock and controller reset. */
class Driver implements PlaybackDriver {
  position: PlaybackPosition = { tick: 0, seconds: 0, total: 16, bpm: 120 };
  playing = false;
  disposed = false;
  released = false;
  held = new Set<number>();
  controllers = new Map<number, number>();
  listener: (position: PlaybackPosition) => void = () => {};
  start(tick: number): void { this.reset(tick); this.playing = true; }
  reset(tick: number): void {
    this.playing = false; this.held.clear(); this.controllers.clear();
    this.position = { ...this.position, tick, seconds: tick / 1920 };
    this.listener(this.position);
  }
  subscribe(listener: (position: PlaybackPosition) => void): () => void { this.listener = listener; return () => { this.listener = () => {}; }; }
  destroy(release = false): void { this.reset(this.position.tick); this.disposed = true; this.released = release; }
}

describe('transport snapshot lifecycle', () => {
  it('keeps the active driver sounding during replacement preparation and never rebuilds its factory', async () => {
    const prepared = Promise.withResolvers<number>();
    class PreparedDriver extends Driver {
      async replace(): Promise<number> { return prepared.promise; }
    }
    const driver = new PreparedDriver();
    let creations = 0;
    const transport = new PlaybackTransport(async () => { creations++; return driver; });
    transport.setDocument(fixtureDocument('loop-eight-bars'), 1);
    await transport.play();
    const previous = transport.build;
    const replacing = transport.replaceTraversal({ followRepeats: false, range: { startQ: rationalQ(14n), endQ: rationalQ(18n) } });
    expect(driver.playing).toBe(true);
    expect(transport.getSnapshot().status).toBe('playing');
    expect(transport.build).toBe(previous);
    prepared.resolve(5120); await replacing;
    expect(creations).toBe(1);
    expect(driver.disposed).toBe(false);
    transport.destroy();
  });
  it('does not revive a stopped transport when prepared replacement finishes', async () => {
    const prepared = Promise.withResolvers<number>();
    class PreparedDriver extends Driver {
      async replace(): Promise<number> { return prepared.promise; }
    }
    const driver = new PreparedDriver();
    const transport = new PlaybackTransport(async () => driver);
    transport.setDocument(fixtureDocument('loop-eight-bars'), 1);
    await transport.play();
    const replacing = transport.replaceTraversal({ followRepeats: false, range: { startQ: rationalQ(5n), endQ: rationalQ(11n) } });
    transport.stop();
    prepared.resolve(5120); await replacing;
    expect([driver.playing, driver.disposed, transport.getSnapshot().status]).toEqual([false, true, 'stopped']);
    transport.destroy();
  });
  it.each(['seek', 'stop'] as const)('%s resets practice completion through the transport lifecycle', async action => {
    const practice = new Practice();
    const transport = new PlaybackTransport(async () => new Driver(), {
      reset: reason => practice.reset(reason), beforeStart: () => undefined, pause: () => practice.cancel(),
    });
    transport.setDocument(fixtureDocument('loop-eight-bars'), 1);
    await transport.play();
    practice.completeCycle({ cycle: 1, audioTime: 0 }); practice.advance(0);
    switch (action) {
      case 'seek': transport.seek(960); break;
      case 'stop': transport.stop(); break;
      default: { const exhaustive: never = action; throw new RangeError(String(exhaustive)); }
    }
    expect(practice.getSnapshot().completed).toBe(0);
    transport.destroy();
  });
  it('discards a late build after a newer revision has become active', async () => {
    const old = Promise.withResolvers<PlaybackDriver>();
    const drivers = [old.promise, Promise.resolve(new Driver())];
    const transport = new PlaybackTransport(() => {
      const next = drivers.shift();
      if (!next) throw new RangeError('Unexpected build');
      return next;
    });
    const doc = fixtureDocument('loop-eight-bars');
    transport.setDocument(doc, 1);
    const pending = transport.play();
    transport.setDocument({ ...doc, metadata: { ...doc.metadata, title: 'Edited' } }, 2);
    await transport.play();
    const stale = new Driver();
    old.resolve(stale);
    await pending;
    expect(stale.disposed).toBe(true);
    expect(transport.getSnapshot()).toMatchObject({ revision: 2, status: 'playing' });
    transport.destroy();
  });
  it('stop during preparation prevents a later build from sounding', async () => {
    const build = Promise.withResolvers<PlaybackDriver>();
    const transport = new PlaybackTransport(() => build.promise);
    transport.setDocument(fixtureDocument('loop-eight-bars'), 1);
    const pending = transport.play();
    transport.stop();
    const driver = new Driver();
    build.resolve(driver);
    await pending;
    expect([driver.playing, driver.disposed, transport.getSnapshot().status]).toEqual([false, true, 'stopped']);
    transport.destroy();
  });
  it('starts the latest revision after stale and stopped preparations settle', async () => {
    const staleBuild = Promise.withResolvers<PlaybackDriver>();
    const stoppedBuild = Promise.withResolvers<PlaybackDriver>();
    const replay = new Driver();
    const drivers = [staleBuild.promise, stoppedBuild.promise, Promise.resolve(replay)];
    const transport = new PlaybackTransport(() => {
      const next = drivers.shift();
      if (!next) throw new RangeError('Unexpected build');
      return next;
    });
    const document = fixtureDocument('loop-eight-bars');
    transport.setDocument(document, 1);
    const stalePlay = transport.play();
    transport.setDocument({ ...document, metadata: { ...document.metadata, title: 'Latest' } }, 2);
    const stoppedPlay = transport.play();
    transport.stop();
    const stale = new Driver();
    const stopped = new Driver();
    staleBuild.resolve(stale);
    stoppedBuild.resolve(stopped);
    await Promise.all([stalePlay, stoppedPlay]);
    expect([stale.disposed, stopped.disposed, transport.getSnapshot().status]).toEqual([true, true, 'stopped']);
    await transport.play();
    expect([replay.playing, transport.getSnapshot().revision, transport.getSnapshot().status]).toEqual([true, 2, 'playing']);
    transport.destroy();
  });
  it('pause preserves position, resume starts there, and stop returns to the starting cursor', async () => {
    const driver = new Driver();
    const transport = new PlaybackTransport(async () => driver);
    transport.setDocument(fixtureDocument('loop-eight-bars'), 1);
    await transport.play(960);
    driver.position = { ...driver.position, tick: 2880, seconds: 1.5 };
    driver.listener(driver.position);
    driver.held.add(64); driver.controllers.set(64, 127);
    transport.pause();
    expect([driver.held.size, driver.controllers.size, transport.getSnapshot().tick]).toEqual([0, 0, 2880]);
    await transport.play();
    expect([driver.playing, driver.position.tick]).toEqual([true, 2880]);
    driver.held.add(67); driver.controllers.set(64, 127);
    transport.seek(4800);
    expect([driver.held.size, driver.controllers.size, driver.position.tick, driver.playing]).toEqual([0, 0, 4800, true]);
    transport.stop();
    expect([driver.playing, driver.position.tick, transport.getSnapshot().tick]).toEqual([false, 960, 960]);
    expect(driver.disposed).toBe(true);
    transport.destroy();
  });
  it('rapid authoring revisions release one active build and never create intermediate playback builds', async () => {
    const driver = new Driver();
    let builds = 0;
    const transport = new PlaybackTransport(async () => { builds++; return driver; });
    const doc = fixtureDocument('loop-eight-bars');
    transport.setDocument(doc, 4);
    await transport.play();
    for (let revision = 5; revision <= 8; revision++) transport.setDocument({ ...doc }, revision);
    expect([builds, driver.playing, driver.disposed, driver.released, transport.getSnapshot().revision,
      transport.getSnapshot().status]).toEqual([1, false, true, true, 8, 'stopped']);
    transport.destroy();
  });
});

describe('linearized playback', () => {
  it('keeps initial MIDI gain and pan neutral so the live mixer applies authored values once', () => {
    const base = fixtureDocument('loop-eight-bars');
    const document = { ...base, tracks: base.tracks.map(track => ({ ...track,
      mixer: { volume: 0.25, pan: 0.75, mute: false, solo: false, equalizer: [] },
    })) };
    const built = buildPlayback(document);
    const controls = built.file.events.filter((event): event is midi.ControlChangeEvent =>
      event instanceof midi.ControlChangeEvent && event.track === 0 && event.tick === 0);
    expect(controls.find(event => event.controller === 7)?.value).toBe(127);
    expect(controls.find(event => event.controller === 10)?.value).toBe(64);
  });
  it('generates audible note attacks in the domain alternate-ending order only once', () => {
    const doc = fixtureDocument('alternate-endings');
    const built = buildPlayback(doc);
    const expected = [1, 2, 3, 1, 2, 4, 5];
    expect(built.projection.occurrences.map(o => doc.measures.findIndex(m => m.id === o.measureId) + 1)).toEqual(expected);
    expect(built.projection.score.masterBars.every(bar => !bar.isRepeatStart && bar.repeatCount === 0)).toBe(true);
    const attacks = built.file.events.filter(event => event instanceof midi.NoteOnEvent);
    expect(attacks.length).toBe(28);
    expect(attacks.map(event => Math.floor(event.tick / 3840) + 1)).toEqual(expected.flatMap((_, i) => [i + 1, i + 1, i + 1, i + 1]));
  });
});

it('QA evidence writes are gated, bounded by kind and cannot follow a planted symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'transport-evidence-'));
  const previousFlag = process.env['FRETLINE_QA'];
  const previousRoot = process.env['FRETLINE_QA_EVIDENCE'];
  try {
    process.env['FRETLINE_QA'] = '0';
    process.env['FRETLINE_QA_EVIDENCE'] = directory;
    expect(qaEvidenceEnabled()).toBe(false);
    await expect(writeQaEvidence('attacks', new Uint8Array([1]))).rejects.toThrow('unavailable');
    process.env['FRETLINE_QA'] = '1';
    await writeQaEvidence('attacks', new TextEncoder().encode('{"attacks":[]}'));
    expect(await readFile(join(directory, 'attacks.json'), 'utf8')).toBe('{"attacks":[]}');
    await expect(writeQaEvidence('../escape', new Uint8Array([1]))).rejects.toThrow('kind');
    await expect(writeQaEvidence('audio', 'not bytes')).rejects.toThrow('bytes');
    const protectedFile = join(directory, 'protected.txt');
    await writeFile(protectedFile, 'unchanged');
    await symlink(protectedFile, join(directory, 'playback.wav'));
    await expect(writeQaEvidence('audio', new Uint8Array([1]))).rejects.toThrow();
    expect(await readFile(protectedFile, 'utf8')).toBe('unchanged');
  } finally {
    if (previousFlag === undefined) delete process.env['FRETLINE_QA']; else process.env['FRETLINE_QA'] = previousFlag;
    if (previousRoot === undefined) delete process.env['FRETLINE_QA_EVIDENCE']; else process.env['FRETLINE_QA_EVIDENCE'] = previousRoot;
    await rm(directory, { recursive: true });
  }
});
