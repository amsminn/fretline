import { afterEach, expect, it, vi } from 'vitest';
import { MixedEngine } from '../../src/renderer/audio/mixed-engine';
import { AudioMixer } from '../../src/renderer/audio/mixer';
import { MasterBus } from '../../src/renderer/audio/master-bus';
import { PlaybackTransport } from '../../src/renderer/audio/transport';
import { MixerStore } from '../../src/renderer/state/mixer';
import { setLanguage } from '../../src/renderer/i18n/language';
import { localize } from '../../src/renderer/i18n';
import { buildOfflinePlayback, renderOffline } from '../../src/workers/audio-export';
import { fixtureDocument } from '../domain/fixtures';
import { AudioEnvironment } from './audio-environment';

afterEach(() => { setLanguage('ko'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const brokenFont = new TextEncoder().encode('not a SoundFont');

it.each([
  ['ko', '사운드폰트를 불러오지 못했습니다.'],
  ['en', 'Could not load the SoundFont.'],
] as const)('m3 reports a corrupt SoundFont as a transport error in %s without retaining failed voices', async (language, message) => {
  setLanguage(language);
  const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
  const base = fixtureDocument('loop-eight-bars');
  const score = { ...base, tracks: base.tracks.slice(0, 1) };
  const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(score);
  const engine = new MixedEngine(brokenFont, () => ({ enabled: false, rate: 1 }));
  const transport = new PlaybackTransport((build, signal) => engine.create(build, { mixer, recorder: null, revision: 0 }, signal));
  try {
    transport.setDocument(score, 0);
    await transport.play();
    expect(transport.getSnapshot().status).toBe('error');
    // Retry must reject again rather than play a pooled voice with no loaded presets.
    await transport.play();
    expect(transport.getSnapshot()).toMatchObject({ status: 'error', error: message });
    expect(audio.starts).toEqual([]);
    expect(await engine.qaDiagnostics()).toMatchObject({ drivers: 0, alphaSynthInstances: 0, alphaSynthPooled: 0 });
  } finally { transport.destroy(); engine.destroy(); mixer.destroy(); await master.destroy(); }
});

it.each([
  ['ko', '사운드폰트를 불러오지 못했습니다.'],
  ['en', 'Could not load the SoundFont.'],
] as const)('m3 rejects a corrupt SoundFont before exporting any PCM in %s', async (language, message) => {
  setLanguage(language);
  const score = fixtureDocument('loop-eight-bars'); const mixer = new MixerStore(); mixer.load(score);
  const render = renderOffline(brokenFont, {
    build: buildOfflinePlayback(score, { followRepeats: true }), score, mixer: mixer.getSnapshot(),
    tempo: { rate: 1, fixedBpm: null }, backing: { waveform: false, syncEnabled: false, gain: 1, mute: false },
    source: null, signal: new AbortController().signal,
  });
  try { await expect(render.next()).rejects.toThrow(message); }
  finally { await render.return(undefined); }
});

it('m3 localizes a Korean export-renderer failure for the English application', async () => {
  const score = fixtureDocument('loop-eight-bars'); const mixer = new MixerStore(); mixer.load(score);
  const render = renderOffline(brokenFont, {
    build: buildOfflinePlayback(score, { followRepeats: true }), score, mixer: mixer.getSnapshot(),
    tempo: { rate: 1, fixedBpm: null }, backing: { waveform: false, syncEnabled: false, gain: 1, mute: false },
    source: null, signal: new AbortController().signal,
  });
  try {
    const message = await render.next().then(() => 'Unexpected PCM', (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return error.message;
    });
    expect(localize(message, 'en')).toBe('Could not load the SoundFont.');
  } finally { await render.return(undefined); }
});
