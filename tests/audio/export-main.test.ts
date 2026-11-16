// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { AudioRenderRequest, AudioRenderWorkerBridge } from '../../src/preload/audio-render-contract';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { t } from '../../src/renderer/i18n';

vi.mock('../../src/workers/audio-export', () => ({
  buildOfflinePlayback: vi.fn(() => ({})), backingAudio: vi.fn(), renderOffline: vi.fn(),
}));
vi.mock('../../src/renderer/audio/transport', () => ({
  LoopClock: class { readonly duration = 1000; },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it.each(['ko', 'en'] as const)('reports the localized set limit in %s before rendering stems', async language => {
  const { setLanguage } = await import('../../src/renderer/i18n/language');
  setLanguage(language);
  const failure = Promise.withResolvers<string>();
  let start: Parameters<AudioRenderWorkerBridge['onStart']>[0] | undefined;
  const bridge: AudioRenderWorkerBridge = {
    onStart: listener => { start = listener; return () => {}; },
    write: vi.fn(), progress: vi.fn(), done: vi.fn(),
    failed: (_job, message) => { failure.resolve(message); return Promise.resolve(); },
  };
  vi.stubGlobal('window', { exportDesktop: bridge, addEventListener: vi.fn() });
  vi.stubGlobal('location', { href: 'app://fretline/export.html' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })));
  await import('../../src/renderer/export-main');
  const score = fixtureDocument('loop-eight-bars');
  const request: AudioRenderRequest = {
    documentToken: fixtureId('document-capability', 'limit'), mode: 'stems',
    parts: { project: { schemaVersion: 1, projectId: fixtureId('project', 'limit'), score,
      assets: [], source: null, preservation: [] }, blobs: [] },
    selection: null, compile: { followRepeats: false }, tempo: { rate: 1, fixedBpm: null },
    mixer: { tracks: [], master: { volume: 1 } },
    backing: { waveform: false, syncEnabled: false, gain: 1, mute: false }, mixed: false, suggestedName: 'Audio',
  };
  if (!start) throw new TypeError('Export worker did not register');
  start('limit-job', request);
  expect(await failure.promise).toBe(t('io.audio.stemLimit', undefined, language));
  expect(bridge.done).not.toHaveBeenCalled();
});
