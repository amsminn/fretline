import type { model } from '@coderline/alphatab';
import type { EventId, MeasureId, NoteId, StaffId, TrackId, VoiceId } from '../../domain/ids';

/** Snapshot-local engine objects never become document identities. */
export class ProjectionIdentity {
  readonly events = new Map<EventId, model.Beat>();
  readonly notes = new Map<NoteId, model.Note>();
  readonly eventIds = new Map<number, EventId>();
  readonly noteIds = new Map<number, NoteId>();
  readonly tracks = new Map<TrackId, model.Track>();
  readonly staves = new Map<StaffId, model.Staff>();
  readonly measures = new Map<MeasureId, model.MasterBar>();
  readonly voices = new Map<VoiceId, readonly model.Voice[]>();

  addEvent(id: EventId, beat: model.Beat): void {
    this.events.set(id, beat);
    this.eventIds.set(beat.id, id);
  }

  addNote(id: NoteId, note: model.Note): void {
    this.notes.set(id, note);
    this.noteIds.set(note.id, id);
  }
}
