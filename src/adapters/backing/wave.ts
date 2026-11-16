/**
 * PCM WAV reader/writer for backing assets. The project stores backing audio as RIFF/WAVE PCM so the
 * random-access producer in `src/workers/audio-export.ts` can stream it; compressed imports are
 * transcoded once at import time (see `decode.ts`).
 */
export type WaveLayout = {
  readonly format: 1 | 3;
  readonly channels: 1 | 2;
  readonly sampleRate: number;
  readonly bits: 16 | 24 | 32;
  readonly dataOffset: number;
  readonly frames: number;
};
export type StereoPcm = readonly [Float32Array, Float32Array];

export class WaveError extends TypeError {
  constructor(readonly reason: 'header' | 'layout' | 'truncated', message: string) {
    super(message);
    this.name = 'WaveError';
  }
}

const ascii = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));

export function parseWave(bytes: Uint8Array): WaveLayout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') throw new WaveError('header', 'RIFF/WAVE 헤더가 아닙니다.');
  let format = 0; let channels = 0; let sampleRate = 0; let bits = 0; let stride = 0; let dataOffset = 0; let length = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > bytes.length) throw new WaveError('truncated', 'WAV 청크가 잘렸습니다.');
    if (ascii(bytes, at) === 'fmt ' && size >= 16) {
      format = view.getUint16(at + 8, true); channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true); stride = view.getUint16(at + 20, true); bits = view.getUint16(at + 22, true);
    }
    if (ascii(bytes, at) === 'data') { dataOffset = at + 8; length = size; }
    at += 8 + size + size % 2;
  }
  const pcm = format === 1 && (bits === 16 || bits === 24 || bits === 32);
  const float = format === 3 && bits === 32;
  if (!dataOffset || (channels !== 1 && channels !== 2) || sampleRate < 8000 || sampleRate > 192000 || !(pcm || float) ||
    stride !== channels * bits / 8 || length % stride) throw new WaveError('layout', '지원하지 않는 WAV PCM 레이아웃입니다.');
  return { format: format === 3 ? 3 : 1, channels, sampleRate, bits: bits === 16 ? 16 : bits === 24 ? 24 : 32, dataOffset, frames: length / stride };
}

/** Sample reader bound to one parsed layout; out-of-range frames read as silence. */
export function waveSampler(bytes: Uint8Array, layout: WaveLayout): (frame: number, channel: number) => number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stride = layout.channels * layout.bits / 8;
  return (frame, channel) => {
    if (frame < 0 || frame >= layout.frames) return 0;
    const at = layout.dataOffset + frame * stride + Math.min(channel, layout.channels - 1) * layout.bits / 8;
    if (layout.format === 3) { const value = view.getFloat32(at, true); return Number.isFinite(value) ? value : 0; }
    switch (layout.bits) {
      case 16: return view.getInt16(at, true) / 32768;
      case 24: return (view.getUint8(at) | view.getUint8(at + 1) << 8 | view.getInt8(at + 2) << 16) / 8388608;
      case 32: return view.getInt32(at, true) / 2147483648;
      default: { const exhaustive: never = layout.bits; throw new WaveError('layout', `Unsupported width ${String(exhaustive)}`); }
    }
  };
}

/** PCM16 stereo RIFF/WAVE; the only layout the app writes. */
export function encodeWave(pcm: StereoPcm, sampleRate: number): Uint8Array {
  const frames = Math.min(pcm[0].length, pcm[1].length);
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string): void => { for (let i = 0; i < 4; i++) bytes[at + i] = text.charCodeAt(i); };
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, frames * 4, true);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      const sample = Math.max(-1, Math.min(1, pcm[channel]?.[frame] ?? 0));
      view.setInt16(44 + frame * 4 + channel * 2, Math.round(sample * 32767), true);
    }
  }
  return bytes;
}
