import { AlphaTabApi, PlayerMode, Settings, synth } from '@coderline/alphatab';
import type { ScoreDocument } from '../../../../src/domain/document';
import { compileOccurrences } from '../../../../src/domain/timeline';
import { rationalQ } from '../../../../src/domain/rational';
import { linearizeScore } from '../../../../src/adapters/alphatab/linearize';

export type StemReceipt = {
  readonly kind: 'preparing' | 'cancelling' | 'complete' | 'cancelled' | 'failed';
  readonly elapsedMs: number;
  readonly activeExporters: number;
  readonly maxExporters: number;
  readonly createdExporters: number;
  readonly destroyedExporters: number;
  readonly chunks: number;
  readonly frames: number;
  readonly nonzeroSamples: number;
  readonly completedTracks: number;
  readonly retainedBytes: number;
  readonly peakRetainedBytes: number;
  readonly perTrack: readonly { readonly track: number; readonly requestedMs: number; readonly frames: number; readonly elapsedMs: number }[];
  readonly firstWindowMs?: number;
  readonly threeMinuteMs?: number;
  readonly error?: string;
};

/** QA benchmark of the actual pinned engine, with two exporters and bounded PCM retention. */
export async function preparePerfStems(input: {
  readonly document: ScoreDocument;
  readonly signal: AbortSignal;
  readonly report: (receipt: StemReceipt) => void;
}): Promise<void> {
  const started = performance.now();
  const active = new Set<synth.IAudioExporter>();
  const players: { readonly api: AlphaTabApi; readonly host: HTMLElement }[] = [];
  const windows = new Map<number, Float32Array[]>();
  let created = 0;
  let destroyed = 0;
  let maxExporters = 0;
  let chunks = 0;
  let frames = 0;
  let nonzeroSamples = 0;
  let completedTracks = 0;
  let peakRetainedBytes = 0;
  const perTrack: { readonly track: number; readonly requestedMs: number; readonly frames: number; readonly elapsedMs: number }[] = [];
  let firstWindowMs: number | undefined;
  let threeMinuteMs: number | undefined;
  const receipt = (kind: StemReceipt['kind'], error?: string): StemReceipt => ({
    kind, elapsedMs: performance.now() - started, activeExporters: active.size, maxExporters,
    createdExporters: created, destroyedExporters: destroyed, chunks, frames, nonzeroSamples, completedTracks, peakRetainedBytes,
    perTrack: [...perTrack],
    retainedBytes: [...windows.values()].flat().reduce((sum, samples) => sum + samples.byteLength, 0),
    ...(firstWindowMs === undefined ? {} : { firstWindowMs }),
    ...(threeMinuteMs === undefined ? {} : { threeMinuteMs }), ...(error === undefined ? {} : { error }),
  });
  const destroy = (exporter: synth.IAudioExporter): void => {
    if (active.delete(exporter)) { exporter.destroy(); destroyed++; }
  };
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<undefined>(resolveCancelled => { cancel = () => resolveCancelled(undefined); });
  const abort = (): void => {
    for (const exporter of active) destroy(exporter);
    windows.clear();
    cancel?.();
    input.report(receipt('cancelling'));
  };
  input.signal.addEventListener('abort', abort, { once: true });
  input.report(receipt('preparing'));
  try {
    const response = await fetch('app://fretline/soundfont/sonivox.sf2', { signal: input.signal });
    if (!response.ok) throw new TypeError(`Soundfont HTTP ${response.status}`);
    const soundFont = new Uint8Array(await response.arrayBuffer());
    const occurrences = compileOccurrences(input.document, {
      followRepeats: false, range: { startQ: rationalQ(0n), endQ: rationalQ(360n) },
    });
    for (let lane = 0; lane < 2; lane++) {
      const settings = new Settings();
      settings.player.enablePlayer = true;
      settings.player.playerMode = PlayerMode.EnabledSynthesizer;
      settings.player.enableCursor = false;
      settings.player.enableUserInteraction = false;
      settings.core.fontDirectory = 'app://fretline/font/';
      const host = document.createElement('div');
      host.hidden = true;
      document.body.append(host);
      players.push({ api: new AlphaTabApi(host, settings), host });
    }
    const exportTrack = async (trackIndex: number, durationMs: number, api: AlphaTabApi): Promise<void> => {
      if (input.signal.aborted) return;
      const trackStarted = performance.now();
      const track = input.document.tracks[trackIndex];
      if (!track) throw new RangeError('Missing performance track');
      // A single-track projection also avoids aliasing the sixteenth pitched track
      // onto MIDI channel zero, which cannot be isolated by per-channel gain.
      const projection = linearizeScore({ ...input.document, tracks: [track] }, occurrences);
      let exporter: synth.IAudioExporter | undefined;
      try {
        api.renderScore(projection.score, [0]);
        const options = new synth.AudioExportOptions();
        options.sampleRate = 48000;
        options.useSyncPoints = true;
        options.soundFonts = [soundFont];
        options.trackVolume.set(0, 1);
        exporter = await api.exportAudio(options);
        active.add(exporter);
        created++;
        maxExporters = Math.max(maxExporters, active.size);
        if (input.signal.aborted) return;
        input.report(receipt('preparing'));
        let renderedMs = 0;
        let trackFrames = 0;
        const retained: Float32Array[] = [];
        if (durationMs === 8000) windows.set(trackIndex, retained);
        while (renderedMs < durationMs && !input.signal.aborted) {
          const chunk = await Promise.race([exporter.render(500), cancelled]);
          if (!chunk || input.signal.aborted) break;
          chunks++;
          const chunkFrames = chunk.samples.length / 2;
          frames += chunkFrames;
          trackFrames += chunkFrames;
          renderedMs += chunkFrames / 48;
          for (const sample of chunk.samples) if (Math.abs(sample) > 0.00001) nonzeroSamples++;
          if (durationMs === 8000 && retained.reduce((sum, samples) => sum + samples.length, 0) < 8000 * 96) {
            retained.push(chunk.samples.slice(0, Math.max(0, 8000 * 96 - retained.reduce((sum, samples) => sum + samples.length, 0))));
            peakRetainedBytes = Math.max(peakRetainedBytes, receipt('preparing').retainedBytes);
          }
        }
        if (!input.signal.aborted) {
          completedTracks++;
          perTrack.push({ track: trackIndex, requestedMs: durationMs, frames: trackFrames, elapsedMs: performance.now() - trackStarted });
        }
      } finally {
        if (exporter) destroy(exporter);
      }
    };
    const phase = async (durationMs: number): Promise<void> => {
      let next = 0;
      const lane = async (api: AlphaTabApi): Promise<void> => {
        while (next < 16 && !input.signal.aborted) {
          const trackIndex = next++;
          await exportTrack(trackIndex, durationMs, api);
        }
      };
      await Promise.all(players.map(player => lane(player.api)));
    };
    await phase(8000);
    if (input.signal.aborted) return;
    firstWindowMs = performance.now() - started;
    input.report(receipt('preparing'));
    windows.clear();
    const fullStarted = performance.now();
    await phase(180000);
    threeMinuteMs = performance.now() - fullStarted;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (!input.signal.aborted) input.report(receipt('failed', error.message));
    return;
  } finally {
    for (const exporter of active) destroy(exporter);
    for (const player of players) { player.api.destroy(); player.host.remove(); }
    windows.clear();
    input.signal.removeEventListener('abort', abort);
    if (input.signal.aborted) input.report(receipt('cancelled'));
  }
  input.report(receipt('complete'));
}
