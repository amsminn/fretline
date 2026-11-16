import type { ScoreDocument, ScoreEvent, Tuplet } from '../document';
import { eventDurationQ, indexDocument } from '../event-time';
import { newId } from '../ids';
import type { EventId } from '../ids';
import { addQ, compareQ, durationQ, subtractQ, zeroQ } from '../rational';
import { reject } from './core';
import { replaceSpan, silence } from './duration';

export type TupletEdit = {
  readonly kind: 'tuplet';
  readonly eventIds: readonly EventId[];
  readonly actual: number;
  readonly normal: number;
  readonly unit: number;
};

/** Authored units, rather than event count, determine mixed-duration membership. */
export function createTuplet(doc: ScoreDocument, edit: TupletEdit): ScoreDocument {
  if (![edit.actual, edit.normal, edit.unit].every(n => Number.isSafeInteger(n) && n > 0) ||
    edit.actual > 128 || edit.normal > 128 || edit.unit > 1024 || (edit.unit & (edit.unit - 1)) !== 0) {
    reject('tuplet', 'Use positive ratios up to 128 and a binary unit up to 1024');
  }
  const index = indexDocument(doc);
  const members = edit.eventIds.map(id => index.events.get(id) ?? reject(id, 'Tuplet event no longer exists'));
  const first = members[0];
  const last = members.at(-1);
  if (!first || !last || new Set(edit.eventIds).size !== edit.eventIds.length) reject('tuplet', 'Select a complete contiguous group');
  if (first.event.duration === 'fullMeasure') reject(first.event.id, 'Choose explicit durations before creating a tuplet');
  const ancestors = first.event.duration.tupletIds;
  const parentId = ancestors.at(-1);
  let previous = first.startQ;
  for (const member of members) {
    if (member.voiceId !== first.voiceId || compareQ(member.startQ, previous) !== 0 ||
      member.event.duration === 'fullMeasure' || compareQ(member.startQ, member.endQ) === 0 ||
      member.event.duration.tupletIds.length !== ancestors.length ||
      member.event.duration.tupletIds.some((id, i) => id !== ancestors[i])) {
      reject(member.event.id, 'Select contiguous non-grace events in one voice at the same tuplet depth');
    }
    previous = member.endQ;
  }
  const ratios = ancestors.map(id => doc.tuplets.find(t => t.id === id) ?? reject(id, 'Missing ancestor'));
  const expected = durationQ({ base: edit.unit, dots: 0 }, [...ratios, { actual: 1, normal: edit.actual }]);
  const before = subtractQ(last.endQ, first.startQ);
  if (compareQ(before, expected) !== 0) reject('tuplet', 'Incomplete group: selected written durations must fill actual × unit');
  const group: Tuplet = { id: newId('tuplet'), actual: edit.actual, normal: edit.normal, unit: edit.unit,
    eventIds: edit.eventIds, ...(parentId ? { parentId } : {}) };
  let prepared = { ...doc, tuplets: [...doc.tuplets, group] };
  const events: ScoreEvent[] = members.map(({ event }): ScoreEvent => {
    if (event.duration === 'fullMeasure') return reject(event.id, 'Explicit duration required');
    return { ...event, duration: { ...event.duration, tupletIds: [...ancestors, group.id] } };
  });
  const after = events.reduce((sum, event) => addQ(sum, eventDurationQ(event, zeroQ, prepared)), zeroQ);
  const shorter = compareQ(after, before) < 0;
  // Preserve outer occupancy when nesting; the new silence belongs to ancestors, not the child.
  const padding = shorter ? silence(prepared, subtractQ(before, after), ancestors) : [];
  prepared = { ...prepared, tuplets: prepared.tuplets.map(t => ancestors.includes(t.id)
    ? { ...t, eventIds: t.eventIds.flatMap(id => id === last.event.id ? [id, ...padding.map(e => e.id)] : [id]) } : t) };
  return replaceSpan(prepared, { voiceId: first.voiceId, startQ: first.startQ,
    endQ: addQ(first.startQ, shorter ? before : after), events: [...events, ...padding], replaceIds: edit.eventIds });
}
