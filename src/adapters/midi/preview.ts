import { readMidi } from './read';
import type { MidiData, MidiNote } from './read';
import { InterchangeError } from '../musicxml/xml';

export type MidiOptions = { readonly grid: 'sixteenth' | 'triplet'; readonly instrument: 'pitched' | 'guitar' };
export const defaultMidiOptions: MidiOptions = { grid: 'sixteenth', instrument: 'pitched' };
export type QuantizedNote = MidiNote & {
  readonly startCell: number; readonly endCell: number; readonly voice: 1 | 2 | 3 | 4;
  readonly string: number | null; readonly fret: number | null;
};
export type MidiPreview = {
  readonly data: MidiData; readonly options: MidiOptions; readonly cellsPerQuarter: number;
  readonly notes: readonly QuantizedNote[];
};
export const guitarTuning = [64, 59, 55, 50, 45, 40] as const;
export function previewMidi(bytes: Uint8Array, options: MidiOptions = defaultMidiOptions): MidiPreview {
  const data = readMidi(bytes), cellsPerQuarter = options.grid === 'sixteenth' ? 4 : 3;
  const output: QuantizedNote[] = [];
  const ends = new Map<string, number[]>();
  const occupiedStrings = new Map<string, number[]>();
  for (const note of data.notes) {
    const startCell = Math.max(0, Math.round(note.start / data.ppq * cellsPerQuarter));
    const endCell = Math.max(startCell + 1, Math.round(note.end / data.ppq * cellsPerQuarter));
    const track = `${note.track}/${note.channel}`;
    const voices = ends.get(track) ?? [0, 0, 0, 0];
    const chord = output.find(n => n.track === note.track && n.channel === note.channel && n.startCell === startCell && n.endCell === endCell && n.pitch !== note.pitch);
    const voiceIndex = chord ? chord.voice - 1 : voices.findIndex(end => end <= startCell);
    const voice = ([1, 2, 3, 4] as const)[voiceIndex];
    if (!voice) throw new InterchangeError('STRUCTURE', '양자화 결과가 성부 4개를 초과합니다. 다른 양자화 단위로 다시 확인하세요.');
    voices[voiceIndex] = endCell; ends.set(track, voices);
    let string: number | null = null, fret: number | null = null;
    if (options.instrument === 'guitar' && note.channel !== 9) {
      const strings = occupiedStrings.get(track) ?? guitarTuning.map(() => 0);
      const candidate = guitarTuning.map((open, index) => ({ string: index + 1, fret: note.pitch - open, end: strings[index] ?? 0 }))
        .filter(c => c.fret >= 0 && c.fret <= 24 && c.end <= startCell).sort((a, b) => a.fret - b.fret || a.string - b.string)[0];
      if (!candidate) throw new InterchangeError('STRUCTURE', '기타 현에 배치할 수 없습니다. 음높이 악기를 선택하세요.');
      string = candidate.string; fret = candidate.fret; strings[string - 1] = endCell; occupiedStrings.set(track, strings);
    }
    output.push({ ...note, startCell, endCell, voice, string, fret });
  }
  if (!output.length) throw new InterchangeError('STRUCTURE', 'MIDI contains no complete notes');
  return { data, options, cellsPerQuarter, notes: output };
}
