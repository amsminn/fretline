import type { DocumentToken } from '../../domain/project';
import type { ExportBridge, ExportResult } from '../../preload/export-contract';

const rate = 48_000;
const frameBytes = 4;
export const wavSetLimit = 256 * 1024 ** 2;
export type WavProgress = { readonly frames: number; readonly totalFrames: number; readonly finalizing: boolean };
export type WavOutput = {
  readonly bridge: ExportBridge; readonly documentToken: DocumentToken; readonly name: string;
  readonly totalFrames: number; readonly signal: AbortSignal; readonly progress: (progress: WavProgress) => void;
};

/** RIFF/WAVE PCM16, stereo, 48 kHz. Length is finalized only after the last successful pull. */
export function wavHeader(frames: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(frames) || frames < 0 || frames * frameBytes + 36 > 0xffffffff) throw new RangeError('WAV frame count exceeds RIFF limits');
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string): void => { bytes.set(new TextEncoder().encode(text), offset); };
  tag(0, 'RIFF'); view.setUint32(4, frames * frameBytes + 36, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * frameBytes, true);
  view.setUint16(32, frameBytes, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, frames * frameBytes, true);
  return bytes;
}
/** Saturate at [-1, 1], round to nearest PCM16, and reject corrupt non-finite PCM. No wrap or global normalization. */
export function pcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  if (samples.length % 2) throw new RangeError('Expected interleaved stereo PCM');
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (const [index, sample] of samples.entries()) {
    if (!Number.isFinite(sample)) throw new RangeError('Non-finite PCM sample');
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
export async function streamWav(blocks: AsyncIterable<Float32Array>, output: WavOutput): Promise<ExportResult> {
  output.signal.throwIfAborted();
  wavHeader(output.totalFrames);
  const started = await output.bridge.beginExportStream({
    documentToken: output.documentToken, format: 'wav', suggestedName: output.name,
  });
  switch (started.kind) {
    case 'cancelled': case 'failed': return started;
    case 'started': break;
    default: { const exhaustive: never = started; throw new TypeError(String(exhaustive)); }
  }
  let frames = 0;
  try {
    output.signal.throwIfAborted();
    await output.bridge.writeExportStream(started.streamToken, wavHeader(0));
    for await (const block of blocks) {
      output.signal.throwIfAborted();
      frames += block.length / 2;
      if (frames > output.totalFrames) throw new RangeError('Rendered audio exceeds the selected range');
      await output.bridge.writeExportStream(started.streamToken, pcm16(block));
      output.progress({ frames, totalFrames: output.totalFrames, finalizing: false });
    }
    output.signal.throwIfAborted();
    if (frames !== output.totalFrames) throw new RangeError('Rendered audio did not reach the selected range end');
    const header = wavHeader(frames);
    output.progress({ frames, totalFrames: output.totalFrames, finalizing: true });
    return await output.bridge.commitExportStream(started.streamToken, [
      { offset: 4, bytes: header.slice(4, 8) }, { offset: 40, bytes: header.slice(40, 44) },
    ]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (output.signal.aborted) return { kind: 'cancelled' };
    return { kind: 'failed', message: error.message };
  } finally { await output.bridge.abortExportStream(started.streamToken); }
}

/** Finished artifact sets use the bridge's explicit 256 MiB transaction limit. PCM stays block-sized. */
export async function collectWav(blocks: AsyncIterable<Float32Array>, output: Pick<WavOutput, 'totalFrames' | 'signal' | 'progress'>): Promise<Uint8Array> {
  const header = wavHeader(output.totalFrames);
  if (44 + output.totalFrames * frameBytes > wavSetLimit) throw new RangeError('트랙별 WAV 묶음은 256 MiB까지 지원합니다. 구간을 줄여 주세요.');
  const bytes = new Uint8Array(44 + output.totalFrames * frameBytes); bytes.set(header);
  let frames = 0;
  for await (const block of blocks) {
    output.signal.throwIfAborted();
    const chunk = pcm16(block);
    if (frames + block.length / 2 > output.totalFrames) throw new RangeError('Rendered audio exceeds range');
    bytes.set(chunk, 44 + frames * frameBytes); frames += block.length / 2;
    output.progress({ frames, totalFrames: output.totalFrames, finalizing: false });
  }
  output.signal.throwIfAborted();
  if (frames !== output.totalFrames) throw new RangeError('Rendered audio did not reach range end');
  return bytes;
}
