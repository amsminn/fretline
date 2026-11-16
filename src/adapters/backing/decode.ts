import { encodeWave, parseWave, WaveError } from './wave';
import type { StereoPcm } from './wave';

export const backingSampleRate = 48_000;
export const backingMediaTypes: Readonly<Record<string, string>> = {
  wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
};
export type AudioDecoder = (bytes: Uint8Array) => Promise<{ readonly sampleRate: number; readonly channels: readonly Float32Array[] }>;
export type DecodedBacking = { readonly wav: Uint8Array; readonly durationSeconds: number; readonly sourceMediaType: string; readonly transcoded: boolean };

export class BackingImportError extends Error {
  constructor(readonly reason: 'unsupported-type' | 'corrupt' | 'empty' | 'too-large', message: string) {
    super(message);
    this.name = 'BackingImportError';
  }
}

export function mediaTypeForName(name: string): string | null {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  return backingMediaTypes[extension] ?? null;
}

function resample(channels: readonly Float32Array[], from: number): StereoPcm {
  const left = channels[0] ?? new Float32Array(0);
  const right = channels[1] ?? left;
  const frames = Math.round(left.length * backingSampleRate / from);
  const out: [Float32Array, Float32Array] = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; i++) {
    const position = i * from / backingSampleRate; const frame = Math.floor(position); const fraction = position - frame;
    for (const [channel, source] of [left, right].entries()) {
      const a = source[frame] ?? 0; const b = source[frame + 1] ?? a;
      const target = out[channel];
      if (target) target[i] = a * (1 - fraction) + b * fraction;
    }
  }
  return out;
}

export async function decodeBacking(input: { readonly name: string; readonly bytes: Uint8Array; readonly maxBytes: number }, decoder: AudioDecoder): Promise<DecodedBacking> {
  const sourceMediaType = mediaTypeForName(input.name);
  if (!sourceMediaType) throw new BackingImportError('unsupported-type', `지원하지 않는 오디오 형식입니다: ${input.name}`);
  if (input.bytes.byteLength === 0) throw new BackingImportError('empty', '오디오 파일이 비어 있습니다.');
  if (input.bytes.byteLength > input.maxBytes) throw new BackingImportError('too-large', '오디오 파일이 512 MiB 한도를 넘습니다.');
  if (sourceMediaType === 'audio/wav') {
    try {
      const layout = parseWave(input.bytes);
      if (layout.frames === 0) throw new BackingImportError('empty', 'WAV에 오디오 프레임이 없습니다.');
      return { wav: input.bytes, durationSeconds: layout.frames / layout.sampleRate, sourceMediaType, transcoded: false };
    } catch (error) {
      if (error instanceof WaveError) throw new BackingImportError('corrupt', `손상된 WAV: ${error.message}`);
      throw error;
    }
  }
  let decoded: Awaited<ReturnType<AudioDecoder>>;
  try { decoded = await decoder(input.bytes); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new BackingImportError('corrupt', `오디오를 디코드할 수 없습니다: ${error.message}`);
  }
  if (!decoded.channels.length || !(decoded.channels[0]?.length) || !Number.isFinite(decoded.sampleRate) || decoded.sampleRate <= 0) {
    throw new BackingImportError('empty', '디코드된 오디오에 프레임이 없습니다.');
  }
  const pcm = decoded.sampleRate === backingSampleRate && decoded.channels.length >= 2 && decoded.channels[1]
    ? [decoded.channels[0], decoded.channels[1]] as const : resample(decoded.channels, decoded.sampleRate);
  const wav = encodeWave(pcm, backingSampleRate);
  if (wav.byteLength > input.maxBytes) throw new BackingImportError('too-large', '디코드된 오디오가 512 MiB 한도를 넘습니다.');
  return { wav, durationSeconds: pcm[0].length / backingSampleRate, sourceMediaType, transcoded: true };
}
