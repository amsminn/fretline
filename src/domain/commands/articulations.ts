import { assertNever, DomainError } from '../diagnostics';
import type { ScoreDocument } from '../document';
import { indexDocument } from '../event-time';
import type { EventId, NoteId, TrackId, MeasureId } from '../ids';
import { newId } from '../ids';
import type { Note, Technique } from '../notation';
import { compareQ, rationalQ, zeroQ } from '../rational';
import type { RationalQ } from '../rational';
import type { Selection } from '../selection';
import { normalizeSelection } from '../selection';
import { validateScoped } from '../validate-scoped';
import { contentToken, freezeRoot, reject, updateEvents } from './core';
import type { CommandResult } from './core';

export type EventExpression = {
  readonly tremoloBar?: Extract<Technique, { kind: 'bend' }>['points'] | undefined;
  readonly fade?: 'in' | 'out' | 'swell' | undefined;
  readonly brush?: 'up' | 'down' | undefined;
  readonly rasgueado?: string | undefined;
};
export type ArticulationEdit =
  | { readonly kind: 'technique'; readonly noteIds: readonly NoteId[]; readonly technique: Technique }
  | { readonly kind: 'removeTechnique'; readonly noteIds: readonly NoteId[]; readonly techniqueKind: Technique['kind'] }
  | { readonly kind: 'noteAudio'; readonly noteIds: readonly NoteId[]; readonly audio: Note['audio'] }
  | { readonly kind: 'expression'; readonly eventIds: readonly EventId[]; readonly expression: EventExpression }
  | { readonly kind: 'sustain'; readonly trackId: TrackId; readonly measureId: MeasureId; readonly offsetQ: RationalQ; readonly down: boolean }
  | { readonly kind: 'articulationBatch'; readonly edits: readonly ArticulationEdit[] };
export type ArticulationCommand = { readonly expectedToken: string; readonly edit: ArticulationEdit };

// Task-owned extension for the shared feature inventory. Split/copy/delete are
// implemented by split.ts, clipboard.ts and notes.ts; they never mutate a curve.
export const articulationFeatureMap = {
  bend: { split: 'piecewise-linear interpolation; normalize fragment positions', copy: 'exact curve', delete: 'remove with note' },
  tremoloBar: { split: 'piecewise-linear interpolation; normalize fragment positions', copy: 'exact curve', delete: 'remove with event' },
  legato: { split: 'last fragment owns outgoing target', copy: 'remap internal target; omit external target', delete: 'remove incident target' },
  slide: { split: 'incoming on first; outgoing on last', copy: 'remap internal target; omit external target', delete: 'remove incident target' },
  staccato: { split: 'last fragment', copy: 'exact', delete: 'remove with note' },
  attack: { kinds: ['accent', 'heavyAccent', 'pickStroke', 'tap', 'slap', 'pop', 'fingering'], split: 'first fragment', copy: 'exact', delete: 'remove with note' },
  continuous: { kinds: ['harmonic', 'trill', 'tremoloPicking', 'vibrato', 'palmMute', 'letRing', 'dead', 'ghost'], split: 'all fragments', copy: 'exact', delete: 'remove with note' },
  brush: { split: 'first fragment', copy: 'exact', delete: 'remove with event' },
  fade: { split: 'atomic rejection: no authored envelope', copy: 'exact', delete: 'remove with event' },
  rasgueado: { split: 'atomic rejection: no authored envelope', copy: 'exact', delete: 'remove with event' },
  audio: { split: 'atomic rejection: custom timing', copy: 'exact', delete: 'remove with note' },
  sustain: { split: 'retain track/measure offset', copy: 'track automation is outside musical clipboard', delete: 'remove with containing measure or track' },
} as const;

function curve(points: Extract<Technique, { kind: 'bend' }>['points']): void {
  if (points.length < 2 || points.length > 64 || compareQ(points[0]?.position ?? zeroQ, zeroQ) !== 0 ||
    compareQ(points.at(-1)?.position ?? zeroQ, rationalQ(1n)) !== 0) reject('curve', 'Curve needs 2–64 points spanning 0 to 1');
  let previous: RationalQ | undefined;
  for (const point of points) {
    if ((previous && compareQ(point.position, previous) <= 0) || compareQ(point.position, zeroQ) < 0 ||
      compareQ(point.position, rationalQ(1n)) > 0 || compareQ(point.semitones, rationalQ(-12n)) < 0 ||
      compareQ(point.semitones, rationalQ(12n)) > 0) reject('curve', 'Curve positions must increase within [0,1]; pitch must be within ±12 semitones');
    previous = point.position;
  }
}

function checkTechnique(doc: ScoreDocument, noteId: NoteId, technique: Technique): void {
  const index = indexDocument(doc);
  const source = index.notes.get(noteId) ?? reject(noteId, 'Note no longer exists');
  switch (technique.kind) {
    case 'legato':
    case 'slide': {
      if (source.note.kind !== 'fretted') reject(noteId, 'Hammer/pull and slide require a fretted note');
      const targetId = technique.target;
      if (targetId) {
        const target = index.notes.get(targetId) ?? reject(targetId, 'Technique target no longer exists');
        if (target.note.kind !== 'fretted' || target.note.string !== source.note.string ||
          target.location.voiceId !== source.location.voiceId || compareQ(source.location.endQ, target.location.startQ) !== 0 ||
          compareQ(source.location.startQ, target.location.startQ) >= 0 ||
          doc.ties.some(t => t.to === targetId || t.from === noteId)) {
          reject(noteId, 'Technique must connect adjacent attacks on the same string and voice without a tie');
        }
      } else if (technique.kind === 'slide' && (technique.style === 'shift' || technique.style === 'legato')) {
        reject(noteId, 'Shift and legato slides require a destination');
      }
      return;
    }
    case 'bend': curve(technique.points); break;
    case 'harmonic':
      if (compareQ(technique.fret, zeroQ) < 0 || compareQ(technique.fret, rationalQ(36n)) > 0) {
        reject(noteId, 'Harmonic touch fret must be within [0,36]');
      }
      break;
    case 'trill':
    case 'tremoloPicking':
    case 'vibrato':
    case 'pickStroke':
    case 'palmMute':
    case 'letRing':
    case 'staccato':
    case 'accent':
    case 'heavyAccent':
    case 'dead':
    case 'ghost':
    case 'tap':
    case 'slap':
    case 'pop': break;
    case 'fingering':
      if (!['', '0', 'T', '1', '2', '3', '4'].includes(technique.left) ||
        !['', 'p', 'i', 'm', 'a', 'c'].includes(technique.right)) reject(noteId, 'Choose a supported left and right hand finger');
      break;
    default: assertNever(technique);
  }
  if (source.note.kind === 'percussion' && ['bend', 'harmonic', 'trill', 'vibrato'].includes(technique.kind)) {
    reject(noteId, 'Pitched techniques cannot target percussion');
  }
}

function execute(doc: ScoreDocument, edit: ArticulationEdit): ScoreDocument {
  const index = indexDocument(doc);
  switch (edit.kind) {
    case 'articulationBatch':
      if (!edit.edits.length) reject('selection', 'Select at least one note');
      return edit.edits.reduce(execute, doc);
    case 'sustain': {
      const existing = doc.automations.find(a => a.kind === 'sustain' && a.trackId === edit.trackId &&
        a.measureId === edit.measureId && compareQ(a.offsetQ, edit.offsetQ) === 0);
      const automation = { id: existing?.id ?? newId('automation'), kind: 'sustain' as const,
        trackId: edit.trackId, measureId: edit.measureId, offsetQ: edit.offsetQ, value: edit.down ? 1 : 0 };
      return { ...doc, automations: existing ? doc.automations.map(a => a === existing ? automation : a) : [...doc.automations, automation] };
    }
    case 'expression':
      if (!edit.eventIds.length) reject('selection', 'Select a note event');
      if (edit.expression.tremoloBar) curve(edit.expression.tremoloBar);
      for (const id of edit.eventIds) {
        const location = index.events.get(id) ?? reject(id, 'Event no longer exists');
        if (location.event.kind !== 'noteGroup') reject(id, 'Expression requires a note event');
        if (edit.expression.tremoloBar && !doc.tracks.some(t => t.instrument.kind === 'fretted' && t.staves.includes(location.staff))) {
          reject(id, 'Tremolo bar requires a fretted instrument');
        }
      }
      return updateEvents(doc, event => {
        if (!edit.eventIds.includes(event.id)) return [event];
        if (event.kind !== 'noteGroup') return reject(event.id, 'Expression requires a note event');
        const { tremoloBar, fade, brush, rasgueado, ...base } = { ...event, ...edit.expression };
        return [{ ...base, ...(tremoloBar ? { tremoloBar } : {}), ...(fade ? { fade } : {}),
          ...(brush ? { brush } : {}), ...(rasgueado ? { rasgueado } : {}) }];
      });
    case 'technique':
    case 'removeTechnique':
    case 'noteAudio': {
      if (!edit.noteIds.length) reject('selection', 'Select at least one note');
      for (const id of edit.noteIds) {
        if (!index.notes.has(id)) reject(id, 'Note no longer exists');
        if (edit.kind === 'technique') checkTechnique(doc, id, edit.technique);
      }
      return updateEvents(doc, event => {
        switch (event.kind) {
          case 'rest': case 'spacer': return [event];
          case 'noteGroup': {
            if (!event.notes.some(n => edit.noteIds.includes(n.id))) return [event];
            return [{ ...event, notes: event.notes.map((note): Note => {
              if (!edit.noteIds.includes(note.id)) return note;
              switch (edit.kind) {
                case 'technique': return { ...note, techniques: [...note.techniques.filter(t => t.kind !== edit.technique.kind), edit.technique] };
                case 'removeTechnique': return { ...note, techniques: note.techniques.filter(t => t.kind !== edit.techniqueKind) };
                case 'noteAudio': {
                  const { audio, ...base } = note;
                  return edit.audio ? { ...base, audio: edit.audio } : audio ? base : note;
                }
                default: return assertNever(edit);
              }
            }) }];
          }
          default: return assertNever(event);
        }
      });
    }
    default: return assertNever(edit);
  }
}

/** One immutable publication, including multi-note edits and all rejection paths. */
export function applyArticulationCommand(doc: ScoreDocument, command: ArticulationCommand, selection: Selection): CommandResult {
  if (command.expectedToken !== contentToken(doc)) return { kind: 'rejected', diagnostics: [
    { code: 'REFERENCE', path: 'expectedToken', message: 'Stale articulation command: document changed' },
  ] };
  try {
    freezeRoot(doc);
    normalizeSelection(selection);
    const nextDoc = freezeRoot(execute(doc, command.edit));
    const diagnostics = validateScoped(doc, nextDoc);
    if (diagnostics.length) return { kind: 'rejected', diagnostics };
    return { kind: 'applied', nextDoc: freezeRoot(nextDoc), nextSelection: selection, diagnostics: [] };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { kind: 'rejected', diagnostics: error.diagnostics };
  }
}
