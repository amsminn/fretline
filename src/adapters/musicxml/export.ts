import type { Measure, ScoreDocument, ScoreEvent, Staff, Track } from '../../domain/document';
import { assertNever } from '../../domain/diagnostics';
import { eventDurationQ, soundingPitch } from '../../domain/event-time';
import { multiplyQ, rationalQ } from '../../domain/rational';
import type { RationalQ } from '../../domain/rational';
import { parseScoreDocument } from '../../domain/validate';
import { packMxl } from './archive';
import { escapeXml, InterchangeError } from './xml';
import { noteTypes } from './tuplets';
import { loss } from './project';
import type { CompatibilityDiagnostic } from '../alphatab/compatibility';

function pitchXml(midi: number): string {
  const pitches = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
    ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]] as const;
  const pitch = pitches[midi % 12];
  if (!pitch) throw new InterchangeError('STRUCTURE', 'Invalid MIDI pitch');
  return `<step>${pitch[0]}</step>${pitch[1] ? '<alter>1</alter>' : ''}<octave>${Math.floor(midi / 12) - 1}</octave>`;
}
function divisionsFor(score: ScoreDocument): bigint {
  let divisions = 1n;
  function include(q: RationalQ): void {
    const denominator = BigInt(q.d);
    let a = divisions, b = denominator;
    while (b) [a, b] = [b, a % b];
    divisions = divisions / a * denominator;
    if (divisions > 0x7fffffffn) throw new InterchangeError('LIMIT', 'MusicXML divisions exceeds safe interoperability limit');
  }
  for (const m of score.measures) { include(m.actualSpanQ); for (const t of m.tempoEvents) include(t.offsetQ); }
  for (const t of score.tracks) for (const s of t.staves) for (const v of s.voices) for (const [i, b] of v.bars.entries()) {
    const m = score.measures[i];
    if (b.kind === 'active' && m) for (const e of b.events) include(eventDurationQ(e, m.actualSpanQ, score));
  }
  return divisions;
}
type Writer = { readonly score: ScoreDocument; readonly divisions: bigint };
const units = (q: RationalQ, divisions: bigint): string => String(BigInt(q.n) * divisions / BigInt(q.d));
function noteXml(event: ScoreEvent, position: { readonly staff: Staff; readonly number: number; readonly voice: number; readonly measure: Measure; readonly trackNumber: number }, writer: Writer): string {
  const { score, divisions } = writer;
  const { staff, measure } = position;
  const span = eventDurationQ(event, measure.actualSpanQ, score);
  const length = `<duration>${units(span, divisions)}</duration>`;
  const duration = event.duration;
  const ratios = duration === 'fullMeasure' ? [] : duration.tupletIds.map(id => score.tuplets.find(t => t.id === id));
  const ratio = ratios.reduce((q, t) => t ? multiplyQ(q, rationalQ(BigInt(t.normal), BigInt(t.actual))) : q, rationalQ(1n));
  const type = duration === 'fullMeasure' ? '' : [...noteTypes].find(([, base]) => base === duration.base)?.[0];
  if (duration !== 'fullMeasure' && !type) throw new InterchangeError('FORMAT', 'Unsupported written note duration');
  const written = `<voice>${position.voice}</voice>${type ? `<type>${type}</type>` : ''}` +
    (duration === 'fullMeasure' ? '' : '<dot/>'.repeat(duration.dots)) +
    (ratios.length ? `<time-modification><actual-notes>${ratio.d}</actual-notes><normal-notes>${ratio.n}</normal-notes></time-modification>` : '') +
    `<staff>${position.number}</staff>`;
  const lyrics = score.lyrics.filter(l => l.eventId === event.id).map(l =>
    `<lyric number="${l.verse}"><syllabic>${l.syllabic}</syllabic><text>${escapeXml(l.text)}</text>${l.extend ? '<extend/>' : ''}</lyric>`).join('');
  const tuplets = ratios.flatMap((t, i) => t ? [
    ...(t.eventIds[0] === event.id ? [`<tuplet type="start" number="${i + 1}"><tuplet-actual><tuplet-number>${t.actual}</tuplet-number><tuplet-type>${[...noteTypes].find(([, base]) => base === t.unit)?.[0]}</tuplet-type></tuplet-actual><tuplet-normal><tuplet-number>${t.normal}</tuplet-number><tuplet-type>${[...noteTypes].find(([, base]) => base === t.unit)?.[0]}</tuplet-type></tuplet-normal></tuplet>`] : []),
    ...(t.eventIds.at(-1) === event.id ? [`<tuplet type="stop" number="${i + 1}"/>`] : []),
  ] : []).join('');
  switch (event.kind) {
    case 'spacer': return `<forward>${length}<voice>${position.voice}</voice><staff>${position.number}</staff></forward>`;
    case 'rest': return `<note><rest${duration === 'fullMeasure' ? ' measure="yes"' : ''}/>${length}${written}${tuplets ? `<notations>${tuplets}</notations>` : ''}</note>`;
    case 'noteGroup':
      return event.notes.map((note, i) => {
        const stops = score.ties.some(t => t.to === note.id), starts = score.ties.some(t => t.from === note.id);
        const ties = `${stops ? '<tie type="stop"/>' : ''}${starts ? '<tie type="start"/>' : ''}`;
        const tied = `${stops ? '<tied type="stop"/>' : ''}${starts ? '<tied type="start"/>' : ''}`;
        const technical = note.kind === 'fretted' ? `<technical><string>${note.string}</string><fret>${note.fret}</fret></technical>` : '';
        const notation = tied + technical + (i === 0 ? tuplets : '');
        const pitch = note.kind === 'percussion' ? '<unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched>' : `<pitch>${pitchXml(soundingPitch(note, staff))}</pitch>`;
        const instrument = note.kind === 'percussion' ? `<instrument id="I${position.trackNumber}N${note.midi}"/>` : '';
        return `<note>${event.grace ? `<grace slash="${event.grace.slash ? 'yes' : 'no'}"/>` : ''}${i ? '<chord/>' : ''}${pitch}${event.grace ? '' : length}${ties}${instrument}${written}` +
          `${notation ? `<notations>${notation}</notations>` : ''}${i === 0 ? lyrics : ''}</note>`;
      }).join('');
    default: return assertNever(event);
  }
}
function attributes(measure: Measure, track: Track, divisions: bigint): string {
  const staves = track.staves.map((staff, i) => {
    if (staff.clef === 'percussion') return `<clef number="${i + 1}"><sign>percussion</sign></clef>`;
    const sign = staff.clef === 'bass' ? 'F' : staff.clef === 'alto' || staff.clef === 'tenor' ? 'C' : 'G';
    const line = staff.clef === 'bass' || staff.clef === 'tenor' ? 4 : staff.clef === 'alto' ? 3 : 2;
    return `<clef number="${i + 1}"><sign>${sign}</sign><line>${line}</line></clef>`;
  }).join('');
  const details = track.staves.map((staff, i) => staff.tuning.length
    ? `<staff-details number="${i + 1}"><staff-lines>${staff.tuning.length}</staff-lines>${[...staff.tuning].reverse().map((midi, index) =>
      `<staff-tuning line="${index + 1}">${pitchXml(midi).replaceAll('step', 'tuning-step').replaceAll('alter', 'tuning-alter').replaceAll('octave', 'tuning-octave')}</staff-tuning>`).join('')}<capo>${staff.capo}</capo></staff-details>` : '').join('');
  return `<attributes><divisions>${divisions}</divisions><key><fifths>${measure.key.fifths}</fifths><mode>${measure.key.mode}</mode></key>` +
    `<time><beats>${measure.meter.beats}</beats><beat-type>${measure.meter.unit}</beat-type></time><staves>${track.staves.length}</staves>${staves}${details}</attributes>`;
}
export function musicXmlExportDiagnostics(score: ScoreDocument): readonly CompatibilityDiagnostic[] {
  return [
    loss('layout/audio', score.id, 'GP 전용 스타일, 재생 음색, EQ와 반주는 MusicXML에 포함되지 않습니다.'),
    ...score.tracks.flatMap(t => t.staves.flatMap(s => s.voices.flatMap(v => v.bars.flatMap(b =>
      b.kind === 'active' ? b.events.flatMap(e => e.kind === 'noteGroup' && (e.notes.some(n => n.techniques.length || n.audio) || e.tremoloBar || e.fade || e.rasgueado)
        ? [loss('techniques/audio', e.id, '주법과 오디오 미세 조정은 MusicXML 출력에서 생략됩니다.')] : []) : [])))),
    ...(score.chords.length || score.diagrams.length || score.automations.length ? [loss('chords/diagrams/automation', score.id, '코드 다이어그램과 자동화는 출력에서 생략됩니다.')] : []),
    ...(score.measures.some(m => m.jumps.length) ? [loss('jumps', score.id, '진행 지시기호는 생략됩니다. 반복 마디와 엔딩은 보존됩니다.')] : []),
  ];
}
export function exportMusicXml(document: ScoreDocument, compressed = false): Uint8Array {
  const score = parseScoreDocument(document);
  const divisions = divisionsFor(score);
  const list = score.tracks.map((t, i) => {
    const pitches = [...new Set(t.staves.flatMap(s => s.voices.flatMap(v => v.bars.flatMap(b =>
      b.kind === 'active' ? b.events.flatMap(e => e.kind === 'noteGroup' ? e.notes.flatMap(n => n.kind === 'percussion' ? [n.midi] : []) : []) : []))))];
    const instruments = pitches.length ? pitches.map(midi => ({ id: `I${i + 1}N${midi}`, midi })) : [{ id: `I${i + 1}`, midi: null }];
    return `<score-part id="P${i + 1}"><part-name>${escapeXml(t.name)}</part-name>` +
      instruments.map(n => `<score-instrument id="${n.id}"><instrument-name>${escapeXml(t.name)}</instrument-name></score-instrument>`).join('') +
      instruments.map(n => `<midi-instrument id="${n.id}"><midi-channel>${n.midi === null ? i % 16 + 1 : 10}</midi-channel><midi-program>${t.instrument.program + 1}</midi-program>${n.midi === null ? '' : `<midi-unpitched>${n.midi + 1}</midi-unpitched>`}</midi-instrument>`).join('') + '</score-part>';
  }).join('');
  const parts = score.tracks.map((track, ti) => `<part id="P${ti + 1}">${score.measures.map((m, mi) => {
    const pickup = mi === 0 && Number(m.actualSpanQ.n) / Number(m.actualSpanQ.d) < m.meter.beats * 4 / m.meter.unit;
    const body: string[] = [attributes(m, track, divisions)];
    for (const tempo of m.tempoEvents) body.push(`<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo.bpm}</per-minute></metronome></direction-type><offset>${units(tempo.offsetQ, divisions)}</offset><sound tempo="${tempo.bpm}"/></direction>`);
    if (m.repeats.start || m.endings.length) body.push(`<barline location="left">${m.endings.length ? `<ending number="${m.endings.join(',')}" type="start"/>` : ''}${m.repeats.start ? '<repeat direction="forward"/>' : ''}</barline>`);
    let first = true;
    for (const [si, staff] of track.staves.entries()) for (const voice of staff.voices) {
      const bar = voice.bars[mi];
      if (!bar || bar.kind === 'inactive') continue;
      if (!first) body.push(`<backup><duration>${units(m.actualSpanQ, divisions)}</duration></backup>`);
      first = false;
      for (const event of bar.events) body.push(noteXml(event, { staff, number: si + 1, voice: voice.number, measure: m, trackNumber: ti + 1 }, { score, divisions }));
    }
    if (m.repeats.totalPlays || m.endings.length) body.push(`<barline location="right">${m.endings.length ? `<ending number="${m.endings.join(',')}" type="stop"/>` : ''}${m.repeats.totalPlays ? `<repeat direction="backward" times="${m.repeats.totalPlays}"/>` : ''}</barline>`);
    return `<measure number="${mi + 1}"${pickup ? ' implicit="yes"' : ''}>${body.join('')}</measure>`;
  }).join('')}</part>`).join('');
  const bytes = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${escapeXml(score.metadata.title)}</work-title></work><part-list>${list}</part-list>${parts}</score-partwise>`);
  return compressed ? packMxl(bytes) : bytes;
}
