/** Independent SMF semantic inspector for evidence: no imports from production adapters. */
export function inspectMidi(input: Uint8Array) {
  const bytes = Buffer.from(input);
  if (bytes.toString('ascii', 0, 4) !== 'MThd' || bytes.readUInt32BE(4) !== 6) throw new TypeError('Bad SMF header');
  const format = bytes.readUInt16BE(8), count = bytes.readUInt16BE(10), division = bytes.readUInt16BE(12);
  const tracks: { readonly notes: { readonly pitch: number; readonly start: number; readonly duration: number; readonly channel: number; readonly velocity: number }[];
    readonly tempos: { readonly tick: number; readonly bpm: number }[]; readonly programs: number[]; readonly controllers: number[][]; readonly bends: number[] }[] = [];
  let offset = 14;
  for (let track = 0; track < count; track++) {
    if (bytes.toString('ascii', offset, offset + 4) !== 'MTrk') throw new TypeError('Bad SMF track');
    const limit = offset + 8 + bytes.readUInt32BE(offset + 4);
    let cursor = offset + 8, tick = 0, status = 0;
    const notes: typeof tracks[number]['notes'] = [], tempos: typeof tracks[number]['tempos'] = [];
    const programs: number[] = [], controllers: number[][] = [], bends: number[] = [];
    const active = new Map<number, { readonly start: number; readonly velocity: number }>();
    const next = (): number => { if (cursor >= limit) throw new TypeError('Truncated SMF'); return bytes.readUInt8(cursor++); };
    const vlq = (): number => {
      let n = 0, b: number;
      do { b = next(); n = n * 128 + b % 128; } while (b >= 128);
      return n;
    };
    while (cursor < limit) {
      tick += vlq();
      const b = next();
      if (b >= 128) status = b; else cursor--;
      if (status === 255) {
        const type = next(), length = vlq();
        if (type === 81) tempos.push({ tick, bpm: 60000000 / bytes.readUIntBE(cursor, 3) });
        cursor += length;
      } else {
        const opcode = status >> 4, channel = status & 15, key = next();
        const value = opcode === 12 || opcode === 13 ? 0 : next();
        if (opcode === 9 && value > 0) active.set(channel * 128 + key, { start: tick, velocity: value });
        else if (opcode === 8 || (opcode === 9 && value === 0)) {
          const onset = active.get(channel * 128 + key);
          if (!onset) throw new TypeError('Orphan note-off');
          notes.push({ pitch: key, start: onset.start / division, duration: (tick - onset.start) / division, channel, velocity: onset.velocity });
          active.delete(channel * 128 + key);
        } else if (opcode === 12) programs.push(key);
        else if (opcode === 11) controllers.push([key, value]);
        else if (opcode === 14) bends.push(key + value * 128 - 8192);
      }
    }
    if (active.size) throw new TypeError('Unreleased notes');
    tracks.push({ notes, tempos, programs, controllers, bends });
    offset = limit;
  }
  if (offset !== bytes.length) throw new TypeError('Trailing SMF data');
  return { format, division, tracks };
}
