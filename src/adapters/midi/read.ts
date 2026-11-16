import { projectLimits } from '../../domain/project';
import { InterchangeError } from '../musicxml/xml';

export type MidiNote = {
  readonly track: number; readonly channel: number; readonly pitch: number; readonly velocity: number;
  readonly start: number; readonly end: number;
};
export type MidiControl = {
  readonly track: number; readonly channel: number; readonly tick: number;
  readonly kind: 'program' | 'controller' | 'pitchBend'; readonly value: number; readonly controller?: number;
};
export type MidiData = {
  readonly format: 0 | 1; readonly ppq: number; readonly notes: readonly MidiNote[];
  readonly controls: readonly MidiControl[]; readonly names: ReadonlyMap<number, string>;
  readonly tempos: readonly { readonly tick: number; readonly microseconds: number }[];
  readonly meters: readonly { readonly tick: number; readonly beats: number; readonly unit: number }[];
  readonly omitted: readonly string[];
};
/** SMF byte framing is separate from notation quantization. */
export function readMidi(bytes: Uint8Array): MidiData {
  const fail = (message: string): never => { throw new InterchangeError('FORMAT', message); };
  if (bytes.length > projectLimits.compressed) throw new InterchangeError('LIMIT', 'MIDI exceeds 256 MiB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0, end = bytes.length;
  const byte = (): number => { const value = bytes[cursor++]; return value === undefined || cursor > end ? fail('Truncated MIDI') : value; };
  const u16 = (): number => byte() * 256 + byte();
  const u32 = (): number => byte() * 0x1000000 + byte() * 65536 + byte() * 256 + byte();
  const tag = (): string => String.fromCharCode(byte(), byte(), byte(), byte());
  const variable = (): number => {
    let value = 0;
    for (let i = 0; i < 4; i++) { const b = byte(); value = value * 128 + (b & 127); if (b < 128) return value; }
    return fail('MIDI variable length exceeds four bytes');
  };
  if (tag() !== 'MThd' || u32() !== 6) return fail('Expected SMF header');
  const format = u16(), trackCount = u16(), ppq = u16();
  if ((format !== 0 && format !== 1) || !trackCount || trackCount > 256 || (format === 0 && trackCount !== 1)) return fail('Only SMF0 and SMF1 are supported');
  if (!ppq || ppq & 0x8000) return fail('MIDI SMPTE time division requires explicit conversion to PPQ');
  const notes: MidiNote[] = [], controls: MidiControl[] = [], names = new Map<number, string>();
  const tempos: MidiData['tempos'][number][] = [], meters: MidiData['meters'][number][] = [];
  const omitted = new Set<string>();
  let eventCount = 0;
  for (let track = 0; track < trackCount; track++) {
    end = bytes.length;
    if (tag() !== 'MTrk') return fail('Missing MIDI track chunk');
    const size = u32();
    end = cursor + size;
    if (end > bytes.length) return fail('Truncated MIDI track');
    let tick = 0, running = 0, ended = false;
    const sounding = new Map<string, { readonly tick: number; readonly velocity: number }[]>();
    while (cursor < end) {
      if (++eventCount > 1000000) throw new InterchangeError('LIMIT', 'Too many MIDI events');
      tick += variable();
      if (tick > 0x7fffffff) throw new InterchangeError('LIMIT', 'MIDI timeline exceeds limit');
      let status = byte();
      if (status < 128) { cursor--; if (!running) return fail('Running status without channel status'); status = running; }
      else running = status < 0xf0 ? status : 0;
      if (status === 0xff) {
        const type = byte(), length = variable(), start = cursor;
        if (start + length > end) return fail('Truncated MIDI meta event');
        switch (type) {
          case 0x2f:
            if (length !== 0 || cursor !== end) return fail('End of track must be final');
            ended = true; break;
          case 0x51:
            if (length !== 3) return fail('Invalid tempo length');
            tempos.push({ tick, microseconds: byte() * 65536 + byte() * 256 + byte() });
            if (!tempos.at(-1)?.microseconds) return fail('Zero MIDI tempo');
            break;
          case 0x58: {
            if (length !== 4) return fail('Invalid meter length');
            const beats = byte(), exponent = byte();
            if (!beats || exponent > 7) return fail('Invalid MIDI meter');
            meters.push({ tick, beats, unit: 2 ** exponent }); break;
          }
          case 0x03: names.set(track, new TextDecoder().decode(bytes.subarray(start, start + length))); break;
          default: omitted.add(`meta:${type.toString(16)}`);
        }
        cursor = start + length;
      } else if (status === 0xf0 || status === 0xf7) {
        const length = variable();
        if (cursor + length > end) return fail('Truncated SysEx');
        cursor += length; omitted.add('SysEx');
      } else {
        if (status < 0x80 || status >= 0xf0) return fail('Invalid SMF status');
        const kind = status >> 4, channel = status & 15;
        const a = byte(), b = kind === 0xc || kind === 0xd ? 0 : byte();
        if (a > 127 || b > 127) return fail('Invalid channel data');
        const key = `${channel}/${a}`;
        if (kind === 0x9 && b !== 0) {
          const queue = sounding.get(key) ?? []; queue.push({ tick, velocity: b }); sounding.set(key, queue);
        } else if (kind === 0x8 || (kind === 0x9 && b === 0)) {
          const queue = sounding.get(key), onset = queue?.shift();
          if (!onset || tick <= onset.tick) return fail('Unmatched or zero-length MIDI note');
          notes.push({ track, channel, pitch: a, velocity: onset.velocity, start: onset.tick, end: tick });
        } else if (kind === 0xb) controls.push({ track, channel, tick, kind: 'controller', controller: a, value: b });
        else if (kind === 0xc) controls.push({ track, channel, tick, kind: 'program', value: a });
        else if (kind === 0xe) controls.push({ track, channel, tick, kind: 'pitchBend', value: a + b * 128 - 8192 });
        else omitted.add(`channel:${kind.toString(16)}`);
      }
    }
    if (!ended || [...sounding.values()].some(queue => queue.length)) return fail('Missing end-of-track or unterminated note');
  }
  if (cursor !== view.byteLength) return fail('Trailing bytes after MIDI tracks');
  return { format, ppq, notes: notes.sort((a, b) => a.start - b.start || a.track - b.track || a.channel - b.channel || a.pitch - b.pitch),
    controls, names, tempos: tempos.sort((a, b) => a.tick - b.tick), meters: meters.sort((a, b) => a.tick - b.tick), omitted: [...omitted] };
}
