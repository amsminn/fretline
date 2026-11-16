import { assertNever } from '../diagnostics';
import type { Duration, ScoreDocument, ScoreEvent, VoiceBar } from '../document';
import { eventDurationQ, indexDocument } from '../event-time';
import type { EventId, VoiceId } from '../ids';
import { newId } from '../ids';
import { addQ, compareQ, durationQ, subtractQ, zeroQ } from '../rational';
import type { RationalQ } from '../rational';
import { reject, updateVoice } from './core';
import type { Edit } from './core';
import { fragmentEvent, splitRelations, writtenDurations } from './split';

export type SpanReplacement = {
  readonly voiceId: VoiceId;
  readonly startQ: RationalQ;
  readonly endQ: RationalQ;
  readonly events: readonly ScoreEvent[];
  readonly replaceIds: readonly EventId[];
};
export function silence(doc: ScoreDocument, span: RationalQ, tupletIds: Duration['tupletIds'] = []): readonly ScoreEvent[] {
  return writtenDurations(doc, span, tupletIds).map(duration => ({ kind: 'rest', id: newId('event'), duration }));
}
type Positioned = { readonly event: ScoreEvent; readonly startQ: RationalQ; readonly endQ: RationalQ };
export function replaceSpan(doc: ScoreDocument, change: SpanReplacement): ScoreDocument {
  const measures = doc.measures.map((measure, i) => ({
    measure, startQ: doc.measures.slice(0, i).reduce((q, m) => addQ(q, m.actualSpanQ), zeroQ),
  }));
  const total = doc.measures.reduce((q, m) => addQ(q, m.actualSpanQ), zeroQ);
  if (compareQ(change.startQ, zeroQ) < 0 || compareQ(change.endQ, total) > 0 ||
    compareQ(change.startQ, change.endQ) >= 0) reject(change.voiceId, 'Replacement is outside the score');
  const positioned: Positioned[] = [];
  const splitGroups: (readonly ScoreEvent[])[] = [];
  let cursor = change.startQ;
  for (const event of change.events) {
    if (event.duration === 'fullMeasure') reject(event.id, 'Replacement events require explicit written durations');
    const end = addQ(cursor, eventDurationQ(event, zeroQ, doc));
    const boundaries = measures.map(m => m.startQ).filter(q => compareQ(q, cursor) > 0 && compareQ(q, end) < 0);
    let previous = cursor;
    const spans = [...boundaries, end].map(q => { const span = subtractQ(q, previous); previous = q; return span; });
    const fragments = fragmentEvent(doc, event, spans);
    splitGroups.push(fragments);
    for (const fragment of fragments) {
      const fragmentEnd = addQ(cursor, eventDurationQ(fragment, zeroQ, doc));
      positioned.push({ event: fragment, startQ: cursor, endQ: fragmentEnd });
      cursor = fragmentEnd;
    }
  }
  if (compareQ(cursor, change.endQ) !== 0) reject(change.voiceId, 'Replacement must fill its exact span');
  let next = updateVoice(doc, change.voiceId, voice => {
    const bars = voice.bars.map((bar, i): VoiceBar => {
      const boundary = measures[i];
      if (!boundary) return reject(voice.id, 'Missing global measure');
      const barStart = boundary.startQ;
      const barEnd = addQ(barStart, boundary.measure.actualSpanQ);
      if (compareQ(barEnd, change.startQ) <= 0 || compareQ(barStart, change.endQ) >= 0) return bar;
      const start = compareQ(change.startQ, barStart) > 0 ? change.startQ : barStart;
      const end = compareQ(change.endQ, barEnd) < 0 ? change.endQ : barEnd;
      const retained: Positioned[] = [];
      let original: readonly ScoreEvent[];
      switch (bar.kind) {
        case 'inactive': original = [{ kind: 'rest', id: newId('event'), duration: 'fullMeasure' }]; break;
        case 'active': original = bar.events; break;
        default: return assertNever(bar);
      }
      let onset = barStart;
      for (const event of original) {
        const finish = addQ(onset, eventDurationQ(event, boundary.measure.actualSpanQ, doc));
        if (compareQ(finish, start) <= 0 || compareQ(onset, end) >= 0) retained.push({ event, startQ: onset, endQ: finish });
        else {
          switch (event.kind) {
            case 'noteGroup':
              if (!change.replaceIds.includes(event.id)) reject(event.id, 'Collision: replacement consumes sounding material');
              if (compareQ(onset, start) < 0 || compareQ(finish, end) > 0) reject(event.id, 'Replacement must include the entire sounding event');
              break;
            case 'rest': case 'spacer': {
              if (compareQ(onset, start) < 0) {
                const fragments = fragmentEvent(doc, event, [subtractQ(start, onset), subtractQ(finish, start)]);
                let q = onset;
                for (const fragment of fragments) {
                  const to = addQ(q, eventDurationQ(fragment, boundary.measure.actualSpanQ, doc));
                  if (compareQ(to, start) <= 0) retained.push({ event: fragment, startQ: q, endQ: to });
                  q = to;
                }
              }
              if (compareQ(finish, end) > 0) {
                const fragments = fragmentEvent(doc, event, [subtractQ(end, onset), subtractQ(finish, end)]);
                let q = onset;
                for (const fragment of fragments) {
                  const to = addQ(q, eventDurationQ(fragment, boundary.measure.actualSpanQ, doc));
                  if (compareQ(q, end) >= 0) retained.push({ event: fragment, startQ: q, endQ: to });
                  q = to;
                }
              }
              break;
            }
            default: assertNever(event);
          }
        }
        onset = finish;
      }
      const inserted = positioned.filter(e => compareQ(e.startQ, barStart) >= 0 && compareQ(e.startQ, barEnd) < 0);
      const events = [...retained, ...inserted].sort((a, b) => compareQ(a.startQ, b.startQ)).map(e => e.event);
      return { kind: 'active', measureId: bar.measureId, events };
    });
    return { ...voice, bars };
  });
  for (const fragments of splitGroups) next = splitRelations(next, fragments);
  return next;
}
export function changeDuration(doc: ScoreDocument, edit: Extract<Edit, { kind: 'duration' }>): ScoreDocument {
  const found = indexDocument(doc).events.get(edit.eventId);
  if (!found) reject(edit.eventId, 'Event no longer exists');
  const event = { ...found.event, duration: edit.duration };
  const span = durationQ(edit.duration, edit.duration.tupletIds.map(id => doc.tuplets.find(t => t.id === id) ?? reject(id, 'Missing tuplet')));
  if (compareQ(found.startQ, found.endQ) === 0) {
    return updateVoice(doc, found.voiceId, voice => ({ ...voice, bars: voice.bars.map(bar => {
      switch (bar.kind) {
        case 'inactive': return bar;
        case 'active': return bar.events.some(e => e.id === edit.eventId) ? { ...bar, events: bar.events.map(e => e.id === edit.eventId ? event : e) } : bar;
        default: return assertNever(bar);
      }
    }) }));
  }
  const end = addQ(found.startQ, span);
  const shortening = compareQ(end, found.endQ) < 0;
  const padding = shortening ? silence(doc, subtractQ(found.endQ, end), edit.duration.tupletIds) : [];
  const prepared = padding.length && edit.duration.tupletIds.length ? { ...doc, tuplets: doc.tuplets.map(t =>
    edit.duration.tupletIds.includes(t.id) ? { ...t, eventIds: t.eventIds.flatMap(id => id === edit.eventId ? [id, ...padding.map(e => e.id)] : [id]) } : t) } : doc;
  return replaceSpan(prepared, { voiceId: found.voiceId, startQ: found.startQ, endQ: shortening ? found.endQ : end,
    events: [event, ...padding], replaceIds: [edit.eventId] });
}
