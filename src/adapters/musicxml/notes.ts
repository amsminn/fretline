import type { Duration, Note, ScoreDocument, ScoreEvent, Staff } from '../../domain/document';
import { assertNever } from '../../domain/diagnostics';
import type { NoteId } from '../../domain/ids';
import { newId } from '../../domain/ids';
import { compareQ, durationQ, zeroQ } from '../../domain/rational';
import type { RationalQ } from '../../domain/rational';
import { child, children, InterchangeError, number, quarterTime, text } from './xml';
import type { XmlElement } from './xml';
import { noteTypes, tupletMembership } from './tuplets';
import type { ImportedTuplet } from './tuplets';

export const pitchSteps = new Map([['C', 0], ['D', 2], ['E', 4], ['F', 5], ['G', 7], ['A', 9], ['B', 11]]);
// Import-local accumulators resolve relation IDs before the immutable document boundary.
export type Relations = {
  readonly ties: ScoreDocument['ties'][number][]; readonly lyrics: ScoreDocument['lyrics'][number][];
  readonly tuplets: ScoreDocument['tuplets'][number][]; readonly openTies: Map<string, NoteId>;
  readonly openTuplets: Map<string, ImportedTuplet[]>;
};
export type NoteContext = {
  readonly divisions: RationalQ; readonly staff: Pick<Staff, 'tuning' | 'capo'>;
  readonly instrument: 'fretted' | 'pitched' | 'percussion'; readonly lane: string; readonly relations: Relations;
  readonly percussion: ReadonlyMap<string, number>;
};
export function xmlPitch(node: XmlElement): number {
  const step = pitchSteps.get(text(node, 'step'));
  if (step === undefined) throw new InterchangeError('STRUCTURE', 'Unknown pitch step');
  return (number(text(node, 'octave'), { min: 0, max: 9, integer: true }) + 1) * 12 + step +
    (child(node, 'alter') ? number(text(node, 'alter'), { min: -2, max: 2, integer: true }) : 0);
}
export function readNote(node: XmlElement, context: NoteContext): { readonly event: ScoreEvent; readonly span: RationalQ } {
  const { relations, lane } = context;
  const id = newId('event'), grace = child(node, 'grace');
  const span = grace ? zeroQ : quarterTime(text(node, 'duration'), context.divisions);
  if (!grace && compareQ(span, zeroQ) <= 0) throw new InterchangeError('STRUCTURE', 'Note duration must be positive');
  if (child(node, 'rest')?.attributes['measure'] === 'yes') {
    return { event: { id, kind: 'rest', duration: 'fullMeasure' }, span };
  }
  const modification = child(node, 'time-modification');
  const ratio = modification ? {
    actual: number(text(modification, 'actual-notes'), { min: 1, max: 1024, integer: true }),
    normal: number(text(modification, 'normal-notes'), { min: 1, max: 1024, integer: true }),
  } : undefined;
  const dots = children(node, 'dot').length;
  let base = noteTypes.get(text(node, 'type'));
  if (!base) {
    for (const candidate of noteTypes.values()) if (compareQ(durationQ({ base: candidate, dots }, ratio ? [ratio] : []), span) === 0) { base = candidate; break; }
  }
  if (!base || (!grace && compareQ(durationQ({ base, dots }, ratio ? [ratio] : []), span) !== 0)) {
    throw new InterchangeError('STRUCTURE', 'Written note type does not match duration / divisions');
  }
  const tupletIds = tupletMembership(node, { id, lane, span, base, ratio }, relations);
  const duration: Duration = { base, dots, tupletIds };
  if (child(node, 'rest')) return { event: { id, kind: 'rest', duration }, span };
  const pitch = child(node, 'pitch'), unpitched = child(node, 'unpitched');
  const notations = child(node, 'notations'), technical = notations ? child(notations, 'technical') : undefined;
  let note: Note;
  switch (context.instrument) {
    case 'fretted': {
      if (!technical || !pitch) throw new InterchangeError('STRUCTURE', 'Fretted notes require pitch and technical string/fret');
      const string = number(text(technical, 'string'), { min: 1, max: context.staff.tuning.length, integer: true });
      const fret = number(text(technical, 'fret'), { min: 0, max: 48, integer: true });
      if ((context.staff.tuning[string - 1] ?? -1000) + context.staff.capo + fret !== xmlPitch(pitch)) {
        throw new InterchangeError('STRUCTURE', 'Pitch differs from technical string/fret and tuning');
      }
      note = { id: newId('note'), kind: 'fretted', string, fret, techniques: [] }; break;
    }
    case 'pitched':
      if (!pitch) throw new InterchangeError('STRUCTURE', 'Pitched note requires pitch');
      note = { id: newId('note'), kind: 'pitched', midi: xmlPitch(pitch), techniques: [] }; break;
    case 'percussion': {
      if (!unpitched) throw new InterchangeError('STRUCTURE', 'Percussion note requires unpitched');
      const instrument = child(node, 'instrument')?.attributes['id'];
      const midi = instrument ? context.percussion.get(instrument) : context.percussion.size === 1 ? context.percussion.values().next().value : undefined;
      if (midi === undefined) throw new InterchangeError('STRUCTURE', 'Percussion note requires an unambiguous midi-unpitched instrument');
      note = { id: newId('note'), kind: 'percussion', midi, articulation: String(midi), techniques: [] }; break;
    }
    default: return assertNever(context.instrument);
  }
  const key = `${lane}/${note.kind === 'fretted' ? `${note.string}/${note.fret}` : note.midi}`;
  for (const tie of children(node, 'tie').filter(t => t.attributes['type'] === 'stop')) {
    void tie;
    const from = relations.openTies.get(key);
    if (!from) throw new InterchangeError('STRUCTURE', 'Tie stop without matching start');
    relations.ties.push({ id: newId('tie'), from, to: note.id }); relations.openTies.delete(key);
  }
  if (children(node, 'tie').some(t => t.attributes['type'] === 'start')) {
    if (relations.openTies.has(key)) throw new InterchangeError('STRUCTURE', 'Duplicate tie start');
    relations.openTies.set(key, note.id);
  }
  for (const lyric of children(node, 'lyric')) {
    const syllabic = text(lyric, 'syllabic') || 'single';
    if (syllabic !== 'single' && syllabic !== 'begin' && syllabic !== 'middle' && syllabic !== 'end') throw new InterchangeError('STRUCTURE', 'Unknown lyric syllabic');
    relations.lyrics.push({ id: newId('lyric'), eventId: id, verse: number(lyric.attributes['number'] ?? '1', { min: 1, max: 100, integer: true }),
      text: text(lyric, 'text'), syllabic, extend: child(lyric, 'extend') !== undefined });
  }
  return { event: { id, kind: 'noteGroup', duration, notes: [note],
    ...(grace ? { grace: { kind: grace.attributes['steal-time-following'] ? 'onBeat' as const : 'beforeBeat' as const, slash: grace.attributes['slash'] === 'yes' } } : {}) }, span };
}
