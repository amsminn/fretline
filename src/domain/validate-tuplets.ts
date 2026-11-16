import type { Diagnostic } from './diagnostics';
import { assertNever } from './diagnostics';
import type { ScoreDocument, ScoreEvent } from './document';
import type { EventId, VoiceId } from './ids';
import { addQ, compareQ, durationQ, zeroQ } from './rational';
import { eventDurationQ } from './event-time';

export type TupletScope = { readonly voices: ReadonlySet<VoiceId>; readonly previousEvents: ReadonlySet<EventId> };
export function validateTuplets(doc: ScoreDocument, scope?: TupletScope): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const events = new Map<EventId, { readonly event: ScoreEvent; readonly lane: string; readonly order: number }>();
  for (const track of doc.tracks) for (const staff of track.staves) for (const voice of staff.voices) {
    if (scope && !scope.voices.has(voice.id)) continue;
    let order = 0;
    for (const bar of voice.bars) {
      switch (bar.kind) {
        case 'inactive': break;
        case 'active':
          for (const event of bar.events) events.set(event.id, { event, lane: voice.id, order: order++ });
          break;
        default: assertNever(bar);
      }
    }
  }
  // Unchanged tuplets cannot move between lanes without touching a member lane.
  // Callers invalidate the entire tuplet phase when the relation array changes.
  const affected = scope ? doc.tuplets.filter(t => t.eventIds.some(id => events.has(id) || scope.previousEvents.has(id))) : doc.tuplets;
  const tuplets = new Map(doc.tuplets.map(t => [t.id, t]));
  const reject = (path: string, message: string): void => { diagnostics.push({ code: 'TUPLET', path, message }); };
  for (const { event } of events.values()) {
    if (event.duration === 'fullMeasure') continue;
    let parentId: string | undefined;
    for (const id of event.duration.tupletIds) {
      const tuplet = tuplets.get(id);
      if (!tuplet || !tuplet.eventIds.includes(event.id)) reject(event.id, 'Tuplet membership must be reciprocal');
      else if (tuplet.parentId !== parentId) reject(event.id, 'Tuplet membership must follow the complete outer-to-inner parent chain');
      parentId = id;
    }
  }
  for (const tuplet of affected) {
    const parent = tuplet.parentId ? tuplets.get(tuplet.parentId) : undefined;
    if (tuplet.parentId && (!parent || parent.id === tuplet.id || tuplet.eventIds.some(id => !parent.eventIds.includes(id)))) {
      reject(tuplet.id, 'Parent tuplet must contain every nested member');
    }
    let previous: { readonly lane: string; readonly order: number } | undefined;
    for (const id of tuplet.eventIds) {
      const member = events.get(id);
      if (!member || member.event.duration === 'fullMeasure' || !member.event.duration.tupletIds.includes(tuplet.id)) {
        reject(tuplet.id, 'Missing event or reciprocal duration membership');
        continue;
      }
      if (previous && (member.lane !== previous.lane || member.order !== previous.order + 1)) {
        reject(tuplet.id, 'Tuplet members must be contiguous in one voice and authored order');
      }
      previous = member;
    }
  }
  if (diagnostics.length) return diagnostics;
  for (const tuplet of affected) {
    const firstId = tuplet.eventIds[0];
    const first = firstId ? events.get(firstId) : undefined;
    if (!first || first.event.duration === 'fullMeasure') continue;
    const ancestorIds = first.event.duration.tupletIds.slice(0, first.event.duration.tupletIds.indexOf(tuplet.id));
    const ancestors = ancestorIds.flatMap(id => {
      const ancestor = tuplets.get(id);
      return ancestor ? [ancestor] : [];
    });
    const expected = durationQ({ base: tuplet.unit, dots: 0 }, [...ancestors, { actual: 1, normal: tuplet.normal }]);
    let span = zeroQ;
    for (const id of tuplet.eventIds) {
      const member = events.get(id);
      if (member) span = addQ(span, eventDurationQ(member.event, zeroQ, doc));
    }
    if (compareQ(span, expected) !== 0) reject(tuplet.id, 'Tuplet members do not fill the authored ratio and unit');
  }
  return diagnostics;
}
