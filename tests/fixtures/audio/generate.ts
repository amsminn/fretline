import { assertNever } from '../../../src/domain/diagnostics';

export function generateWav(kind: 'impulse' | 'distinct-frequency' | 'backing-quarter'): Buffer {
  const rate = 48_000;
  const frames = rate * (kind === 'backing-quarter' ? 16 : 4);
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      let sample: number;
      switch (kind) {
        case 'impulse': sample = frame % rate === 0 ? 24_000 : 0; break;
        case 'distinct-frequency': sample = Math.round(12_000 * Math.sin(2 * Math.PI * (channel === 0 ? 440 : 880) * frame / rate)); break;
        case 'backing-quarter': {
          const phase = frame % (rate / 2);
          sample = channel === 1 && phase < 480
            ? Math.round(19_660 * Math.sin(phase * Math.PI / 4) * Math.exp(-phase / 120)) : 0;
          break;
        }
        default: return assertNever(kind);
      }
      wav.writeInt16LE(sample, 44 + frame * 4 + channel * 2);
    }
  }
  return wav;
}
