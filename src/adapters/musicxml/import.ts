import type { Measure, ScoreEvent, Staff, Track, VoiceLane } from '../../domain/document';
import { newId } from '../../domain/ids';
import { addQ, compareQ, rationalQ, subtractQ, zeroQ } from '../../domain/rational';
import type { RationalQ } from '../../domain/rational';
import { silence } from '../../domain/commands/duration';
import type { CompatibilityDiagnostic } from '../alphatab/compatibility';
import { child, children, decimal, InterchangeError, number, parseXml, quarterTime, text } from './xml';
import type { XmlElement } from './xml';
import { unpackMxl } from './archive';
import { emptyScore, importedProject, loss } from './project';
import { readNote, xmlPitch } from './notes';
import type { Relations } from './notes';

type Positioned = { readonly start: RationalQ; readonly span: RationalQ; readonly event: ScoreEvent };
function descendant(node: XmlElement, name: string): readonly XmlElement[] {
  return [...children(node, name), ...node.children.flatMap(item => descendant(item, name))];
}
function measureAttributes(node: XmlElement, previous: Measure | undefined): Measure {
  const attributes = child(node, 'attributes'), time = attributes ? child(attributes, 'time') : undefined;
  const key = attributes ? child(attributes, 'key') : undefined;
  const beats = time ? number(text(time, 'beats'), { min: 1, max: 128, integer: true }) : previous?.meter.beats ?? 4;
  const unit = time ? number(text(time, 'beat-type'), { min: 1, max: 1024, integer: true }) : previous?.meter.unit ?? 4;
  const repeats = descendant(node, 'repeat');
  const backward = repeats.find(r => r.attributes['direction'] === 'backward');
  const endings = descendant(node, 'ending').filter(e => e.attributes['type'] === 'start');
  return { id: newId('measure'), meter: { beats, unit }, actualSpanQ: rationalQ(BigInt(beats * 4), BigInt(unit)),
    key: { fifths: key ? number(text(key, 'fifths'), { min: -7, max: 7, integer: true }) : previous?.key.fifths ?? 0,
      mode: key ? text(key, 'mode') === 'minor' ? 'minor' : 'major' : previous?.key.mode ?? 'major' },
    tempoEvents: [], repeats: { start: repeats.some(r => r.attributes['direction'] === 'forward'),
      ...(backward ? { totalPlays: number(backward.attributes['times'] ?? '2', { min: 2, max: 100, integer: true }) } : {}) },
    endings: endings.flatMap(e => (e.attributes['number'] ?? '').split(',').map(n => number(n.trim(), { min: 1, max: 100, integer: true }))), jumps: [] };
}
function staffInfo(part: XmlElement, index: number): Pick<Staff, 'tuning' | 'capo' | 'clef'> {
  const details = descendant(part, 'staff-details').find(d => Number(d.attributes['number'] ?? 1) === index + 1);
  const tunings = details ? children(details, 'staff-tuning') : [];
  const tuning = tunings.length ? [...tunings].sort((a, b) => Number(b.attributes['line']) - Number(a.attributes['line'])).map(t =>
    xmlPitch({ ...t, children: t.children.map(c => ({ ...c, name: c.name.replace('tuning-', '') })) })) :
    descendant(part, 'technical').some(t => child(t, 'string')) ? [64, 59, 55, 50, 45, 40] : [];
  const clef = descendant(part, 'clef').find(c => Number(c.attributes['number'] ?? 1) === index + 1);
  const sign = clef ? text(clef, 'sign') : 'G';
  return { tuning, capo: details && child(details, 'capo') ? number(text(details, 'capo'), { min: 0, max: 24, integer: true }) : 0,
    clef: sign === 'F' ? 'bass' : sign === 'percussion' ? 'percussion' : sign === 'C' ? 'alto' : 'treble' };
}
export async function importMusicXml(bytes: Uint8Array, name: string) {
  const compressed = name.toLowerCase().endsWith('.mxl');
  const root = parseXml(compressed ? await unpackMxl(bytes) : bytes);
  if (root.name !== 'score-partwise' || root.attributes['version'] !== '4.0') throw new InterchangeError('FORMAT', 'MusicXML partwise 4.0 문서가 필요합니다.');
  const work = child(root, 'work');
  let score = emptyScore(work ? text(work, 'work-title') : text(root, 'movement-title'));
  const relations: Relations = { ties: [], lyrics: [], tuplets: [], openTies: new Map(), openTuplets: new Map() };
  const diagnostics: CompatibilityDiagnostic[] = [];
  const list = child(root, 'part-list');
  const parts = children(root, 'part');
  if (!parts.length || parts.length > 128) throw new InterchangeError('LIMIT', 'Part count must be 1–128');
  const tracks: Track[] = [], measures: Measure[] = [];
  for (const [partIndex, part] of parts.entries()) {
    const definitions = list ? children(list, 'score-part').filter(p => p.attributes['id'] === part.attributes['id']) : [];
    const definition = definitions[0];
    if (!definition || definitions.length !== 1) throw new InterchangeError('STRUCTURE', 'Missing or duplicate score-part');
    const xmlMeasures = children(part, 'measure');
    if (!xmlMeasures.length || xmlMeasures.length > 10000 || (partIndex > 0 && xmlMeasures.length !== measures.length)) throw new InterchangeError('STRUCTURE', 'Part measure counts differ or exceed limits');
    const staffCount = Math.max(1, ...descendant(part, 'staves').map(n => number(n.text, { min: 1, max: 8, integer: true })));
    const staffSettings = Array.from({ length: staffCount }, (_, index) => staffInfo(part, index));
    const percussion = new Map(children(definition, 'midi-instrument').filter(n => child(n, 'midi-unpitched'))
      .map(n => [n.attributes['id'] ?? '', number(text(n, 'midi-unpitched'), { min: 1, max: 128, integer: true }) - 1]));
    const kind = percussion.size || staffSettings.some(s => s.clef === 'percussion') ? 'percussion' : staffSettings.some(s => s.tuning.length) ? 'fretted' : 'pitched';
    const lanes = new Map<string, Positioned[][]>();
    let divisions: RationalQ | undefined;
    for (const [mi, xmlMeasure] of xmlMeasures.entries()) {
      const parsed = measureAttributes(xmlMeasure, measures[mi - 1]);
      const measure = partIndex === 0 ? parsed : measures[mi];
      if (!measure) throw new InterchangeError('STRUCTURE', 'Missing global measure');
      if (partIndex === 0) measures.push(measure);
      else if (parsed.meter.beats !== measure.meter.beats || parsed.meter.unit !== measure.meter.unit) throw new InterchangeError('STRUCTURE', 'Polymeter cannot share the global measure grid');
      let cursor = zeroQ;
      for (const node of xmlMeasure.children) {
        switch (node.name) {
          case 'attributes': {
            const d = child(node, 'divisions');
            if (d) {
              divisions = decimal(d.text);
              if (compareQ(divisions, zeroQ) <= 0) throw new InterchangeError('STRUCTURE', 'divisions must be positive');
            }
            break;
          }
          case 'backup': case 'forward': {
            if (!divisions) throw new InterchangeError('STRUCTURE', 'divisions must precede durations');
            const span = quarterTime(text(node, 'duration'), divisions);
            if (compareQ(span, zeroQ) <= 0) throw new InterchangeError('STRUCTURE', 'Backup/forward duration must be positive');
            cursor = node.name === 'backup' ? subtractQ(cursor, span) : addQ(cursor, span);
            if (compareQ(cursor, zeroQ) < 0) throw new InterchangeError('STRUCTURE', 'Backup precedes measure');
            break;
          }
          case 'note': {
            if (!divisions) throw new InterchangeError('STRUCTURE', 'divisions must precede notes');
            const staffNumber = number(text(node, 'staff') || '1', { min: 1, max: staffCount, integer: true });
            const voice = number(text(node, 'voice') || '1', { min: 1, max: 4, integer: true });
            const lane = `${staffNumber}/${voice}`, staff = staffSettings[staffNumber - 1];
            if (!staff) throw new InterchangeError('STRUCTURE', 'Missing staff');
            let bars = lanes.get(lane);
            if (!bars) { bars = xmlMeasures.map(() => []); lanes.set(lane, bars); }
            const events = bars[mi];
            if (!events) throw new InterchangeError('STRUCTURE', 'Missing voice bar');
            const result = readNote(node, { divisions, staff, instrument: kind, lane: `${partIndex}/${lane}`, relations, percussion });
            if (child(node, 'chord')) {
              const previous = events.at(-1);
              if (!previous || previous.event.kind !== 'noteGroup' || result.event.kind !== 'noteGroup' || compareQ(previous.span, result.span) !== 0) throw new InterchangeError('STRUCTURE', 'Invalid chord member');
              events[events.length - 1] = { ...previous, event: { ...previous.event, notes: [...previous.event.notes, ...result.event.notes] } };
              for (const lyric of relations.lyrics) if (lyric.eventId === result.event.id) throw new InterchangeError('STRUCTURE', 'Lyrics must be attached to chord head');
            } else { events.push({ ...result, start: cursor }); cursor = addQ(cursor, result.span); }
            break;
          }
          case 'direction': {
            const sound = child(node, 'sound'), tempo = sound?.attributes['tempo'];
            if (tempo && partIndex === 0) {
              const offset = child(node, 'offset');
              if (offset && !divisions) throw new InterchangeError('STRUCTURE', 'divisions must precede offset');
              const position = offset && divisions ? addQ(cursor, quarterTime(offset.text, divisions)) : cursor;
              measures[mi] = { ...measure, tempoEvents: [...(measures[mi]?.tempoEvents ?? []),
                { offsetQ: position, bpm: number(tempo, { min: 10, max: 400 }), transition: 'step' }] };
            }
            break;
          }
          case 'barline': break;
          default: diagnostics.push(loss(node.name, `${partIndex + 1}/${mi + 1}`, '이 MusicXML 항목은 편집 사본에 매핑되지 않습니다.'));
        }
      }
      const occupied = [...lanes.values()].flatMap(b => b[mi] ?? []).reduce((max, e) => compareQ(addQ(e.start, e.span), max) > 0 ? addQ(e.start, e.span) : max, zeroQ);
      if (mi === 0 && xmlMeasure.attributes['implicit'] === 'yes' && compareQ(occupied, measure.actualSpanQ) < 0 && compareQ(occupied, zeroQ) > 0 && partIndex === 0) measures[mi] = { ...measures[mi] ?? measure, actualSpanQ: occupied };
      if (compareQ(occupied, measure.actualSpanQ) > 0) throw new InterchangeError('STRUCTURE', 'Measure overflows its meter');
    }
    score = { ...score, measures, tuplets: relations.tuplets };
    const staves: Staff[] = staffSettings.map((settings, si) => ({ ...settings, id: newId('staff'),
      voices: ([1, 2, 3, 4] as const).map((number): VoiceLane => ({ id: newId('voice'), number,
        bars: measures.map((measure, mi) => {
          const positioned = lanes.get(`${si + 1}/${number}`)?.[mi];
          if (!positioned?.length) return { kind: 'inactive', measureId: measure.id };
          let cursor = zeroQ;
          const events: ScoreEvent[] = [];
          for (const p of positioned) {
            if (compareQ(p.start, cursor) < 0) throw new InterchangeError('STRUCTURE', 'Overlapping notes in one voice');
            events.push(...silence(score, subtractQ(p.start, cursor)), p.event);
            cursor = addQ(p.start, p.span);
          }
          events.push(...silence(score, subtractQ(measure.actualSpanQ, cursor)));
          return { kind: 'active', measureId: measure.id, events };
        }) })) }));
    const instrument = child(definition, 'midi-instrument');
    tracks.push({ id: newId('track'), name: text(definition, 'part-name'), instrument: { kind,
      program: instrument && child(instrument, 'midi-program') ? number(text(instrument, 'midi-program'), { min: 1, max: 128, integer: true }) - 1 : 0, bank: 0 }, staves });
  }
  if (relations.openTies.size || relations.openTuplets.size) throw new InterchangeError('STRUCTURE', 'Unclosed tie or tuplet');
  for (const tag of ['ornaments', 'articulations', 'dynamics', 'harmony', 'transpose', 'print', 'appearance', 'slur', 'bend', 'hammer-on', 'pull-off']) {
    for (const node of descendant(root, tag)) { void node; diagnostics.push(loss(tag, name, '이 표현은 원본 바이트에만 보존됩니다.')); }
  }
  score = { ...score, measures, tracks, ties: relations.ties, tuplets: relations.tuplets, lyrics: relations.lyrics };
  return importedProject(score, { bytes, name, extension: compressed ? 'mxl' : 'musicxml', format: 'MusicXML 4.0' }, diagnostics);
}
