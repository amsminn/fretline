import { assertNever, DomainError } from '../diagnostics';
import type { Layout, Note, ScoreDocument, Staff } from '../document';
import type { EventId, MeasureId, NoteId, StaffId } from '../ids';
import type { Selection } from '../selection';
import { normalizeSelection } from '../selection';
import { validateScoped } from '../validate-scoped';
import { contentToken, freezeRoot, reject, updateEvents } from './core';
import type { CommandResult } from './core';

export type NotationMode = NonNullable<Staff['notationMode']>;
export type PitchedSpelling = NonNullable<Extract<Note, { readonly kind: 'pitched' }>['spelling']>;
export type SpellingMode = 'sharp' | 'flat' | 'auto';
export type SpacingEntry = { readonly eventId: EventId; readonly width: number | null };
/** Every layout override names a domain identity, so re-layout, undo and track moves keep it attached to the same music. */
export type LayoutEdit =
  | { readonly kind: 'notationMode'; readonly staffIds: readonly StaffId[]; readonly mode: NotationMode }
  | { readonly kind: 'clef'; readonly staffIds: readonly StaffId[]; readonly clef: Staff['clef'] }
  | { readonly kind: 'spelling'; readonly noteIds: readonly NoteId[]; readonly mode: SpellingMode }
  | { readonly kind: 'courtesyAccidental'; readonly noteIds: readonly NoteId[]; readonly courtesy: boolean }
  | { readonly kind: 'stylesheet'; readonly stylesheet: Partial<Layout['stylesheet']> }
  | { readonly kind: 'view'; readonly view: NonNullable<Layout['view']> }
  | { readonly kind: 'scale'; readonly scale: number }
  | { readonly kind: 'systemBreak'; readonly measureId: MeasureId; readonly enabled: boolean }
  | { readonly kind: 'eventSpacing'; readonly entries: readonly SpacingEntry[] }
  | { readonly kind: 'layoutBatch'; readonly edits: readonly LayoutEdit[] };
export type LayoutCommand = { readonly expectedToken: string; readonly edit: LayoutEdit };

export const scaleLimits = { min: 0.5, max: 2, step: 0.1 } as const;
export const spacingLimits = { min: 8, max: 600 } as const;
const steps = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'] as const;
const sharpAlter = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0] as const;
const flatSteps = ['C', 'D', 'D', 'E', 'E', 'F', 'G', 'G', 'A', 'A', 'B', 'B'] as const;
const flatAlter = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0] as const;

/** Enharmonic spelling of a MIDI pitch; `auto` follows the key-neutral sharp convention alphaTab uses. */
export function spellMidi(midi: number, mode: SpellingMode): Omit<PitchedSpelling, 'courtesy'> {
  const index = ((midi % 12) + 12) % 12;
  const step = mode === 'flat' ? flatSteps[index] : steps[index];
  const alter = mode === 'flat' ? flatAlter[index] : sharpAlter[index];
  if (step === undefined || alter === undefined) throw new RangeError('Pitch class index out of range');
  return { step, alter, octave: Math.floor(midi / 12) - 1 };
}

function updateStaves(doc: ScoreDocument, staffIds: readonly StaffId[], transform: (staff: Staff) => Staff): ScoreDocument {
  const pending = new Set(staffIds);
  const tracks = doc.tracks.map(track => {
    const staves = track.staves.map(staff => {
      if (!pending.has(staff.id)) return staff;
      pending.delete(staff.id);
      return transform(staff);
    });
    return staves.every((s, i) => s === track.staves[i]) ? track : { ...track, staves };
  });
  if (pending.size) reject([...pending][0] ?? 'staff', 'Staff no longer exists');
  return { ...doc, tracks };
}
function updateNotes(doc: ScoreDocument, noteIds: readonly NoteId[], transform: (note: Note) => Note): ScoreDocument {
  const pending = new Set(noteIds);
  if (!pending.size) reject('noteIds', '음표를 선택하세요.');
  const next = updateEvents(doc, event => {
    if (event.kind !== 'noteGroup' || !event.notes.some(note => pending.has(note.id))) return [event];
    const notes = event.notes.map(note => {
      if (!pending.has(note.id)) return note;
      pending.delete(note.id);
      return transform(note);
    });
    return [{ ...event, notes }];
  });
  if (pending.size) reject([...pending][0] ?? 'note', 'Note no longer exists');
  return next;
}
const pitchedOnly = (note: Note, describe: string): Extract<Note, { readonly kind: 'pitched' }> => {
  switch (note.kind) {
    case 'pitched': return note;
    case 'fretted':
    case 'percussion': return reject(note.id, `${describe}: 표준 기보 음높이 음표(pitched)에서만 바꿀 수 있습니다.`);
    default: return assertNever(note);
  }
};

function execute(doc: ScoreDocument, edit: LayoutEdit): ScoreDocument {
  switch (edit.kind) {
    case 'notationMode':
      if (!edit.staffIds.length) reject('staffIds', '보표를 선택하세요.');
      return updateStaves(doc, edit.staffIds, staff => staff.notationMode === edit.mode ? staff : { ...staff, notationMode: edit.mode });
    case 'clef':
      if (!edit.staffIds.length) reject('staffIds', '보표를 선택하세요.');
      return updateStaves(doc, edit.staffIds, staff => staff.clef === edit.clef ? staff : { ...staff, clef: edit.clef });
    case 'spelling':
      return updateNotes(doc, edit.noteIds, note => {
        const pitched = pitchedOnly(note, '이명동음 철자');
        const spelling = { ...spellMidi(pitched.midi, edit.mode), ...(pitched.spelling?.courtesy ? { courtesy: true } : {}) };
        return { ...pitched, spelling };
      });
    case 'courtesyAccidental':
      return updateNotes(doc, edit.noteIds, note => {
        const pitched = pitchedOnly(note, '보조 임시표');
        const { step, alter, octave } = pitched.spelling ?? spellMidi(pitched.midi, 'auto');
        return { ...pitched, spelling: edit.courtesy ? { step, alter, octave, courtesy: true } : { step, alter, octave } };
      });
    case 'stylesheet': {
      const stylesheet = { ...doc.layout.stylesheet, ...edit.stylesheet };
      if (!stylesheet.fontFamily.trim()) reject('stylesheet.fontFamily', '글꼴 이름을 입력하세요.');
      if (!Number.isFinite(stylesheet.fontSize) || stylesheet.fontSize < 6 || stylesheet.fontSize > 48) reject('stylesheet.fontSize', '글꼴 크기는 6~48px입니다.');
      if (!stylesheet.showTab && !stylesheet.showStandard) reject('stylesheet', '탭과 표준 기보 중 하나는 표시해야 합니다.');
      return { ...doc, layout: { ...doc.layout, stylesheet } };
    }
    case 'view': return doc.layout.view === edit.view ? doc : { ...doc, layout: { ...doc.layout, view: edit.view } };
    case 'scale': {
      if (!Number.isFinite(edit.scale) || edit.scale < scaleLimits.min || edit.scale > scaleLimits.max) reject('layout.scale', `배율은 ${scaleLimits.min * 100}%~${scaleLimits.max * 100}%입니다.`);
      const scale = Math.round(edit.scale * 100) / 100;
      return scale === doc.layout.scale ? doc : { ...doc, layout: { ...doc.layout, scale } };
    }
    case 'systemBreak': {
      if (!doc.measures.some(m => m.id === edit.measureId)) reject(edit.measureId, 'Measure no longer exists');
      const without = doc.layout.systemBreaks.filter(id => id !== edit.measureId);
      const order = new Map(doc.measures.map((m, i) => [m.id, i]));
      const systemBreaks = edit.enabled ? [...without, edit.measureId].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)) : without;
      return { ...doc, layout: { ...doc.layout, systemBreaks } };
    }
    case 'eventSpacing': {
      if (!edit.entries.length) reject('eventSpacing', '박을 선택하세요.');
      const touched = new Map(edit.entries.map(entry => [entry.eventId, entry.width]));
      for (const [eventId, width] of touched) {
        if (width !== null && (!Number.isFinite(width) || width < spacingLimits.min || width > spacingLimits.max)) reject(eventId, `박 간격은 ${spacingLimits.min}~${spacingLimits.max}px입니다.`);
      }
      const kept = (doc.layout.eventSpacing ?? []).filter(entry => !touched.has(entry.eventId));
      const added = edit.entries.flatMap(entry => entry.width === null ? [] : [{ eventId: entry.eventId, width: entry.width }]);
      const eventSpacing = [...kept, ...added];
      return { ...doc, layout: eventSpacing.length ? { ...doc.layout, eventSpacing } : Object.fromEntries(Object.entries(doc.layout).filter(([key]) => key !== 'eventSpacing')) as Layout };
    }
    case 'layoutBatch': return edit.edits.reduce(execute, doc);
    default: return assertNever(edit);
  }
}

/** Layout and notation edits never move or rename music, so the selection survives unchanged. */
export function applyLayoutCommand(doc: ScoreDocument, command: LayoutCommand, selection: Selection): CommandResult {
  if (command.expectedToken !== contentToken(doc)) return { kind: 'rejected', diagnostics: [
    { code: 'REFERENCE', path: 'expectedToken', message: 'Stale layout command: document root changed' },
  ] };
  try {
    freezeRoot(doc);
    normalizeSelection(selection);
    const nextDoc = execute(doc, command.edit);
    const diagnostics = validateScoped(doc, nextDoc);
    if (diagnostics.length) return { kind: 'rejected', diagnostics };
    return { kind: 'applied', nextDoc: freezeRoot(nextDoc), nextSelection: freezeRoot(selection), diagnostics: [] };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { kind: 'rejected', diagnostics: error.diagnostics };
  }
}
