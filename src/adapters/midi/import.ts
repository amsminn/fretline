import { panFromController } from '../pan';
import type { Measure, Note, ScoreDocument, ScoreEvent, Track, VoiceLane } from '../../domain/document';
import { assertNever } from '../../domain/diagnostics';
import { newId } from '../../domain/ids';
import type { NoteId } from '../../domain/ids';
import { rationalQ, zeroQ } from '../../domain/rational';
import { emptyScore, importedProject, loss } from '../musicxml/project';
import { InterchangeError } from '../musicxml/xml';
import { defaultMidiOptions, guitarTuning, previewMidi } from './preview';
import type { MidiOptions } from './preview';

export async function importMidi(bytes: Uint8Array, name: string, options: MidiOptions = defaultMidiOptions) {
  const preview = previewMidi(bytes, options), { data, notes, cellsPerQuarter } = preview;
  const cellsPerBar = cellsPerQuarter * 4;
  const barCount = Math.ceil(notes.reduce((end, n) => Math.max(end, n.endCell), 0) / cellsPerBar);
  if (barCount > 10000) throw new InterchangeError('LIMIT', 'MIDI quantization exceeds 10000 measures');
  const measures: Measure[] = Array.from({ length: barCount }, (_, i) => ({
    id: newId('measure'), meter: { beats: 4, unit: 4 }, actualSpanQ: rationalQ(4n), key: { fifths: 0, mode: 'major' },
    tempoEvents: i === 0 ? [{ offsetQ: zeroQ, bpm: 120, transition: 'step' }] : [],
    repeats: { start: false }, endings: [], jumps: [],
  }));
  for (const tempo of data.tempos) {
    const bpm = 60000000 / tempo.microseconds;
    if (bpm < 10 || bpm > 400) throw new InterchangeError('STRUCTURE', 'MIDI tempo is outside 10–400 BPM');
    const index = Math.floor(tempo.tick / data.ppq / 4), measure = measures[index];
    if (measure) measures[index] = { ...measure, tempoEvents: [...measure.tempoEvents.filter(t =>
      Number(t.offsetQ.n) / Number(t.offsetQ.d) !== (tempo.tick / data.ppq - index * 4)),
      { offsetQ: rationalQ(BigInt(tempo.tick - index * data.ppq * 4), BigInt(data.ppq)), bpm, transition: 'step' }] };
  }
  const ties: ScoreDocument['ties'][number][] = [], tuplets: ScoreDocument['tuplets'][number][] = [];
  const automations: ScoreDocument['automations'][number][] = [];
  const groups = [...new Set(notes.map(n => `${n.track}/${n.channel}`))];
  const tracks: Track[] = groups.map(key => {
    const selected = notes.filter(n => `${n.track}/${n.channel}` === key), first = selected[0];
    if (!first) throw new InterchangeError('STRUCTURE', 'Empty MIDI channel');
    const trackId = newId('track'), kind = first.channel === 9 ? 'percussion' : options.instrument === 'guitar' ? 'fretted' : 'pitched';
    const controls = data.controls.filter(c => c.track === first.track && c.channel === first.channel);
    for (const c of controls) {
      const mi = Math.floor(c.tick / data.ppq / 4), measure = measures[mi];
      if (!measure) continue;
      let kind: ScoreDocument['automations'][number]['kind'] | undefined, value = c.value;
      switch (c.kind) {
        case 'program': kind = 'program'; break;
        case 'pitchBend': kind = 'pitchBend'; break;
        case 'controller':
          kind = c.controller === 7 ? 'volume' : c.controller === 10 ? 'pan' : c.controller === 11 ? 'expression' : c.controller === 64 ? 'sustain' : undefined;
          if (kind === 'volume' || kind === 'expression') value /= 127;
          if (kind === 'pan') value = panFromController(value);
          if (kind === 'sustain') value = value >= 64 ? 1 : 0;
          break;
        default: return assertNever(c.kind);
      }
      if (kind) automations.push({ id: newId('automation'), trackId, measureId: measure.id,
        offsetQ: rationalQ(BigInt(c.tick - mi * data.ppq * 4), BigInt(data.ppq)), kind, value });
    }
    const voices: VoiceLane[] = ([1, 2, 3, 4] as const).map(number => {
      const lane = selected.filter(n => n.voice === number), previous = new Map<typeof selected[number], NoteId>();
      return { id: newId('voice'), number, bars: measures.map((measure, mi) => {
        if (!lane.some(n => n.startCell < (mi + 1) * cellsPerBar && n.endCell > mi * cellsPerBar)) return { kind: 'inactive', measureId: measure.id };
        const events: ScoreEvent[] = [];
        for (let cell = 0; cell < cellsPerBar; cell++) {
          const absolute = mi * cellsPerBar + cell, eventId = newId('event');
          const active = lane.filter(n => n.startCell <= absolute && n.endCell > absolute);
          const mapped: Note[] = active.map(n => {
            const id = newId('note'), from = previous.get(n);
            if (from && n.startCell < absolute) ties.push({ id: newId('tie'), from, to: id });
            previous.set(n, id);
            const fields = { id, techniques: [], audio: { velocity: n.velocity, offsetQ: zeroQ, durationQ: rationalQ(1n, BigInt(cellsPerQuarter)) } };
            switch (kind) {
              case 'fretted':
                if (n.string === null || n.fret === null) throw new InterchangeError('STRUCTURE', 'Missing confirmed guitar assignment');
                return { ...fields, kind, string: n.string, fret: n.fret };
              case 'pitched': return { ...fields, kind, midi: n.pitch };
              case 'percussion': return { ...fields, kind, midi: n.pitch, articulation: String(n.pitch) };
              default: return assertNever(kind);
            }
          });
          const duration = { base: cellsPerQuarter === 4 ? 16 : 8, dots: 0, tupletIds: [] };
          events.push(mapped.length ? { id: eventId, kind: 'noteGroup', duration, notes: mapped } : { id: eventId, kind: 'rest', duration });
        }
        if (options.grid === 'triplet') for (let i = 0; i < events.length; i += 3) {
          const id = newId('tuplet'), group = events.slice(i, i + 3);
          tuplets.push({ id, actual: 3, normal: 2, unit: 8, eventIds: group.map(e => e.id) });
          for (const [j, e] of group.entries()) if (e.duration !== 'fullMeasure') events[i + j] = { ...e, duration: { ...e.duration, tupletIds: [id] } };
        }
        return { kind: 'active', measureId: measure.id, events };
      }) };
    });
    return { id: trackId, name: data.names.get(first.track) ?? `MIDI ${first.track + 1} / ${first.channel + 1}`,
      instrument: { kind, program: controls.find(c => c.kind === 'program' && c.tick === 0)?.value ?? 0, bank: 0 },
      staves: [{ id: newId('staff'), clef: kind === 'percussion' ? 'percussion' : 'treble',
        tuning: kind === 'fretted' ? guitarTuning : [], capo: 0, voices }] };
  });
  const diagnostics = [
    loss('MIDI.quantization', name, `${options.grid === 'sixteenth' ? '1/16' : '셋잇단'} 단위와 미리보기의 성부·현 배치를 사용합니다. 원본 기보 정확성을 보장하지 않습니다.`),
    loss('MIDI.notation', name, '4/4 마디로 배치합니다. 가사·주법·원본 기보·마디 표현은 MIDI에서 복원되지 않습니다.'),
    ...(data.controls.some(c => c.kind === 'pitchBend') ? [loss('MIDI.pitchBend', name, 'Pitch bend의 signed 14-bit 값을 보존합니다. 출력 범위는 기본 ±2 반음이며 RPN 범위 변경은 복원되지 않습니다.')] : []),
    ...[...new Set(data.controls.filter(c => c.kind === 'controller' && ![7, 10, 11, 64].includes(c.controller ?? -1))
      .map(c => c.controller))].map(controller => loss(`MIDI.CC${controller}`, name, '이 controller는 원본 바이트에만 보존됩니다.')),
    ...data.omitted.map(f => loss(f, name, '이 MIDI event는 원본 바이트에만 보존됩니다.')),
  ];
  const score: ScoreDocument = { ...emptyScore(name.replace(/\.(mid|midi)$/i, '')), measures, tracks, ties, tuplets, automations };
  return importedProject(score, { bytes, name, extension: name.toLowerCase().endsWith('.midi') ? 'midi' : 'mid', format: `MIDI SMF${data.format}` }, diagnostics);
}
