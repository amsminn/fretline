import { assertNever } from '../diagnostics';
import type { ScoreDocument, Staff } from '../document';
import { soundingPitch } from '../event-time';
import type { StaffId } from '../ids';
import type { Note } from '../notation';
import { reject } from './core';

export type TuningEdit = {
  readonly kind: 'tuning';
  readonly staffId: StaffId;
  readonly tuning: readonly number[];
  readonly capo: number;
  readonly policy: 'preservePitch' | 'preserveFingering';
};
export function editTuning(doc: ScoreDocument, edit: TuningEdit): ScoreDocument {
  const track = doc.tracks.find(t => t.staves.some(s => s.id === edit.staffId)) ?? reject(edit.staffId, 'Staff no longer exists');
  if (track.instrument.kind !== 'fretted') reject(edit.staffId, 'Only fretted instruments have tuning and capo');
  if (!edit.tuning.length || edit.tuning.some(p => !Number.isInteger(p) || p < 0 || p > 127) ||
    !Number.isInteger(edit.capo) || edit.capo < 0 || edit.capo > 36) reject(edit.staffId, 'Tuning requires MIDI pitches and capo 0..36');
  const retune = (staff: Staff): Staff => {
    if (staff.id !== edit.staffId) return staff;
    const mapNote = (note: Note): Note => {
      switch (note.kind) {
        case 'fretted': {
          const open = edit.tuning[note.string - 1];
          if (open === undefined) return reject(note.id, 'Removing an occupied string requires explicit revoicing');
          let fret: number;
          switch (edit.policy) {
            case 'preservePitch': fret = soundingPitch(note, staff) - open - edit.capo; break;
            case 'preserveFingering': fret = note.fret; break;
            default: return assertNever(edit.policy);
          }
          if (fret < 0 || fret > 99 || open + edit.capo + fret > 127) {
            return reject(note.id, 'Tuning cannot preserve this note on its string; choose another tuning or revoice first');
          }
          return { ...note, fret };
        }
        case 'pitched':
        case 'percussion': return reject(note.id, 'Note does not belong to a fretted instrument');
        default: return assertNever(note);
      }
    };
    return { ...staff, tuning: [...edit.tuning], capo: edit.capo, voices: staff.voices.map(voice => ({
      ...voice, bars: voice.bars.map(bar => {
        switch (bar.kind) {
          case 'inactive': return bar;
          case 'active': return { ...bar, events: bar.events.map(event => {
            switch (event.kind) {
              case 'noteGroup': return { ...event, notes: event.notes.map(mapNote) };
              case 'rest':
              case 'spacer': return event;
              default: return assertNever(event);
            }
          }) };
          default: return assertNever(bar);
        }
      }),
    })) };
  };
  return { ...doc, tracks: doc.tracks.map(t => t.id === track.id ? { ...t, staves: t.staves.map(retune) } : t) };
}
