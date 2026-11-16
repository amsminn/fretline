import { assertNever, DomainError } from './diagnostics';
import type { ScoreDocument, ScoreEvent } from './document';
import type { EventId, MeasureId, NoteId, VoiceId } from './ids';
import type { Note } from './notation';
import type { Staff } from './document';
import { durationQ, zeroQ } from './rational';
import type { RationalQ } from './rational';
export { validationIndex as indexDocument } from './validate-index';

export type EventLocation = {
  readonly event: ScoreEvent;
  readonly voiceId: VoiceId;
  readonly measureId: MeasureId;
  readonly startQ: RationalQ;
  readonly endQ: RationalQ;
  readonly staff: Staff;
};
export type DocumentIndex = {
  readonly events: ReadonlyMap<EventId, EventLocation>;
  readonly notes: ReadonlyMap<NoteId, { readonly note: Note; readonly location: EventLocation }>;
};
export function eventDurationQ(event: ScoreEvent, spanQ: RationalQ, doc: ScoreDocument): RationalQ {
  switch (event.kind) {
    case 'noteGroup':
      if (event.grace) return zeroQ;
      break;
    case 'rest':
      if (event.duration === 'fullMeasure') return spanQ;
      break;
    case 'spacer': break;
    default: return assertNever(event);
  }
  if (event.duration === 'fullMeasure') return spanQ;
  const ratios = event.duration.tupletIds.map(id => {
    const tuplet = doc.tuplets.find(t => t.id === id);
    if (!tuplet) throw new DomainError([{ code: 'TUPLET', path: event.id, message: `Missing tuplet ${id}` }]);
    return tuplet;
  });
  return durationQ(event.duration, ratios);
}

export function soundingPitch(note: Note, staff: Staff): number {
  switch (note.kind) {
    case 'fretted': {
      const open = staff.tuning[note.string - 1];
      if (open === undefined) throw new DomainError([{ code: 'REFERENCE', path: note.id, message: 'String is outside tuning' }]);
      return open + staff.capo + note.fret;
    }
    case 'pitched':
    case 'percussion': return note.midi;
    default: return assertNever(note);
  }
}
