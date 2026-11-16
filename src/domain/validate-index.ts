import type { ScoreDocument, Track } from './document';
import type { DocumentIndex, EventLocation } from './event-time';
import { eventDurationQ } from './event-time';
import type { EventId, MeasureId, NoteId } from './ids';
import type { Note } from './notation';
import { addQ, zeroQ } from './rational';
import type { RationalQ } from './rational';
import { assertNever, DomainError } from './diagnostics';
import { schemaContext } from './schema/context';
import { scoreSchema } from './schema/score';

// A read-only union avoids copying every event/note map after a one-track edit.
// Global ID validation runs first, so keys in different partitions cannot overlap.
class PartitionedMap<K, V> implements ReadonlyMap<K, V> {
  readonly size: number;
  readonly [Symbol.toStringTag] = 'Map';
  constructor(private readonly parts: readonly ReadonlyMap<K, V>[]) {
    this.size = parts.reduce((sum, part) => sum + part.size, 0);
  }
  get(key: K): V | undefined {
    for (const part of this.parts) {
      const value = part.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }
  has(key: K): boolean { return this.parts.some(part => part.has(key)); }
  *entries(): MapIterator<[K, V]> { for (const part of this.parts) yield* part.entries(); }
  *keys(): MapIterator<K> { for (const part of this.parts) yield* part.keys(); }
  *values(): MapIterator<V> { for (const part of this.parts) yield* part.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
}

type TrackIndex = {
  readonly measures: ScoreDocument['measures'];
  readonly tuplets: ScoreDocument['tuplets'];
  readonly index: DocumentIndex;
};
const tracks = new WeakMap<Track, TrackIndex>();
const roots = new WeakMap<ScoreDocument, DocumentIndex>();

export function validationIndex(doc: ScoreDocument): DocumentIndex {
  const cached = roots.get(doc);
  if (cached) return cached;
  const context = schemaContext(scoreSchema);
  const immutableDependencies = context.hasImmutableCertificate(doc.measures) && context.hasImmutableCertificate(doc.tuplets);
  const starts = new Map<MeasureId, RationalQ>();
  let writtenQ = zeroQ;
  for (const measure of doc.measures) {
    starts.set(measure.id, writtenQ);
    writtenQ = addQ(writtenQ, measure.actualSpanQ);
  }
  const measures = new Map(doc.measures.map(measure => [measure.id, measure]));
  const parts = doc.tracks.map(track => {
    const previous = tracks.get(track);
    if (previous?.measures === doc.measures && previous.tuplets === doc.tuplets) return previous.index;
    const events = new Map<EventId, EventLocation>();
    const notes = new Map<NoteId, { readonly note: Note; readonly location: EventLocation }>();
    for (const staff of track.staves) for (const voice of staff.voices) for (const bar of voice.bars) {
      switch (bar.kind) {
        case 'inactive': break;
        case 'active': {
          const measure = measures.get(bar.measureId);
          let startQ = starts.get(bar.measureId);
          if (!measure || !startQ) throw new DomainError([{ code: 'REFERENCE', path: voice.id, message: 'Missing measure' }]);
          for (const event of bar.events) {
            const endQ = addQ(startQ, eventDurationQ(event, measure.actualSpanQ, doc));
            const location = { event, voiceId: voice.id, measureId: bar.measureId, startQ, endQ, staff };
            events.set(event.id, location);
            switch (event.kind) {
              case 'noteGroup':
                for (const note of event.notes) notes.set(note.id, { note, location });
                break;
              case 'rest': case 'spacer': break;
              default: assertNever(event);
            }
            startQ = endQ;
          }
          break;
        }
        default: assertNever(bar);
      }
    }
    const index = { events, notes };
    if (immutableDependencies && context.hasImmutableCertificate(track)) tracks.set(track, { measures: doc.measures, tuplets: doc.tuplets, index });
    return index;
  });
  const index = { events: new PartitionedMap(parts.map(part => part.events)), notes: new PartitionedMap(parts.map(part => part.notes)) };
  if (context.hasImmutableCertificate(doc)) roots.set(doc, index);
  return index;
}
