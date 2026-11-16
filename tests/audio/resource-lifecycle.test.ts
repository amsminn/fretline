import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { synth } from '@coderline/alphatab/core';
import { RangeSynth } from '../../src/renderer/audio/loop-range';
import { MasterBus } from '../../src/renderer/audio/master-bus';
import { AudioMixer } from '../../src/renderer/audio/mixer';
import { QaRecorder } from '../../src/renderer/audio/qa-recorder';
import { PlaybackTransport } from '../../src/renderer/audio/transport';
import { MixerStore } from '../../src/renderer/state/mixer';
import { fixtureDocument } from '../domain/fixtures';
import { AudioEnvironment } from './audio-environment';
import { TransportRuntime } from '../../src/renderer/commands/transport';
import { CommandRegistry } from '../../src/renderer/commands/registry';
import { DocumentStore } from '../../src/renderer/state/documents';
import { WorkspaceStore } from '../../src/renderer/shell/workspace';
import { GlobalViewStore } from '../../src/renderer/global-view/store';
import { fixtureId } from '../domain/fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reuses one muted mixer graph for the same reopened document shape', async () => {
  const audio = new AudioEnvironment();
  audio.install();
  vi.stubGlobal('desktop', {});
  const master = new MasterBus();
  const mixer = new AudioMixer(master, new MixerStore());
  const document = fixtureDocument('loop-eight-bars');
  mixer.load(document);
  const created = audio.nodes;
  mixer.unload();
  mixer.load(document);
  expect(audio.nodes).toBe(created);
  mixer.unload();
  mixer.load({ ...document, tracks: document.tracks.slice(0, 1) });
  expect(audio.nodes).toBeGreaterThan(created);
  mixer.destroy();
  await master.destroy();
});

it.each([
  ['production', {}],
  ['QA recorder', { qa: { writeEvidence: async () => {} } }],
] as const)('keeps the prepared audio graph warm across stopped edits and document switches: %s', async (_label, desktop) => {
  const audio = new AudioEnvironment();
  audio.install();
  vi.stubGlobal('desktop', desktop);
  const font = new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2'));
  let fetches = 0;
  vi.stubGlobal('fetch', async () => { fetches++; return new Response(font); });
  const documents = new DocumentStore();
  const project = { schemaVersion: 1 as const, projectId: fixtureId('project', 'audio-restart'),
    score: fixtureDocument('loop-eight-bars'), assets: [], source: null, preservation: [] };
  await documents.open({ kind: 'opened', documentToken: fixtureId('document-capability', 'audio-restart'), project, assets: [],
    receipt: { revision: 0, contentHash: 'a'.repeat(64), projectId: project.projectId } },
  { createProject: async () => fixtureId('document-capability', 'unused'), readAsset: async () => new Uint8Array() });
  const runtime = new TransportRuntime({ documents, registry: new CommandRegistry(), platform: 'mac',
    workspace: new WorkspaceStore(), mixer: new MixerStore(), globalView: new GlobalViewStore() });
  const unbind = runtime.bind(() => {});
  try {
    await runtime.play();
    runtime.stop();
    const master = runtime.master; const context = runtime.master?.context;
    documents.updateProject({ ...project, score: { ...project.score,
      metadata: { ...project.score.metadata, title: 'Edited' } } });
    await Promise.resolve(); await Promise.resolve();
    expect(runtime.transport.getSnapshot()).toMatchObject({ status: 'stopped', revision: 1 });
    expect([audio.contexts, runtime.master, runtime.master?.context, fetches]).toEqual([1, master, context, 1]);
    await runtime.play();
    expect([runtime.transport.getSnapshot().status, runtime.master, runtime.master?.context, fetches])
      .toEqual(['playing', master, context, 1]);
    const token = documents.getSnapshot().active?.documentToken;
    if (!token) throw new TypeError('Missing active document');
    runtime.stop();
    documents.close(token);
    expect([runtime.master, runtime.master?.context, fetches]).toEqual([master, context, 1]);
    if ('qa' in desktop) expect(window.fretlinePlaybackObservation?.().audioState).toBe('absent');
    await documents.open({ kind: 'opened', documentToken: fixtureId('document-capability', 'audio-restart-2'), project, assets: [],
      receipt: { revision: 0, contentHash: 'b'.repeat(64), projectId: project.projectId } },
    { createProject: async () => fixtureId('document-capability', 'unused'), readAsset: async () => new Uint8Array() });
    await runtime.play();
    expect([runtime.transport.getSnapshot().status, runtime.master, runtime.master?.context, fetches])
      .toEqual(['playing', master, context, 1]);
  } finally { unbind(); }
  expect([audio.contexts, audio.worklets]).toEqual([0, 0]);
});

it('releases the active AlphaSynth generation once across rapid document revisions', async () => {
  const audio = new AudioEnvironment();
  audio.install();
  vi.stubGlobal('desktop', {});
  const font = new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2'));
  vi.stubGlobal('fetch', async () => new Response(font));
  const documents = new DocumentStore();
  const project = { schemaVersion: 1 as const, projectId: fixtureId('project', 'audio-rapid-revisions'),
    score: fixtureDocument('loop-eight-bars'), assets: [], source: null, preservation: [] };
  const voiceCount = project.score.tracks.length;
  await documents.open({ kind: 'opened', documentToken: fixtureId('document-capability', 'audio-rapid-revisions'), project, assets: [],
    receipt: { revision: 0, contentHash: 'a'.repeat(64), projectId: project.projectId } },
  { createProject: async () => fixtureId('document-capability', 'unused'), readAsset: async () => new Uint8Array() });
  const runtime = new TransportRuntime({ documents, registry: new CommandRegistry(), platform: 'mac',
    workspace: new WorkspaceStore(), mixer: new MixerStore(), globalView: new GlobalViewStore() });
  const unbind = runtime.bind(() => {});
  try {
    await runtime.play();
    expect(await runtime.audioDiagnostics()).toMatchObject({
      engine: { drivers: 1, alphaSynthInstances: voiceCount, alphaSynthCreated: voiceCount,
        alphaSynthActive: voiceCount, alphaSynthPooled: 0 },
    });
    for (const title of ['2', '23', '234', '2345']) {
      documents.updateProject({ ...project, score: { ...project.score, metadata: { ...project.score.metadata, title } } });
    }
    expect(await runtime.audioDiagnostics()).toMatchObject({
      engine: { drivers: 0, alphaSynthInstances: 0, alphaSynthCreated: voiceCount, alphaSynthActive: 0, alphaSynthPooled: 0 },
    });
    await runtime.play();
    expect(await runtime.audioDiagnostics()).toMatchObject({
      engine: { drivers: 1, alphaSynthInstances: voiceCount, alphaSynthCreated: voiceCount * 2,
        alphaSynthActive: voiceCount, alphaSynthPooled: 0 },
    });
  } finally { unbind(); }
  expect([audio.contexts, audio.worklets]).toEqual([0, 0]);
});

it('releases live synths and worklet ports across open play stop edit close cycles', async () => {
  const audio = new AudioEnvironment();
  audio.install();
  const live = new Set<synth.AlphaSynth>();
  const load = synth.AlphaSynth.prototype.loadSoundFont;
  const destroy = synth.AlphaSynth.prototype.destroy;
  vi.spyOn(synth.AlphaSynth.prototype, 'loadSoundFont').mockImplementation(function (this: synth.AlphaSynth, bytes, append) {
    live.add(this); load.call(this, bytes, append);
  });
  vi.spyOn(synth.AlphaSynth.prototype, 'destroy').mockImplementation(function (this: synth.AlphaSynth) {
    live.delete(this); destroy.call(this);
  });
  const font = new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2'));
  const range = new RangeSynth(font, () => ({ enabled: false, rate: 1 }));
  const document = fixtureDocument('loop-eight-bars');
  const counts: number[][] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    vi.stubGlobal('desktop', {
      qa: { writeEvidence: async () => {} },
    });
    const master = new MasterBus();
    const mixer = new AudioMixer(master, new MixerStore());
    mixer.load(document);
    const recorder = await QaRecorder.create(master, window.desktop);
    const transport = new PlaybackTransport(build => range.create(build, { mixer, recorder, revision: cycle }));
    try {
      transport.setDocument(document, cycle);
      counts.push([live.size, audio.worklets]);
      await transport.play();
      counts.push([live.size, audio.worklets]);
      transport.stop();
      counts.push([live.size, audio.worklets]);
      transport.setDocument({ ...document }, cycle + 1);
      await transport.play();
      transport.setDocument(null, 0);
      counts.push([live.size, audio.worklets]);
    } finally {
      transport.destroy(); recorder?.destroy(); mixer.destroy(); await master.destroy();
    }
    counts.push([live.size, audio.worklets, audio.contexts]);
  }
  range.destroy();
  expect(counts).toEqual([
    [0, 1], [3, 1], [3, 1], [0, 1], [0, 0, 0],
    [0, 1], [3, 1], [3, 1], [0, 1], [0, 0, 0],
    [0, 1], [3, 1], [3, 1], [0, 1], [0, 0, 0],
  ]);
  expect(live.size).toBe(0);
});

it('completes pending shared preparation without reviving stopped playback', async () => {
  const audio = new AudioEnvironment();
  audio.install();
  const active: boolean[] = [];
  vi.stubGlobal('desktop', { qa: { writeEvidence: async () => {} },
    setPlaybackActive: async (value: boolean) => { active.push(value); } });
  const requested = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const font = new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2'));
  vi.stubGlobal('fetch', () => { requested.resolve(); return response.promise; });
  const documents = new DocumentStore();
  const score = fixtureDocument('loop-eight-bars');
  const project = { schemaVersion: 1 as const, projectId: fixtureId('project', 'audio-cancel'),
    score, assets: [], source: null, preservation: [] };
  await documents.open({ kind: 'opened', documentToken: fixtureId('document-capability', 'audio-cancel'), project, assets: [],
    receipt: { revision: 0, contentHash: 'a'.repeat(64), projectId: project.projectId } },
  { createProject: async () => fixtureId('document-capability', 'unused'), readAsset: async () => new Uint8Array() });
  const runtime = new TransportRuntime({ documents, registry: new CommandRegistry(), platform: 'mac',
    workspace: new WorkspaceStore(), mixer: new MixerStore(), globalView: new GlobalViewStore() });
  const unbind = runtime.bind(() => {});
  try {
    expect([audio.contexts, audio.worklets]).toEqual([0, 0]);
    const pending = runtime.play();
    await requested.promise;
    expect(active).toEqual([true]);
    expect([audio.contexts, audio.worklets]).toEqual([1, 1]);
    const master = runtime.master;
    runtime.stop();
    expect(active).toEqual([true, false]);
    expect([audio.contexts, audio.worklets, runtime.master]).toEqual([1, 1, master]);
    response.resolve(new Response(font));
    await pending;
    expect(active).toEqual([true, false]);
    expect([audio.contexts, audio.worklets, runtime.master, runtime.transport.getSnapshot().status])
      .toEqual([1, 1, master, 'stopped']);
    await runtime.play();
    expect(active).toEqual([true, false, true]);
    expect([runtime.master, runtime.transport.getSnapshot().status]).toEqual([master, 'playing']);
  } finally { unbind(); }
});

it('disables renderer throttling only while playback is preparing or playing', async () => {
  const audio = new AudioEnvironment();
  audio.install();
  const active: boolean[] = [];
  vi.stubGlobal('desktop', { setPlaybackActive: async (value: boolean) => { active.push(value); } });
  const font = new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2'));
  vi.stubGlobal('fetch', async () => new Response(font));
  const documents = new DocumentStore();
  const project = { schemaVersion: 1 as const, projectId: fixtureId('project', 'playback-throttling'),
    score: fixtureDocument('loop-eight-bars'), assets: [], source: null, preservation: [] };
  await documents.open({ kind: 'opened', documentToken: fixtureId('document-capability', 'playback-throttling'), project, assets: [],
    receipt: { revision: 0, contentHash: 'a'.repeat(64), projectId: project.projectId } },
  { createProject: async () => fixtureId('document-capability', 'unused'), readAsset: async () => new Uint8Array() });
  const runtime = new TransportRuntime({ documents, registry: new CommandRegistry(), platform: 'mac',
    workspace: new WorkspaceStore(), mixer: new MixerStore(), globalView: new GlobalViewStore() });
  const unbind = runtime.bind(() => {});
  try {
    await runtime.play();
    await runtime.play();
    await runtime.play();
    runtime.stop();
    await runtime.play();
    const token = documents.getSnapshot().active?.documentToken;
    if (!token) throw new TypeError('Missing active document');
    documents.close(token);
    expect(active).toEqual([true, false, true, false, true, false]);
  } finally { unbind(); }
});

it('restores renderer throttling when playback preparation fails', async () => {
  const audio = new AudioEnvironment();
  audio.install();
  const active: boolean[] = [];
  vi.stubGlobal('desktop', { setPlaybackActive: async (value: boolean) => { active.push(value); } });
  vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }));
  const documents = new DocumentStore();
  const project = { schemaVersion: 1 as const, projectId: fixtureId('project', 'playback-throttling-error'),
    score: fixtureDocument('loop-eight-bars'), assets: [], source: null, preservation: [] };
  await documents.open({ kind: 'opened', documentToken: fixtureId('document-capability', 'playback-throttling-error'), project, assets: [],
    receipt: { revision: 0, contentHash: 'a'.repeat(64), projectId: project.projectId } },
  { createProject: async () => fixtureId('document-capability', 'unused'), readAsset: async () => new Uint8Array() });
  const runtime = new TransportRuntime({ documents, registry: new CommandRegistry(), platform: 'mac',
    workspace: new WorkspaceStore(), mixer: new MixerStore(), globalView: new GlobalViewStore() });
  const unbind = runtime.bind(() => {});
  try {
    await runtime.play();
    expect(runtime.transport.getSnapshot()).toMatchObject({ status: 'error', error: 'SoundFont unavailable (503)' });
    expect(active).toEqual([true, false]);
  } finally { unbind(); }
});
