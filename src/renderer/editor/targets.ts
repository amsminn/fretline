import { barSlotId, barSlots } from '../../domain/bar-slot';
import type { BarSlotLocation } from '../../domain/bar-slot';
import { assertNever } from '../../domain/diagnostics';
import type { Duration, ScoreDocument } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { EventLocation } from '../../domain/event-time';
import { compareQ, durationQ, subtractQ } from '../../domain/rational';
import type { Selection, SelectionPoint } from '../../domain/selection';

export type EditTarget =
  | (EventLocation & { readonly kind: 'event' })
  | (BarSlotLocation & { readonly kind: 'barSlot'; readonly voiceId: BarSlotLocation['voice']['id'] });
export type EntryCursor = { readonly string: number; readonly duration: Duration };
export const quarterDuration: Duration = { base: 4, dots: 0, tupletIds: [] };
const targets = new WeakMap<ScoreDocument, readonly EditTarget[]>();

export function editTargets(doc: ScoreDocument): readonly EditTarget[] {
  const cached = targets.get(doc);
  if (cached) return cached;
  const events: EditTarget[] = [...indexDocument(doc).events.values()].map(location => ({ ...location, kind: 'event' }));
  const result = [...events, ...barSlots(doc).map(location => ({ ...location, kind: 'barSlot' as const, voiceId: location.voice.id }))]
    .sort((a, b) => compareQ(a.startQ, b.startQ));
  if (Object.isFrozen(doc)) targets.set(doc, result);
  return result;
}
export function targetPoint(target: EditTarget): SelectionPoint {
  const time = { startQ: target.startQ, endQ: target.endQ };
  switch (target.kind) {
    case 'event': return { ...time, eventId: target.event.id };
    case 'barSlot': return { ...time, barSlot: target.barSlot };
    default: return assertNever(target);
  }
}
export function targetId(target: EditTarget): string {
  switch (target.kind) {
    case 'event': return target.event.id;
    case 'barSlot': return barSlotId(target.barSlot);
    default: return assertNever(target);
  }
}
export function focusedTarget(doc: ScoreDocument, selection: Selection): EditTarget | undefined {
  const point = selection.focus;
  return editTargets(doc).find(target => {
    switch (target.kind) {
      case 'event': return target.event.id === (point.eventId ?? selection.anchor.eventId);
      case 'barSlot': return point.barSlot && barSlotId(target.barSlot) === barSlotId(point.barSlot);
      default: return assertNever(target);
    }
  });
}
export function entryCursor(doc: ScoreDocument, selection: Selection, string: number): EntryCursor {
  switch (selection.kind) {
    case 'barSlot': return { string: selection.string, duration: selection.duration };
    case 'caret': case 'noteSet': case 'timeRange': {
      const target = focusedTarget(doc, selection);
      return { string, duration: target?.kind === 'event' && target.event.duration !== 'fullMeasure'
        ? { ...target.event.duration, tupletIds: [] } : quarterDuration };
    }
    default: return assertNever(selection);
  }
}
export function selectTarget(doc: ScoreDocument, target: EditTarget, cursor: EntryCursor): Selection {
  const track = doc.tracks.find(track => track.staves.some(staff => staff.id === target.staff.id));
  const voice = target.staff.voices.find(voice => voice.id === target.voiceId);
  const scope = { trackIds: track ? [track.id] : [], staffIds: [target.staff.id], voices: voice ? [voice.number] : [] };
  const string = Math.min(cursor.string, Math.max(1, target.staff.tuning.length));
  switch (target.kind) {
    case 'barSlot': {
      const point = { barSlot: target.barSlot, startQ: target.startQ, endQ: target.endQ };
      let duration = cursor.duration;
      // A pickup shorter than the current entry unit starts with a fitting binary unit.
      while (compareQ(durationQ(duration), subtractQ(target.endQ, target.startQ)) > 0 && duration.base < 1024) {
        duration = { base: duration.base * 2, dots: 0, tupletIds: [] };
      }
      return { kind: 'barSlot', scope, anchor: point, focus: point, string, duration };
    }
    case 'event': {
      const point = targetPoint(target);
      const note = target.event.kind === 'noteGroup'
        ? target.event.notes.find(note => note.kind === 'fretted' && note.string === string) : undefined;
      return note ? { kind: 'noteSet', scope, anchor: point, focus: point, noteIds: [note.id] }
        : { kind: 'caret', scope, anchor: point, focus: point };
    }
    default: return assertNever(target);
  }
}
