import type { AudioRenderWorkerBridge } from '../preload/audio-render-contract';
import { buildOfflinePlayback, backingAudio, renderOffline } from '../workers/audio-export';
import { LoopClock } from './audio/transport';
import { collectWav, pcm16, wavHeader, wavSetLimit } from './audio/wav-export';
import { t } from './i18n';

declare global {
  interface Window { readonly exportDesktop: AudioRenderWorkerBridge; }
}
const safeName = (name: string): string =>
  name.replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 140) || 'Untitled';

window.exportDesktop.onStart((jobId, request) => {
  const abort = new AbortController();
  window.addEventListener('beforeunload', () => abort.abort(), { once: true });
  void (async () => {
    const response = await fetch(new URL('/soundfont/sonivox.sf2', location.href),
      { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) });
    if (!response.ok) throw new RangeError(`SoundFont unavailable (${response.status})`);
    const soundFont = new Uint8Array(await response.arrayBuffer());
    const score = request.parts.project.score;
    const build = buildOfflinePlayback(score, request.compile);
    const clock = new LoopClock(build, request.tempo.rate, request.tempo.fixedBpm);
    const totalFrames = Math.round(clock.duration * 48_000);
    if (!totalFrames || totalFrames * 4 + 44 > 0xffffffff) throw new RangeError('내보내기 길이가 PCM WAV 범위를 벗어납니다.');
    const mixer = { tracks: new Map(request.mixer.tracks), master: request.mixer.master };
    const render = (trackId?: typeof score.tracks[number]['id'], backingOnly = false) =>
      renderOffline(soundFont, {
        build,
        score,
        tempo: request.tempo,
        signal: abort.signal,
        backing: request.backing,
        mixer: backingOnly ? { ...mixer, tracks: new Map([...mixer.tracks].map(([id, mix]) =>
          [id, { ...mix, mute: true }])) } : mixer,
        source: request.mixed && (request.mode === 'single' || backingOnly) ? backingAudio(request.parts) : null,
        ...(trackId ? { trackId } : {}),
      });
    if (request.mode === 'single') {
      await window.exportDesktop.write(jobId, wavHeader(0));
      let frames = 0;
      for await (const block of render()) {
        frames += block.length / 2;
        await window.exportDesktop.write(jobId, pcm16(block));
        window.exportDesktop.progress(jobId, { frames, totalFrames, finalizing: false });
      }
      if (frames !== totalFrames) throw new RangeError('Rendered audio did not reach range end');
      const header = wavHeader(frames);
      window.exportDesktop.progress(jobId, { frames, totalFrames, finalizing: true });
      await window.exportDesktop.done(jobId, { kind: 'stream', patches: [
        { offset: 4, bytes: header.slice(4, 8) },
        { offset: 40, bytes: header.slice(40, 44) },
      ] });
      return;
    }
    const files: { readonly name: string; readonly bytes: Uint8Array }[] = [];
    const count = score.tracks.length + (request.mixed ? 1 : 0);
    if ((44 + totalFrames * 4) * count > wavSetLimit) throw new RangeError(t('io.audio.stemLimit'));
    for (const [index, track] of score.tracks.entries()) {
      const bytes = await collectWav(render(track.id), {
        totalFrames,
        signal: abort.signal,
        progress: value => window.exportDesktop.progress(jobId, { ...value,
          frames: index * totalFrames + value.frames,
          totalFrames: count * totalFrames }),
      });
      files.push({ name: `${String(index + 1).padStart(2, '0')}-${safeName(track.name)}.wav`, bytes });
    }
    if (request.mixed) files.push({ name: 'backing.wav', bytes: await collectWav(render(undefined, true), {
      totalFrames,
      signal: abort.signal,
      progress: value => window.exportDesktop.progress(jobId, { ...value,
        frames: score.tracks.length * totalFrames + value.frames,
        totalFrames: count * totalFrames }),
    }) });
    await window.exportDesktop.done(jobId, { kind: 'files', files });
  })().catch((error: unknown) =>
    window.exportDesktop.failed(jobId, error instanceof Error ? error.message : String(error)));
});
