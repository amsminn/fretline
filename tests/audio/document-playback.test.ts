import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { ScoreDocument } from '../../src/domain/document';
import { rationalQ } from '../../src/domain/rational';
import { compileOccurrences } from '../../src/domain/timeline';
import { playbackCursor } from '../../src/renderer/audio/cursor';
import { MasterBus } from '../../src/renderer/audio/master-bus';
import { TransportRuntime } from '../../src/renderer/commands/transport';
import { CommandRegistry } from '../../src/renderer/commands/registry';
import { selectionStore } from '../../src/renderer/editor/selection-state';
import { GlobalViewStore } from '../../src/renderer/global-view/store';
import { WorkspaceStore } from '../../src/renderer/shell/workspace';
import { DocumentStore } from '../../src/renderer/state/documents';
import { MixerStore } from '../../src/renderer/state/mixer';
import { DocumentSessions } from '../../src/renderer/state/session';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { AudioEnvironment } from './audio-environment';

afterEach(() => { selectionStore.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function harness(audioEnabled = false) {
  const audio = new AudioEnvironment();
  if (audioEnabled) {
    audio.install(); vi.stubGlobal('desktop', {});
    const font = new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2'));
    vi.stubGlobal('fetch', async () => new Response(font));
  }
  const documents = new DocumentStore(); const mixer = new MixerStore();
  const services = { documents, mixer, registry: new CommandRegistry(), platform: 'mac' as const,
    workspace: new WorkspaceStore(), globalView: new GlobalViewStore() };
  const runtime = new TransportRuntime(services);
  const sessions = new DocumentSessions({ documents, mixer, loop: runtime.loop, onRestored: () => {} });
  const unbind = audioEnabled ? runtime.bind(() => {}) : () => {};
  async function open(label: string, score = fixtureDocument('loop-eight-bars')) {
    const token = fixtureId('document-capability', label);
    const project = { schemaVersion: 1 as const, projectId: fixtureId('project', label), score, assets: [], source: null, preservation: [] };
    await documents.open({ kind: 'opened', documentToken: token, project, assets: [],
      receipt: { revision: 0, contentHash: 'a'.repeat(64), projectId: project.projectId } },
    { createProject: async () => token, readAsset: async () => new Uint8Array() });
    // The shell loads authored controls whenever its active score changes.
    mixer.load(score);
    return token;
  }
  return { audio, documents, mixer, runtime, services, open, destroy: () => { unbind(); sessions.destroy(); } };
}

it('B4 keeps inactive solo tracks out of the active document mix after close', async () => {
  const h = await harness();
  try {
    const score = fixtureDocument('loop-eight-bars'); const solo = score.tracks[1];
    const sounding = score.tracks[0];
    if (!solo || !sounding) throw new TypeError('Missing tracks');
    const a = await h.open('A', score);
    h.mixer.setTrack(solo.id, { solo: true });
    await h.open('B', { ...score, tracks: [sounding] });
    expect(h.mixer.audible(sounding.id)).toBe(true);
    h.documents.close(a);
    expect([...h.mixer.getSnapshot().tracks.keys()]).toEqual([sounding.id]);
    expect(h.mixer.audible(sounding.id)).toBe(true);
  } finally { h.destroy(); }
});

it('B4 parks controls by session even when documents share track IDs and releases closed sessions', async () => {
  const h = await harness();
  try {
    const score = fixtureDocument('loop-eight-bars'); const track = score.tracks[0];
    if (!track) throw new TypeError('Missing track');
    const a = await h.open('A', score);
    h.mixer.setTrack(track.id, { solo: true, volume: 0.2, pan: -0.5 });
    const b = await h.open('B', score);
    expect(h.mixer.track(track.id)).toEqual({ solo: false, mute: false, volume: 0.8, pan: 0 });
    h.mixer.setTrack(track.id, { mute: true, volume: 0.6 });
    h.documents.activate(a); h.mixer.load(score);
    expect(h.mixer.track(track.id)).toEqual({ solo: true, mute: false, volume: 0.2, pan: -0.5 });
    h.documents.close(a);
    expect(h.mixer.track(track.id)).toEqual({ solo: false, mute: true, volume: 0.6, pan: 0 });
    h.documents.close(b);
    expect(h.mixer.getSnapshot().tracks.size).toBe(0);
    await h.open('A', score);
    expect(h.mixer.track(track.id)).toEqual({ solo: false, mute: false, volume: 0.8, pan: 0 });
  } finally { h.destroy(); }
});

it('B5 clears outgoing focus before the reused backend starts another document', async () => {
  const h = await harness(true);
  try {
    const score = fixtureDocument('loop-eight-bars'); const other = score.tracks[1]; const first = score.tracks[0];
    if (!first || !other) throw new TypeError('Missing tracks');
    await h.open('A', score);
    h.services.workspace.setActiveTrack(1);
    h.runtime.toggleFocus();
    await h.runtime.play(); h.runtime.stop();
    await h.open('B', { ...score, tracks: [first] });
    await h.runtime.play();
    expect(h.runtime.transport.getSnapshot().status).toBe('playing');
    expect(h.runtime.mixer?.audible(first.id)).toBe(true);
  } finally { h.destroy(); }
});

it('B5 restores the incoming authored master EQ before playback', async () => {
  const h = await harness(true);
  const setEq = vi.spyOn(MasterBus.prototype, 'setEqualizer');
  try {
    await h.open('A');
    h.runtime.setEqualizer(9);
    await h.runtime.play(); h.runtime.stop();
    const equalizer = [{ frequency: 700, q: 1.2, gainDb: -4 }];
    await h.open('B', { ...fixtureDocument('loop-eight-bars'), masterEqualizer: equalizer });
    await h.runtime.play();
    expect(setEq.mock.lastCall?.[0]).toEqual(equalizer);
  } finally { h.destroy(); }
});

it('B5 stops outgoing playback when two sessions share the same immutable score', async () => {
  const h = await harness(true);
  try {
    const score = fixtureDocument('loop-eight-bars');
    await h.open('A', score);
    h.runtime.setEqualizer(9);
    await h.runtime.play();
    await h.open('B', score);
    expect(h.runtime.transport.getSnapshot().status).toBe('stopped');
    await h.runtime.play();
    expect(h.runtime.transport.getSnapshot().status).toBe('playing');
  } finally { h.destroy(); }
});

it.each([false, true])('B6 starts on the caret bar in expanded time (qualified occurrence: %s)', async qualified => {
  const h = await harness(true);
  try {
    const base = fixtureDocument('loop-eight-bars');
    const score: ScoreDocument = { ...base, measures: base.measures.map((measure, index) =>
      ({ ...measure, repeats: index === 0 ? { start: true } : index === 1 ? { start: false, totalPlays: 2 } : { start: false } })) };
    await h.open('repeat', score);
    const visit = compileOccurrences(score, { followRepeats: true })[qualified ? 3 : 5];
    if (!visit) throw new TypeError('Missing visit');
    const point = { startQ: qualified ? rationalQ(4n) : rationalQ(12n), endQ: qualified ? rationalQ(5n) : rationalQ(13n),
      ...(qualified ? { occurrenceId: visit.occurrenceId } : {}) };
    selectionStore.set({ kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [] }, anchor: point, focus: point });
    await h.runtime.play();
    const state = h.runtime.transport.getSnapshot(); const build = h.runtime.transport.build;
    if (!build) throw new TypeError('Missing playback build');
    expect(state.tick).toBe((qualified ? 12 : 20) * 960);
    expect(playbackCursor(build, state.tick)?.writtenStartQ).toEqual(point.startQ);
    h.runtime.stop();
    expect(h.runtime.transport.getSnapshot().tick).toBe((qualified ? 12 : 20) * 960);
  } finally { h.destroy(); }
});
