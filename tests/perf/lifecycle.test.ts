import { afterEach, expect, it, vi } from 'vitest';
import { PlaybackTransport } from '../../src/renderer/audio/transport';
import type { PlaybackDriver } from '../../src/renderer/audio/transport';
import { PcmWindow } from '../../src/renderer/audio/pcm-cache';
import type { PcmChunk } from '../../src/renderer/audio/pcm-cache';
import { perfDocument } from '../domain/perf-fixture';
import { renderFrame } from '../../src/renderer/score/render-frame';
import { DocumentStore } from '../../src/renderer/state/documents';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import type { ProjectV1 } from '../../src/domain/project';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps stopped traversal available and releases the long projection when its document closes', async () => {
  const driver: PlaybackDriver = {
    position: { tick: 0, seconds: 0, total: 512, bpm: 120 },
    start() {}, reset() {}, subscribe: () => () => {}, destroy() {},
  };
  const transport = new PlaybackTransport(async () => driver);
  transport.setDocument(perfDocument(), 0);
  await transport.play();
  expect(transport.build?.projection.score.tracks).toHaveLength(16);

  transport.stop();
  expect(transport.build?.projection.occurrences).toHaveLength(256);
  transport.setDocument(null, 1);

  expect(transport.build).toBeNull();
  expect(transport.getSnapshot().status).toBe('stopped');
  transport.destroy();
});

it('settles pending PCM preparation when a closed source cannot answer its pull', async () => {
  const read = Promise.withResolvers<PcmChunk>();
  let alive = true;
  const window = new PcmWindow({ duration: 180, read: () => read.promise, destroy() { alive = false; } });
  const ready = window.ready(0);

  window.destroy();

  await ready;
  expect([alive, window.bytes]).toEqual([false, 0]);
});

it('refuses new PCM work after the source has been released', async () => {
  let reads = 0;
  let releases = 0;
  const window = new PcmWindow({ duration: 180, read: async () => {
    reads++;
    return [new Float32Array(24000), new Float32Array(24000)];
  }, destroy() { releases++; } });
  await window.ready(0);
  window.destroy();

  window.request(1);
  window.destroy();

  expect([reads, releases, window.bytes]).toEqual([1, 1, 0]);
});

it('retires decoded PCM when its prepared chunk is handed to the stretcher', async () => {
  const window = new PcmWindow({ duration: 180, read: async () =>
    [new Float32Array(24000).fill(0.25), new Float32Array(24000).fill(-0.25)], destroy() {} });
  await window.ready(0);

  const chunk = window.take(0);

  expect(chunk?.map(channel => channel[0])).toEqual([0.25, -0.25]);
  expect(window.bytes).toBe(0);
  window.destroy();
});

it('cancels obsolete score work before a pending display frame can run', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback); return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  const controller = new AbortController();
  const ready = renderFrame(controller.signal);

  controller.abort();

  expect(await ready).toBe(false);
  expect(frames.size).toBe(0);
  const next = renderFrame(new AbortController().signal);
  for (const callback of frames.values()) callback(16);
  expect(await next).toBe(true);
});

it.each(['replace', 'abort'] as const)('stops pulling a large document asset after %s cancels its open', async action => {
  const store = new DocumentStore();
  const firstRead = Promise.withResolvers<void>();
  const chunk = Promise.withResolvers<Uint8Array>();
  const controller = new AbortController();
  const asset = { id: fixtureId('asset', 'long-backing'), sha256: 'a'.repeat(64),
    mediaType: 'audio/wav', byteLength: 8 * 1024 ** 2 + 1 };
  const project: ProjectV1 = { schemaVersion: 1, projectId: fixtureId('project', 'pending-open'),
    score: fixtureDocument('loop-eight-bars'), assets: [asset], source: null, preservation: [] };
  let pulls = 0;
  const pending = store.open({ kind: 'opened', documentToken: fixtureId('document-capability', 'pending-open'), project,
    receipt: { projectId: project.projectId, revision: 0, contentHash: 'b'.repeat(64) },
    assets: [{ sha256: asset.sha256, assetToken: fixtureId('asset-capability', 'long-backing') }] },
  { createProject: async () => fixtureId('document-capability', 'unused'), readAsset: async () => {
    pulls++; firstRead.resolve(); return pulls === 1 ? chunk.promise : new Uint8Array([0]);
  } }, controller.signal);
  await firstRead.promise;

  switch (action) {
    case 'replace': await store.open({ kind: 'cancelled' }, {
      createProject: async () => fixtureId('document-capability', 'unused'), readAsset: async () => new Uint8Array(),
    }); break;
    case 'abort': controller.abort(); break;
    default: { const exhaustive: never = action; throw new TypeError(String(exhaustive)); }
  }
  chunk.resolve(new Uint8Array(8 * 1024 ** 2));
  await pending;

  expect(pulls).toBe(1);
  expect(store.getSnapshot().sessions).toHaveLength(0);
});

it('releases each import worker across twenty cancelled source opens', async () => {
  let created = 0;
  let active = 0;
  vi.stubGlobal('Worker', class {
    onmessage: Worker['onmessage'] = null;
    onerror: Worker['onerror'] = null;
    private alive = true;
    constructor() { created++; active++; }
    postMessage(): void {}
    terminate(): void { if (this.alive) { this.alive = false; active--; } }
  });
  const store = new DocumentStore();
  const bridge = { createProject: async () => fixtureId('document-capability', 'unused'), readAsset: async () => new Uint8Array() };

  for (let cycle = 0; cycle < 20; cycle++) {
    const pending = store.open({ kind: 'source', name: 'cancelled.gp5', bytes: new Uint8Array([1]) }, bridge);
    store.cancelImport();
    await pending;
  }

  expect([created, active]).toEqual([20, 0]);
  expect(store.getSnapshot()).toMatchObject({ pending: null, busy: false, sessions: [] });
});
