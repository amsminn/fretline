import { assertNever } from '../diagnostics';
import type { Measure, ScoreDocument, ScoreEvent, VoiceBar } from '../document';
import { eventDurationQ } from '../event-time';
import type { MeasureId } from '../ids';
import { newId } from '../ids';
import { addQ, compareQ, rationalQ, subtractQ, zeroQ } from '../rational';
import type { RationalQ } from '../rational';
import { reject } from './core';
import { silence } from './duration';
import { expandFullRest, fragmentEvent, splitRelations } from './split';

export type RebarEdit = {
  readonly kind: 'rebar';
  readonly meter?: Measure['meter'];
  readonly measureIds?: readonly MeasureId[];
};
export type SpanEdit = {
  readonly kind: 'measureSpan';
  readonly measureId: MeasureId;
  readonly spanQ: RationalQ;
  readonly freeTime: boolean;
};
export type Overflow = { readonly measureId: MeasureId; readonly occupiedQ: RationalQ; readonly nominalQ: RationalQ };
export function overfullMeasures(doc: ScoreDocument): readonly Overflow[] {
  return doc.measures.flatMap(m => {
    const nominalQ = rationalQ(BigInt(m.meter.beats) * 4n, BigInt(m.meter.unit));
    return compareQ(m.actualSpanQ, nominalQ) > 0 ? [{ measureId: m.id, occupiedQ: m.actualSpanQ, nominalQ }] : [];
  });
}

/** A meter change repartitions the complete timeline; import repair splits only marked source bars. */
export function rebar(doc: ScoreDocument, edit: RebarEdit): ScoreDocument {
  const meter = edit.meter;
  if (meter && (!Number.isSafeInteger(meter.beats) || meter.beats < 1 || meter.beats > 64 ||
    !Number.isSafeInteger(meter.unit) || meter.unit < 1 || meter.unit > 64 || (meter.unit & (meter.unit - 1)) !== 0)) {
    reject('meter', 'Meter requires 1..64 beats and a binary denominator up to 64');
  }
  let total = zeroQ;
  const sources = doc.measures.map(measure => {
    const startQ = total;
    total = addQ(total, measure.actualSpanQ);
    return { measure, startQ, endQ: total };
  });
  const firstSource = sources[0] ?? reject('rebar', 'Score has no measures');
  const regions = meter ? [{ startQ: zeroQ, endQ: total, meter, split: true }] : sources.map(s => ({
    startQ: s.startQ, endQ: s.endQ, meter: s.measure.meter, split: !edit.measureIds || edit.measureIds.includes(s.measure.id),
  }));
  const bounds: { readonly startQ: RationalQ; readonly endQ: RationalQ; readonly meter: Measure['meter'] }[] = [];
  for (const region of regions) {
    const nominal = rationalQ(BigInt(region.meter.beats) * 4n, BigInt(region.meter.unit));
    let start = region.startQ;
    while (compareQ(start, region.endQ) < 0) {
      const next = addQ(start, nominal);
      const end = region.split && compareQ(next, region.endQ) < 0 ? next : region.endQ;
      bounds.push({ startQ: start, endQ: end, meter: region.meter });
      start = end;
    }
  }
  // Control instructions and key/ending transitions cannot be moved off their authored boundary.
  for (const [i, source] of sources.entries()) {
    const prior = sources[i - 1]?.measure ?? firstSource.measure;
    const startControl = source.measure.repeats.start || source.measure.section ||
      source.measure.jumps.some(j => j.kind === 'segno' || j.kind === 'coda') ||
      source.measure.key.fifths !== prior.key.fifths || source.measure.key.mode !== prior.key.mode ||
      JSON.stringify(source.measure.endings) !== JSON.stringify(prior.endings);
    const endControl = source.measure.repeats.totalPlays || source.measure.jumps.some(j => j.kind !== 'segno' && j.kind !== 'coda');
    if ((startControl && !bounds.some(b => compareQ(b.startQ, source.startQ) === 0)) ||
      (endControl && !bounds.some(b => compareQ(b.endQ, source.endQ) === 0))) {
      reject(source.measure.id, 'Rebar would move a repeat, direction, section, key or ending boundary; choose an aligned meter');
    }
  }
  const rows = bounds.map(bound => {
    const source = sources.findLast(s => compareQ(s.startQ, bound.startQ) <= 0) ?? firstSource;
    const startSource = sources.find(s => compareQ(s.startQ, bound.startQ) === 0);
    const endSource = sources.find(s => compareQ(s.endQ, bound.endQ) === 0);
    const span = subtractQ(bound.endQ, bound.startQ);
    const nominal = rationalQ(BigInt(bound.meter.beats) * 4n, BigInt(bound.meter.unit));
    const measure: Measure = {
      id: startSource?.measure.id ?? newId('measure'), meter: bound.meter, actualSpanQ: span,
      freeTime: compareQ(span, nominal) !== 0, key: source.measure.key, endings: source.measure.endings,
      tempoEvents: sources.flatMap(s => s.measure.tempoEvents.map(t => ({ ...t, offsetQ: addQ(s.startQ, t.offsetQ) })))
        .filter(t => compareQ(t.offsetQ, bound.startQ) >= 0 && compareQ(t.offsetQ, bound.endQ) < 0)
        .map(t => ({ ...t, offsetQ: subtractQ(t.offsetQ, bound.startQ) })),
      repeats: { start: startSource?.measure.repeats.start ?? false,
        ...(endSource?.measure.repeats.totalPlays ? { totalPlays: endSource.measure.repeats.totalPlays } : {}) },
      jumps: [...(startSource?.measure.jumps.filter(j => j.kind === 'segno' || j.kind === 'coda') ?? []),
        ...(endSource?.measure.jumps.filter(j => j.kind !== 'segno' && j.kind !== 'coda') ?? [])],
      ...(startSource?.measure.section ? { section: startSource.measure.section } : {}),
    };
    return { ...bound, measure };
  });
  const fragments: (readonly ScoreEvent[])[] = [];
  const tracks = doc.tracks.map(track => ({ ...track, staves: track.staves.map(staff => ({
    ...staff, voices: staff.voices.map(voice => {
      const buckets: { active: boolean; readonly events: ScoreEvent[] }[] = rows.map(() => ({ active: false, events: [] }));
      for (const [i, bar] of voice.bars.entries()) {
        const original = sources[i] ?? reject(voice.id, 'Missing global measure');
        let onset = original.startQ;
        let sourceEvents: readonly ScoreEvent[];
        switch (bar.kind) {
          case 'active': sourceEvents = bar.events; break;
          case 'inactive': sourceEvents = [{ kind: 'rest', id: newId('event'), duration: 'fullMeasure' }]; break;
          default: return assertNever(bar);
        }
        for (const source of sourceEvents) {
          for (const event of expandFullRest(doc, source, original.measure.actualSpanQ)) {
            const end = addQ(onset, eventDurationQ(event, original.measure.actualSpanQ, doc));
            const boundaries = rows.map(t => t.startQ).filter(q => compareQ(q, onset) > 0 && compareQ(q, end) < 0);
            let previous = onset;
            const spans = [...boundaries, end].map(q => { const span = subtractQ(q, previous); previous = q; return span; });
            const pieces = fragmentEvent(doc, event, spans);
            fragments.push(pieces);
            for (const piece of pieces) {
              const bucket = buckets[rows.findLastIndex(t => compareQ(t.startQ, onset) <= 0)];
              if (!bucket) return reject(event.id, 'Rebar target is missing');
              bucket.events.push(piece);
              bucket.active ||= bar.kind === 'active';
              onset = addQ(onset, eventDurationQ(piece, original.measure.actualSpanQ, doc));
            }
          }
        }
      }
      return { ...voice, bars: rows.map(({ measure }, i): VoiceBar => {
        const bucket = buckets[i] ?? reject(voice.id, 'Missing rebar bucket');
        return bucket.active ? { kind: 'active', measureId: measure.id, events: bucket.events } : { kind: 'inactive', measureId: measure.id };
      }) };
    }),
  })) }));
  const remap = (position: { readonly measureId: MeasureId; readonly offsetQ: RationalQ }) => {
    const source = sources.find(s => s.measure.id === position.measureId) ?? reject(position.measureId, 'Missing source position');
    const at = addQ(source.startQ, position.offsetQ);
    const target = rows.findLast(t => compareQ(t.startQ, at) <= 0);
    if (!target) return reject(position.measureId, 'Position cannot be remapped');
    return { measureId: target.measure.id, offsetQ: subtractQ(at, target.startQ) };
  };
  let next: ScoreDocument = { ...doc, measures: rows.map(r => r.measure), tracks,
    automations: doc.automations.map(a => ({ ...a, ...remap(a) })),
    layout: { ...doc.layout,
      systemBreaks: [...new Set(doc.layout.systemBreaks.map(measureId => remap({ measureId, offsetQ: zeroQ }).measureId))],
      pageBreaks: [...new Set(doc.layout.pageBreaks.map(measureId => remap({ measureId, offsetQ: zeroQ }).measureId))] },
    ...(doc.backing ? { backing: { ...doc.backing, syncPoints: doc.backing.syncPoints.map(p => ({ ...p, ...remap(p) })) } } : {}) };
  for (const group of fragments) next = splitRelations(next, group);
  return next;
}

export function repairOverflow(doc: ScoreDocument): ScoreDocument {
  return rebar(doc, { kind: 'rebar', measureIds: overfullMeasures(doc).map(m => m.measureId) });
}

/** Pickup/free-time editing consumes trailing silence only, across all staves. */
export function changeMeasureSpan(doc: ScoreDocument, edit: SpanEdit): ScoreDocument {
  const index = doc.measures.findIndex(m => m.id === edit.measureId);
  const measure = doc.measures[index] ?? reject(edit.measureId, 'Measure no longer exists');
  if (compareQ(edit.spanQ, zeroQ) <= 0) reject(edit.measureId, 'Measure span must be positive');
  const tracks = doc.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({ ...s, voices: s.voices.map(v => ({
    ...v, bars: v.bars.map((bar, i): VoiceBar => {
      if (i !== index || bar.kind === 'inactive') return bar;
      if (bar.events.length === 1 && bar.events[0]?.duration === 'fullMeasure') return bar;
      const events: ScoreEvent[] = [];
      let onset = zeroQ;
      for (const event of bar.events) {
        const end = addQ(onset, eventDurationQ(event, measure.actualSpanQ, doc));
        if (compareQ(end, edit.spanQ) <= 0) events.push(event);
        else {
          if (event.kind === 'noteGroup' || (event.duration !== 'fullMeasure' && event.duration.tupletIds.length)) {
            reject(event.id, 'Shortening would discard sounding material or a tuplet');
          }
          if (compareQ(onset, edit.spanQ) < 0) events.push(...silence(doc, subtractQ(edit.spanQ, onset)));
        }
        onset = end;
      }
      if (compareQ(onset, edit.spanQ) < 0) events.push(...silence(doc, subtractQ(edit.spanQ, onset)));
      return { ...bar, events };
    }),
  })) })) }));
  return { ...doc, tracks, measures: doc.measures.map(m => m.id === edit.measureId ? { ...m, actualSpanQ: edit.spanQ, freeTime: edit.freeTime } : m) };
}
