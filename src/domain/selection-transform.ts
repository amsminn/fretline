import { assertNever } from './diagnostics';
import type { ScoreDocument } from './document';
import { indexDocument } from './event-time';
import { addQ, compareQ, subtractQ, zeroQ } from './rational';
import type { RationalQ } from './rational';
import type { Selection, SelectionPoint } from './selection';
import { barSlots, resolveBarSlot } from './bar-slot';

export function transformSelection(change: { readonly before: ScoreDocument; readonly after: ScoreDocument; readonly selection: Selection }): Selection {
  const { before, after, selection } = change;
  const previous = indexDocument(before);
  const current = indexDocument(after);
  const total = after.measures.reduce((q, m) => addQ(q, m.actualSpanQ), zeroQ);
  function transformTime(time: RationalQ): RationalQ {
    let oldStart = zeroQ;
    for (const measure of before.measures) {
      const oldEnd = addQ(oldStart, measure.actualSpanQ);
      if (compareQ(time, oldEnd) < 0) {
        const position = after.measures.findIndex(m => m.id === measure.id);
        if (position >= 0) return addQ(after.measures.slice(0, position).reduce((q, m) => addQ(q, m.actualSpanQ), zeroQ), subtractQ(time, oldStart));
        const oldIndex = before.measures.indexOf(measure);
        const following = before.measures.slice(oldIndex + 1).find(m => after.measures.some(a => a.id === m.id));
        const nextIndex = following ? after.measures.findIndex(m => m.id === following.id) : after.measures.length;
        return after.measures.slice(0, nextIndex).reduce((q, m) => addQ(q, m.actualSpanQ), zeroQ);
      }
      oldStart = oldEnd;
    }
    return total;
  }
  function point(value: SelectionPoint): SelectionPoint {
    if (value.barSlot) {
      const retained = resolveBarSlot(after, value.barSlot);
      if (retained) return { barSlot: retained.barSlot, startQ: retained.startQ, endQ: retained.endQ };
      const event = [...current.events.values()].find(location =>
        location.voiceId === value.barSlot?.voiceId && location.measureId === value.barSlot.measureId);
      if (event) return { eventId: event.event.id, startQ: event.startQ, endQ: event.endQ };
      const slots = barSlots(after).filter(location => location.voice.id === value.barSlot?.voiceId);
      const next = slots.find(location => compareQ(location.endQ, transformTime(value.startQ)) > 0) ?? slots.at(-1);
      if (next) return { barSlot: next.barSlot, startQ: next.startQ, endQ: next.endQ };
    }
    const retained = value.eventId ? current.events.get(value.eventId) : undefined;
    if (retained) return { eventId: retained.event.id, startQ: retained.startQ, endQ: retained.endQ };
    const startQ = transformTime(value.startQ);
    const endQ = transformTime(value.endQ);
    const old = value.eventId ? previous.events.get(value.eventId) : undefined;
    if (old) {
      const candidates = [...current.events.values()].filter(e => e.voiceId === old.voiceId);
      const next = candidates.find(e => compareQ(e.endQ, startQ) > 0) ?? candidates.at(-1);
      if (next) return { eventId: next.event.id, startQ: next.startQ, endQ: next.endQ };
    }
    return { startQ, endQ: compareQ(endQ, startQ) < 0 ? startQ : endQ };
  }
  const anchor = point(selection.anchor);
  const focus = point(selection.focus);
  const location = anchor.eventId ? current.events.get(anchor.eventId) : undefined;
  const voice = location?.staff.voices.find(v => v.id === location.voiceId);
  const oldLocation = selection.anchor.eventId ? previous.events.get(selection.anchor.eventId) : undefined;
  const scope = voice && oldLocation && location?.voiceId !== oldLocation.voiceId
    ? { ...selection.scope, voices: [voice.number] } : selection.scope;
  switch (selection.kind) {
    case 'barSlot': {
      if (anchor.barSlot) {
        const target = resolveBarSlot(after, anchor.barSlot);
        if (target) {
          const endpoint = { barSlot: target.barSlot, startQ: target.startQ, endQ: target.endQ };
          return { ...selection, anchor: endpoint, focus: endpoint,
            string: Math.min(selection.string, Math.max(1, target.staff.tuning.length)),
            scope: { trackIds: [target.trackId], staffIds: [target.staff.id], voices: [target.voice.number] } };
        }
      }
      return { kind: 'caret', scope, anchor, focus };
    }
    case 'caret': return { kind: 'caret', scope, anchor, focus };
    case 'timeRange':
      if (compareQ(anchor.startQ, anchor.endQ) === 0 && compareQ(focus.startQ, focus.endQ) === 0 &&
        compareQ(anchor.startQ, focus.startQ) === 0) return { kind: 'caret', scope, anchor, focus };
      return { kind: 'timeRange', scope, anchor, focus };
    case 'noteSet': {
      const noteIds = selection.noteIds.filter(id => current.notes.has(id));
      return noteIds.length ? { kind: 'noteSet', scope, anchor, focus, noteIds } : { kind: 'caret', scope, anchor, focus };
    }
    default: return assertNever(selection);
  }
}
