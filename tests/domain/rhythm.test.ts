import { describe, expect, it } from 'vitest';
import { applyRhythmCommand } from '../../src/domain/commands/rhythm';
import type { RhythmEdit } from '../../src/domain/commands/rhythm';
import { contentToken } from '../../src/domain/commands/core';
import { indexDocument } from '../../src/domain/event-time';
import { rationalQ } from '../../src/domain/rational';
import type { ScoreDocument, ScoreEvent } from '../../src/domain/document';
import type { Selection } from '../../src/domain/selection';
import { parseScoreDocument, validateDocument } from '../../src/domain/validate';
import { fixtureDocument, fixtureId } from './fixtures';
import { selectVoice, toggleMultivoice } from '../../src/domain/commands/voices';

const duration = (base = 4) => ({ base, dots: 0, tupletIds: [] });
function setup(bases: readonly number[] = [4, 4, 4, 4]) {
  const source = fixtureDocument('unison-strings');
  const measure = source.measures[0];
  if (!measure) throw new RangeError('Fixture measure missing');
  const events: ScoreEvent[] = bases.map((base, i) => ({
    kind: 'noteGroup', id: fixtureId('event', `rhythm-${i}`), duration: duration(base),
    notes: [{ kind: 'fretted', id: fixtureId('note', `rhythm-${i}`), string: 1, fret: 3, techniques: [] }],
  }));
  const occupied = bases.reduce((sum, base) => sum + 4 / base, 0);
  if (occupied < 4) {
    for (let q = occupied; q < 4; q += 0.5) events.push({ kind: 'rest', id: fixtureId('event', `pad-${q}`), duration: duration(8) });
  }
  const doc = parseScoreDocument({ ...source, tracks: source.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({
    ...s, voices: s.voices.map(v => v.number === 1 ? { ...v, bars: v.bars.map((b, i) => i === 0 ? { kind: 'active', measureId: measure.id, events } : b) } : v),
  })) })) });
  const first = [...indexDocument(doc).events.values()][0];
  if (!first) throw new RangeError('Fixture event missing');
  const point = { eventId: first.event.id, startQ: first.startQ, endQ: first.endQ };
  const selection: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [1] }, anchor: point, focus: point };
  return { doc, events, selection };
}
function apply(doc: ScoreDocument, edit: RhythmEdit, selection: Selection) {
  const result = applyRhythmCommand(doc, { expectedToken: contentToken(doc), edit }, selection);
  if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result.diagnostics));
  expect(validateDocument(result.nextDoc)).toEqual([]);
  return result.nextDoc;
}
describe('authored exact rhythm edits', () => {
  it('creates a mixed quarter and eighth 3:2 group with an exact endpoint', () => {
    const { doc, events, selection } = setup([4, 8]);
    const next = apply(doc, { kind: 'tuplet', eventIds: events.slice(0, 2).map(e => e.id), actual: 3, normal: 2, unit: 8 }, selection);
    const second = events[1];
    if (!second) throw new RangeError('Missing event');
    expect(indexDocument(next).events.get(second.id)?.endQ).toEqual(rationalQ(1n));
    expect(next.tuplets[0]).toMatchObject({ actual: 3, normal: 2, unit: 8 });
    expect(events.slice(0, 2).map(e => indexDocument(next).events.get(e.id)?.event.duration)).toEqual([
      { ...duration(), tupletIds: [next.tuplets[0]?.id] }, { ...duration(8), tupletIds: [next.tuplets[0]?.id] },
    ]);
  });
  it('lands seven eighths in 7:4 exactly at two quarters', () => {
    const { doc, events, selection } = setup([8, 8, 8, 8, 8, 8, 8]);
    const next = apply(doc, { kind: 'tuplet', eventIds: events.slice(0, 7).map(e => e.id), actual: 7, normal: 4, unit: 8 }, selection);
    const last = events[6];
    if (!last) throw new RangeError('Missing event');
    expect(indexDocument(next).events.get(last.id)?.endQ).toEqual(rationalQ(2n));
  });
  it('retains both authored ratios when a group is nested', () => {
    const { doc, events, selection } = setup([8, 8, 8, 8, 8, 8]);
    const outer = apply(doc, { kind: 'tuplet', eventIds: events.slice(0, 6).map(e => e.id), actual: 3, normal: 2, unit: 4 }, selection);
    const next = apply(outer, { kind: 'tuplet', eventIds: events.slice(0, 3).map(e => e.id), actual: 3, normal: 2, unit: 8 }, selection);
    expect(next.tuplets).toHaveLength(2);
    expect(next.tuplets[1]?.parentId).toBe(next.tuplets[0]?.id);
    const first = events[0];
    if (!first) throw new RangeError('Missing event');
    expect(indexDocument(next).events.get(first.id)?.endQ).toEqual(rationalQ(2n, 9n));
    expect(next.tuplets[0]?.eventIds).toHaveLength(7);
  });
  it('rejects incomplete authored groups without changing the root', () => {
    const { doc, events, selection } = setup([4, 8]);
    const before = JSON.stringify(doc);
    const result = applyRhythmCommand(doc, { expectedToken: contentToken(doc), edit: {
      kind: 'tuplet', eventIds: events.slice(0, 1).map(e => e.id), actual: 3, normal: 2, unit: 8,
    } }, selection);
    expect(result.kind).toBe('rejected');
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('rejects equal-pitch ties on different strings', () => {
    const { doc, events, selection } = setup();
    const first = events[0];
    const second = events[1];
    if (first?.kind !== 'noteGroup' || second?.kind !== 'noteGroup') throw new RangeError('Missing notes');
    const changed = { ...doc, tracks: doc.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({ ...s,
      voices: s.voices.map(v => ({ ...v, bars: v.bars.map(b => b.kind === 'active' ? { ...b, events: b.events.map(e =>
        e.id === second.id && e.kind === 'noteGroup' ? { ...e, notes: e.notes.map(n => ({ ...n, kind: 'fretted' as const, string: 2, fret: 8 })) } : e) } : b) })),
    })) })) };
    const from = first.notes[0]?.id;
    const to = second.notes[0]?.id;
    if (!from || !to) throw new RangeError('Missing note IDs');
    const result = applyRhythmCommand(changed, { expectedToken: contentToken(changed), edit: { kind: 'tie', from, to } }, selection);
    expect(result).toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'TIE' }] });
    expect(changed.ties).toEqual([]);
  });
  it('rejects an occupied cross-bar extension atomically', () => {
    const { doc, events, selection } = setup();
    const last = events[3];
    if (!last) throw new RangeError('Missing last event');
    const before = JSON.stringify(doc);
    const result = applyRhythmCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'duration', eventId: last.id, duration: duration(2) } }, selection);
    expect(result.kind).toBe('rejected');
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('repartitions every voice and ties notes crossing new barlines', () => {
    const { doc, events, selection } = setup([2, 2]);
    const next = apply(doc, { kind: 'rebar', meter: { beats: 3, unit: 4 } }, selection);
    expect(next.measures.map(m => m.actualSpanQ)).toEqual([rationalQ(3n), rationalQ(3n), rationalQ(2n)]);
    expect(next.ties).toHaveLength(1);
    const first = events[0];
    const second = events[1];
    if (!first || !second) throw new RangeError('Missing event');
    expect(indexDocument(next).events.get(first.id)?.endQ).toEqual(rationalQ(2n));
    expect(indexDocument(next).events.get(second.id)?.endQ).toEqual(rationalQ(3n));
  });
  it('inserts zero-occupancy grace notes without moving the anchor', () => {
    const { doc, events, selection } = setup();
    const first = events[0];
    if (!first) throw new RangeError('Missing first event');
    const next = apply(doc, { kind: 'grace', eventIds: [first.id], placement: 'beforeBeat' }, selection);
    const locations = [...indexDocument(next).events.values()];
    expect(locations[0]?.event).toMatchObject({ kind: 'noteGroup', grace: { kind: 'beforeBeat' } });
    expect(locations[0]?.endQ).toEqual(rationalQ(0n));
    expect(indexDocument(next).events.get(first.id)?.endQ).toEqual(rationalQ(1n));
  });
  it('activates and selects the fourth lane without activating the other empty lanes', () => {
    const { doc, selection } = setup();
    const staff = doc.tracks[0]?.staves[0];
    const lane = staff?.voices.find(v => v.number === 4);
    const measure = doc.measures[0];
    if (!staff || !lane || !measure) throw new RangeError('Missing lane');
    const next = apply(doc, { kind: 'activateVoice', voiceId: lane.id, measureId: measure.id }, selection);
    expect(next.tracks[0]?.staves[0]?.voices.map(v => v.bars[0]?.kind)).toEqual(['active', 'inactive', 'inactive', 'active']);
    const chosen = selectVoice(next, selection, 4);
    expect(chosen.scope.voices).toEqual([4]);
    expect(toggleMultivoice(chosen).scope.voices).toEqual([1, 2, 3, 4]);
    expect(indexDocument(next).events.get(chosen.focus.eventId ?? fixtureId('event', 'absent'))?.voiceId).toBe(lane.id);
  });
  it('shortens a pickup by consuming silence and rejects discarded notes', () => {
    const { doc, selection } = setup([4]);
    const first = doc.measures[0];
    if (!first) throw new RangeError('Missing measure');
    const next = apply(doc, { kind: 'measureSpan', measureId: first.id, spanQ: rationalQ(1n), freeTime: false }, selection);
    expect(next.measures[0]?.actualSpanQ).toEqual(rationalQ(1n));
    expect([...indexDocument(next).events.values()][0]?.endQ).toEqual(rationalQ(1n));
    expect(applyRhythmCommand(doc, { expectedToken: contentToken(doc),
      edit: { kind: 'measureSpan', measureId: first.id, spanQ: rationalQ(1n, 2n), freeTime: false } }, selection).kind).toBe('rejected');
  });
  it('toggles an adjacent same-string tie on and off with stable note identity', () => {
    const { doc, events, selection } = setup();
    const first = events[0];
    const second = events[1];
    if (first?.kind !== 'noteGroup' || second?.kind !== 'noteGroup') throw new RangeError('Missing notes');
    const from = first.notes[0]?.id;
    const to = second.notes[0]?.id;
    if (!from || !to) throw new RangeError('Missing IDs');
    const next = apply(doc, { kind: 'tie', from, to }, selection);
    expect(next.ties).toEqual([{ id: next.ties[0]?.id, from, to }]);
    expect(apply(next, { kind: 'tie', from, to }, selection).ties).toEqual([]);
  });
  it('rejects a stale rhythm preview before any edit', () => {
    const { doc, events, selection } = setup([4, 8]);
    const result = applyRhythmCommand(doc, { expectedToken: 'stale', edit: {
      kind: 'tuplet', eventIds: events.slice(0, 2).map(e => e.id), actual: 3, normal: 2, unit: 8,
    } }, selection);
    expect(result).toMatchObject({ kind: 'rejected', diagnostics: [{ path: 'expectedToken' }] });
    expect(doc.tuplets).toEqual([]);
  });
  it('rejects rebarring that would shift an authored repeat boundary', () => {
    const { selection } = setup();
    const doc = fixtureDocument('alternate-endings');
    const before = JSON.stringify(doc);
    const result = applyRhythmCommand(doc, { expectedToken: contentToken(doc),
      edit: { kind: 'rebar', meter: { beats: 3, unit: 4 } } }, selection);
    expect(result).toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'RANGE' }] });
    expect(JSON.stringify(doc)).toBe(before);
  });
});
