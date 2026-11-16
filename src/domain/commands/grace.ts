import type { ScoreDocument } from '../document';
import { newId } from '../ids';
import type { EventId } from '../ids';
import { reject, updateEvents } from './core';

export type GraceEdit = {
  readonly kind: 'grace';
  readonly eventIds: readonly EventId[];
  readonly placement: 'beforeBeat' | 'onBeat';
};
/** Insert a separately editable grace chord without consuming the main beat. */
export function insertGrace(doc: ScoreDocument, edit: GraceEdit): ScoreDocument {
  const found = new Set<EventId>();
  const inserted = new Map<EventId, EventId>();
  const next = updateEvents(doc, event => {
    if (!edit.eventIds.includes(event.id)) return [event];
    found.add(event.id);
    if (event.kind !== 'noteGroup' || event.grace) reject(event.id, 'Grace insertion requires a main note');
    const id = newId('event');
    inserted.set(event.id, id);
    return [{ kind: 'noteGroup', id, duration: { base: 16, dots: 0, tupletIds: event.duration.tupletIds },
      notes: event.notes.map(note => ({ ...note, id: newId('note'), techniques: [] })),
      grace: { kind: edit.placement, slash: true } }, event];
  });
  if (found.size !== new Set(edit.eventIds).size) reject('grace', 'A selected event no longer exists');
  return { ...next, tuplets: next.tuplets.map(t => ({ ...t, eventIds: t.eventIds.flatMap(id => {
    const graceId = inserted.get(id);
    return graceId ? [graceId, id] : [id];
  }) })) };
}
