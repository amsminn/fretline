import { assertNever } from '../diagnostics';
import type { Duration, ScoreDocument, ScoreEvent } from '../document';
import { indexDocument } from '../event-time';
import { newId } from '../ids';
import type { Note, Technique } from '../notation';
import { addQ, compareQ, durationQ, multiplyQ, rationalQ, subtractQ, zeroQ } from '../rational';
import type { RationalQ } from '../rational';
import { reject, updateEvents } from './core';
import type { Edit } from './core';

export function writtenDurations(doc: ScoreDocument, span: RationalQ, tupletIds: Duration['tupletIds'] = []): readonly Duration[] {
  const ratios = tupletIds.map(id => {
    const tuplet = doc.tuplets.find(t => t.id === id);
    return tuplet ?? reject(id, 'Missing tuplet ratio');
  });
  const choices: { readonly duration: Duration; readonly span: RationalQ }[] = [];
  for (let base = 1; base <= 1024; base *= 2) for (let dots = 0; dots <= 8; dots++) {
    const duration = { base, dots, tupletIds };
    choices.push({ duration, span: durationQ(duration, ratios) });
  }
  choices.sort((a, b) => compareQ(b.span, a.span));
  const result: Duration[] = [];
  let remaining = span;
  while (compareQ(remaining, zeroQ) > 0) {
    const choice = choices.find(c => compareQ(c.span, remaining) <= 0);
    if (!choice || result.length >= 4096) reject('duration', 'Span is not representable with the authored tuplet ratios and binary durations');
    result.push(choice.duration);
    remaining = subtractQ(remaining, choice.span);
  }
  if (compareQ(remaining, zeroQ) < 0) reject('duration', 'Duration must be positive');
  return result;
}
export function expandFullRest(doc: ScoreDocument, event: ScoreEvent, span: RationalQ): readonly ScoreEvent[] {
  if (event.duration !== 'fullMeasure') return [event];
  return writtenDurations(doc, span).map((duration, i) => i === 0
    ? { ...event, kind: 'rest', duration } : { kind: 'rest', id: newId('event'), duration });
}
type Curve = readonly { readonly position: RationalQ; readonly semitones: RationalQ }[];
function divide(a: RationalQ, b: RationalQ): RationalQ {
  return multiplyQ(a, rationalQ(BigInt(b.d), BigInt(b.n)));
}
function sliceCurve(points: Curve, start: RationalQ, end: RationalQ): Curve {
  function at(position: RationalQ): RationalQ {
    const first = points[0];
    if (!first) return zeroQ;
    if (compareQ(position, first.position) <= 0) return first.semitones;
    let previous = first;
    for (const next of points.slice(1)) {
      if (compareQ(position, next.position) <= 0) {
        if (compareQ(next.position, previous.position) === 0) return next.semitones;
        return addQ(previous.semitones, multiplyQ(subtractQ(next.semitones, previous.semitones),
          divide(subtractQ(position, previous.position), subtractQ(next.position, previous.position))));
      }
      previous = next;
    }
    return previous.semitones;
  }
  return [{ position: zeroQ, semitones: at(start) },
    ...points.filter(p => compareQ(p.position, start) > 0 && compareQ(p.position, end) < 0)
      .map(p => ({ ...p, position: divide(subtractQ(p.position, start), subtractQ(end, start)) })),
    { position: rationalQ(1n), semitones: at(end) }];
}
function fragmentTechniques(techniques: readonly Technique[], bounds: { readonly start: RationalQ; readonly end: RationalQ }): readonly Technique[] {
  const first = compareQ(bounds.start, zeroQ) === 0;
  const last = compareQ(bounds.end, rationalQ(1n)) === 0;
  return techniques.flatMap((t): readonly Technique[] => {
    switch (t.kind) {
      case 'bend': return [{ ...t, points: sliceCurve(t.points, bounds.start, bounds.end) }];
      case 'legato': return last ? [t] : [];
      case 'slide':
        switch (t.style) {
          case 'inAbove': case 'inBelow': return first ? [t] : [];
          case 'shift': case 'legato': case 'outUp': case 'outDown': return last ? [t] : [];
          default: return assertNever(t);
        }
      case 'staccato': return last ? [t] : [];
      case 'accent': case 'heavyAccent': case 'pickStroke': case 'tap': case 'slap': case 'pop': case 'fingering': return first ? [t] : [];
      case 'harmonic': case 'trill': case 'tremoloPicking': case 'vibrato': case 'palmMute':
      case 'letRing': case 'dead': case 'ghost': return [t];
      default: return assertNever(t);
    }
  });
}
export function fragmentEvent(doc: ScoreDocument, event: ScoreEvent, spans: readonly RationalQ[]): readonly ScoreEvent[] {
  if (spans.length === 1) return [event];
  if (event.fade || event.rasgueado) reject(event.id, 'Split requires an explicit envelope for fade or rasgueado');
  const tupletIds = event.duration === 'fullMeasure' ? [] : event.duration.tupletIds;
  const durations = spans.flatMap(span => writtenDurations(doc, span, tupletIds));
  const ratios = doc.tuplets.filter(t => tupletIds.includes(t.id));
  const total = spans.reduce(addQ, zeroQ);
  let elapsed = zeroQ;
  return durations.map((duration, i): ScoreEvent => {
    const start = divide(elapsed, total);
    elapsed = addQ(elapsed, durationQ(duration, ratios));
    const end = divide(elapsed, total);
    const fields = { id: i === 0 ? event.id : newId('event'), duration,
      ...(i === 0 && event.annotations ? { annotations: event.annotations } : {}),
      ...(i === 0 && event.dynamics ? { dynamics: event.dynamics } : {}),
      ...(event.tremoloBar ? { tremoloBar: sliceCurve(event.tremoloBar, start, end) } : {}) };
    switch (event.kind) {
      case 'rest': return { ...fields, kind: 'rest' };
      case 'spacer': return { ...fields, kind: 'spacer' };
      case 'noteGroup':
        if (event.grace) reject(event.id, 'Grace events have no occupied span to split');
        return { ...fields, kind: 'noteGroup',
          ...(i === 0 && event.arpeggio ? { arpeggio: event.arpeggio } : {}),
          ...(i === 0 && event.brush ? { brush: event.brush } : {}),
          notes: event.notes.map((note): Note => {
            if (note.audio) reject(note.id, 'Split requires removing the custom audio timing override first');
            return { ...note, id: i === 0 ? note.id : newId('note'), techniques: fragmentTechniques(note.techniques, { start, end }) };
          }) };
      default: return assertNever(event);
    }
  });
}
export function splitRelations(doc: ScoreDocument, fragments: readonly ScoreEvent[]): ScoreDocument {
  const first = fragments[0];
  const last = fragments.at(-1);
  if (!first || !last || fragments.length < 2) return doc;
  const tuplets = doc.tuplets.map(t => t.eventIds.includes(first.id)
    ? { ...t, eventIds: t.eventIds.flatMap(id => id === first.id ? fragments.map(e => e.id) : [id]) } : t);
  switch (first.kind) {
    case 'rest': case 'spacer': return { ...doc, tuplets };
    case 'noteGroup': {
      if (last.kind !== 'noteGroup') return reject(first.id, 'Mixed fragment kinds');
      const outgoing = new Map(first.notes.map((n, i) => [n.id, last.notes[i]?.id ?? n.id]));
      const ties = doc.ties.map(t => outgoing.has(t.from) ? { ...t, from: outgoing.get(t.from) ?? t.from } : t);
      for (let i = 1; i < fragments.length; i++) {
        const before = fragments[i - 1];
        const after = fragments[i];
        if (before?.kind !== 'noteGroup' || after?.kind !== 'noteGroup') reject(first.id, 'Mixed fragment kinds');
        before.notes.forEach((note, n) => {
          const to = after.notes[n];
          if (!to) reject(note.id, 'Missing continuation note');
          ties.push({ id: newId('tie'), from: note.id, to: to.id });
        });
      }
      return { ...doc, tuplets, ties };
    }
    default: return assertNever(first);
  }
}
export function splitCommand(doc: ScoreDocument, edit: Extract<Edit, { kind: 'split' }>): ScoreDocument {
  const location = indexDocument(doc).events.get(edit.eventId);
  if (!location) reject(edit.eventId, 'Event no longer exists');
  const span = subtractQ(location.endQ, location.startQ);
  if (compareQ(edit.atQ, zeroQ) <= 0 || compareQ(edit.atQ, span) >= 0) reject(edit.eventId, 'Split must be strictly inside the event');
  const fragments = fragmentEvent(doc, location.event, [edit.atQ, subtractQ(span, edit.atQ)]);
  return splitRelations(updateEvents(doc, event => event.id === edit.eventId ? fragments : [event]), fragments);
}
