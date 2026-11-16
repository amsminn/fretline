import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const qaEvidenceEnabled = (): boolean => process.env['FRETLINE_QA'] === '1' && Boolean(process.env['FRETLINE_QA_EVIDENCE']);
const maximumPcmBytes = 1200 * 48_000 * 4;
let writes: Promise<void> = Promise.resolve();

/** The sender chooses a bounded artifact kind, never a path. O_NOFOLLOW rejects pre-existing symlinks. */
export async function writeQaEvidence(kind: unknown, input: unknown): Promise<void> {
  const root = process.env['FRETLINE_QA_EVIDENCE'];
  if (!qaEvidenceEnabled() || !root) throw new TypeError('QA evidence is unavailable');
  if (!(input instanceof Uint8Array) || input.byteLength > 64 * 1024 ** 2) throw new RangeError('Invalid QA evidence bytes');
  const operation = writes.then(() => writeArtifact(root, kind, input));
  // Serialize file operations, without making one rejected request poison later requests.
  writes = operation.then(() => {}, () => {});
  return operation;
}

async function writeArtifact(root: string, kind: unknown, input: Uint8Array): Promise<void> {
  await mkdir(resolve(root), { recursive: true });
  const directory = await realpath(resolve(root));
  switch (kind) {
    case 'audio':
    case 'attacks':
    case 'audio-start': {
      if (kind === 'audio-start' && (input.length !== 44 || new TextDecoder().decode(input.subarray(0, 4)) !== 'RIFF' ||
        new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(40, true) !== 0)) throw new TypeError('Invalid QA stream header');
      const name = kind === 'attacks' ? 'attacks.json' : kind === 'audio' ? 'playback.wav' : 'playback.capture.part';
      const file = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(input); } finally { await file.close(); }
      return;
    }
    case 'audio-append': {
      if (!input.length || input.length > 1024 ** 2 || input.length % 4) throw new RangeError('Invalid QA PCM chunk');
      const file = await open(join(directory, 'playback.capture.part'), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        const size = (await file.stat()).size;
        if (size < 44 || size + input.length > 44 + maximumPcmBytes) throw new RangeError('QA recording exceeded 1200 seconds');
        await file.writeFile(input);
      } finally { await file.close(); }
      return;
    }
    case 'audio-finish': {
      if (input.length !== 4) throw new TypeError('Invalid QA stream size');
      const bytes = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(0, true);
      if (bytes % 4 || bytes > maximumPcmBytes) throw new RangeError('Invalid QA stream size');
      await snapshotAudio(directory, bytes);
      return;
    }
    default: throw new TypeError('Unknown QA evidence kind');
  }
}

/** Snapshot the flushed prefix; later capture appends never mutate a saved WAV. */
async function snapshotAudio(directory: string, bytes: number): Promise<void> {
  const source = await open(join(directory, 'playback.capture.part'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await source.stat()).size < 44 + bytes) throw new RangeError('QA PCM has not been received');
    const target = await open(join(directory, 'playback.wav'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      const buffer = Buffer.alloc(1024 ** 2);
      for (let position = 0; position < 44 + bytes;) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, 44 + bytes - position), position);
        if (!bytesRead) throw new RangeError('QA PCM ended before its declared size');
        await target.writeFile(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      const size = Buffer.alloc(4);
      for (const [offset, value] of [[4, 36 + bytes], [40, bytes]] as const) {
        size.writeUInt32LE(value);
        if ((await target.write(size, 0, 4, offset)).bytesWritten !== 4) throw new Error('Incomplete QA WAV header write');
      }
    } finally { await target.close(); }
  } finally { await source.close(); }
}
