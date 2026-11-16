import { describe, expect, it } from 'vitest';
import { applyCommand, contentToken } from '../../src/domain/commands/core';
import type { Edit } from '../../src/domain/commands/core';
import { indexDocument } from '../../src/domain/event-time';
import { rationalQ } from '../../src/domain/rational';
import type { Selection } from '../../src/domain/selection';
import { parseScoreDocument, validateDocument } from '../../src/domain/validate';
import { fixtureDocument, fixtureId, mapEvents } from './fixtures';

const quarter = { base: 4, dots: 0, tupletIds: [] } as const;
function setup(name = 'unison-strings') {
  const doc = parseScoreDocument(fixtureDocument(name));
  const locations = [...indexDocument(doc).events.values()];
  const first = locations[0];
  const note = [...indexDocument(doc).notes.values()][0]?.note;
  if (!first || !note) throw new RangeError('Missing fixture');
  const selection: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [1] },
    anchor: { eventId: first.event.id, startQ: first.startQ, endQ: first.endQ },
    focus: { eventId: first.event.id, startQ: first.startQ, endQ: first.endQ } };
  return { doc, locations, first, note, selection };
}
describe('atomic score commands', () => {
  it('rejects a stale token without changing document or selection', () => {
    const { doc, note, selection } = setup();
    const before = JSON.stringify({ doc, selection });
    const result = applyCommand(doc, { expectedToken: 'stale', edit: { kind: 'setFret', noteId: note.id, fret: 9 } }, selection);
    expect(result.kind).toBe('rejected');
    expect(JSON.stringify({ doc, selection })).toBe(before);
  });
  it('changes fret with structural sharing of untouched voices and bars', () => {
    const { doc, note, selection } = setup();
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'setFret', noteId: note.id, fret: 12 } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(indexDocument(result.nextDoc).notes.get(note.id)?.note).toMatchObject({ fret: 12 });
    expect(result.nextDoc.tracks[0]?.staves[0]?.voices[1]).toBe(doc.tracks[0]?.staves[0]?.voices[1]);
    expect(result.nextDoc.tracks[0]?.staves[0]?.voices[0]?.bars[1]).toBe(doc.tracks[0]?.staves[0]?.voices[0]?.bars[1]);
    expect(indexDocument(doc).notes.get(note.id)?.note).toEqual(note);
  });
  it('rejects a whole batch when its final edit collides', () => {
    const { doc, note, first, selection } = setup();
    const edit: Edit = { kind: 'batch', edits: [
      { kind: 'setFret', noteId: note.id, fret: 9 },
      { kind: 'duration', eventId: first.event.id, duration: { ...quarter, base: 2 } },
    ] };
    expect(applyCommand(doc, { expectedToken: contentToken(doc), edit }, selection).kind).toBe('rejected');
    expect(indexDocument(doc).notes.get(note.id)?.note).toEqual(note);
  });
  it('deleting the last note creates an equal-duration rest with the same event ID', () => {
    const { doc, note, first, selection } = setup();
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'deleteNotes', noteIds: [note.id] } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(indexDocument(result.nextDoc).events.get(first.event.id)?.event).toEqual({ id: first.event.id, kind: 'rest', duration: quarter });
  });
  it('shortening adds silence without shifting later music', () => {
    const { doc, first, locations, selection } = setup();
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'duration', eventId: first.event.id, duration: { ...quarter, base: 8 } } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    const actual = [...indexDocument(result.nextDoc).events.values()];
    expect(actual.slice(0, 3).map(e => [e.event.kind, e.startQ, e.endQ])).toEqual([
      ['noteGroup', rationalQ(0n), rationalQ(1n, 2n)],
      ['rest', rationalQ(1n, 2n), rationalQ(1n)],
      ['noteGroup', rationalQ(1n), rationalQ(2n)],
    ]);
    expect(actual[2]?.event).toBe(locations[1]?.event);
  });
  it('splits an event into tied notes preserving the first identities', () => {
    const { doc, first, note, selection } = setup();
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'split', eventId: first.event.id, atQ: rationalQ(1n, 2n) } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    const notes = [...indexDocument(result.nextDoc).notes.values()];
    expect(notes.slice(0, 2).map(n => [n.location.startQ, n.location.endQ])).toEqual([
      [rationalQ(0n), rationalQ(1n, 2n)], [rationalQ(1n, 2n), rationalQ(1n)],
    ]);
    expect(notes[0]?.note.id).toBe(note.id);
    expect(notes[0]?.location.event.id).toBe(first.event.id);
    expect(result.nextDoc.ties).toEqual([{ id: result.nextDoc.ties[0]?.id, from: note.id, to: notes[1]?.note.id }]);
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });
  it('extends a half-quarter at the bar edge into tied halves of a quarter', () => {
    const { doc, locations, selection } = setup();
    const last = locations[3];
    if (!last) throw new RangeError('Missing bar end');
    const silent = mapEvents(doc, e => e.id === last.event.id ? { ...e, duration: { ...quarter, base: 8 } } :
      { kind: 'rest', id: e.id, duration: e.duration });
    const base = { ...silent, tracks: silent.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({ ...s,
      voices: s.voices.map(v => ({ ...v, bars: v.bars.map((b, i) => b.kind === 'active' && i === 0
        ? { ...b, events: [...b.events.slice(0, 3), { kind: 'rest' as const, id: fixtureId('event', 'edge-pad'), duration: { ...quarter, base: 8 } }, ...b.events.slice(3)] } : b) })),
    })) })) };
    const parsed = parseScoreDocument(base);
    const result = applyCommand(parsed, { expectedToken: contentToken(parsed), edit: { kind: 'duration', eventId: last.event.id, duration: quarter } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    const sounding = [...indexDocument(result.nextDoc).events.values()].filter(e => e.event.kind === 'noteGroup');
    expect(sounding.map(e => [e.startQ, e.endQ])).toEqual([
      [rationalQ(7n, 2n), rationalQ(4n)], [rationalQ(4n), rationalQ(9n, 2n)],
    ]);
    expect(result.nextDoc.ties).toHaveLength(1);
  });
  it('moves a note to an inactive voice without moving its written time', () => {
    const { doc, first, selection } = setup();
    const target = doc.tracks[0]?.staves[0]?.voices[1];
    if (!target) throw new RangeError('Missing target');
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'moveVoice', eventIds: [first.event.id], targetVoiceId: target.id } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(indexDocument(result.nextDoc).events.get(first.event.id)).toMatchObject({ voiceId: target.id, startQ: first.startQ, endQ: first.endQ });
    expect(result.nextSelection.scope.voices).toEqual([2]);
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });
  it('deletes a global measure from every voice and transforms selection', () => {
    const { doc, first, selection } = setup('loop-eight-bars');
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'deleteMeasures', measureIds: [first.measureId] } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextDoc.measures).toHaveLength(7);
    expect(result.nextDoc.tracks.flatMap(t => t.staves.flatMap(s => s.voices.map(v => v.bars.length)))).toEqual(Array.from({ length: 12 }, () => 7));
    expect(result.nextSelection.anchor.startQ).toEqual(rationalQ(0n));
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });
  it.each([-1, 1])('ripples only the selected voice span by %s quarters', delta => {
    const { doc, locations, selection } = setup();
    const moved = locations[1];
    if (!moved) throw new RangeError('Missing event');
    const silent = mapEvents(doc, e => e.id === moved.event.id ? e : { kind: 'rest', id: e.id, duration: e.duration });
    const result = applyCommand(silent, { expectedToken: contentToken(silent), edit: {
      kind: 'ripple', voiceId: moved.voiceId, startQ: rationalQ(1n), endQ: rationalQ(2n), deltaQ: rationalQ(BigInt(delta)),
    } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(indexDocument(result.nextDoc).events.get(moved.event.id)?.startQ).toEqual(rationalQ(BigInt(1 + delta)));
    expect(result.nextDoc.tracks[0]?.staves[0]?.voices[1]).toBe(silent.tracks[0]?.staves[0]?.voices[1]);
    expect(result.nextDoc.tracks[0]?.staves[0]?.voices[0]?.bars[1]).toBe(silent.tracks[0]?.staves[0]?.voices[0]?.bars[1]);
  });
  it('rejects ripple collisions and score overflow without dropping material', () => {
    const { doc, first, selection } = setup();
    for (const delta of [1n, 8n]) {
      const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: {
        kind: 'ripple', voiceId: first.voiceId, startQ: rationalQ(0n), endQ: rationalQ(1n), deltaQ: rationalQ(delta),
      } }, selection);
      expect(result.kind).toBe('rejected');
    }
    expect([...indexDocument(doc).notes.values()]).toHaveLength(8);
  });
  it('inserts a global bar with rests in active lanes and preserves inactive lanes', () => {
    const { doc, first, selection } = setup();
    const measure = doc.measures[0];
    if (!measure) throw new RangeError('Missing measure');
    const inserted = { ...measure, id: fixtureId('measure', 'inserted') };
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: {
      kind: 'insertMeasure', beforeMeasureId: first.measureId, measure: inserted,
    } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextDoc.measures.map(m => m.id)).toEqual([inserted.id, ...doc.measures.map(m => m.id)]);
    expect(result.nextDoc.tracks[0]?.staves[0]?.voices.map(v => v.bars[0]?.kind)).toEqual(['active', 'inactive', 'inactive', 'inactive']);
    expect(result.nextSelection.anchor.startQ).toEqual(rationalQ(4n));
    expect(result.nextDoc.tracks[0]?.staves[0]?.voices[0]?.bars[1]).toBe(doc.tracks[0]?.staves[0]?.voices[0]?.bars[0]);
  });
  it('enters notes into silence and upserts the same string without losing identity', () => {
    const { doc, first, note, selection } = setup();
    const silent = mapEvents(doc, e => ({ kind: 'rest', id: e.id, duration: e.duration }));
    const inserted = { kind: 'fretted' as const, id: fixtureId('note', 'entered'), string: 1, fret: 8, techniques: [] };
    const result = applyCommand(silent, { expectedToken: contentToken(silent), edit: { kind: 'putNote', eventId: first.event.id, note: inserted } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(indexDocument(result.nextDoc).notes.get(inserted.id)?.note).toEqual(inserted);
    const upsert = applyCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'putNote', eventId: first.event.id, note: inserted } }, selection);
    if (upsert.kind !== 'applied') throw new RangeError(JSON.stringify(upsert));
    expect(indexDocument(upsert.nextDoc).notes.get(note.id)?.note).toEqual({ ...inserted, id: note.id });
    expect(indexDocument(upsert.nextDoc).notes.has(inserted.id)).toBe(false);
  });
  it('splits within authored tuplets while maintaining reciprocal membership', () => {
    const { doc, first, selection } = setup('seven-four');
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'split', eventId: first.event.id, atQ: rationalQ(2n, 7n) } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextDoc.tuplets[0]?.eventIds).toHaveLength(8);
    expect(result.nextDoc.tuplets[0]?.actual).toBe(7);
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });
  it('splits bend envelopes continuously and keeps attack accents on the first fragment', () => {
    const { doc, first, selection } = setup();
    const decorated = mapEvents(doc, e => e.id === first.event.id && e.kind === 'noteGroup' ? {
      ...e, notes: e.notes.map(n => ({ ...n, techniques: [
        { kind: 'accent' as const }, { kind: 'bend' as const, points: [
          { position: rationalQ(0n), semitones: rationalQ(0n) }, { position: rationalQ(1n), semitones: rationalQ(2n) },
        ] },
      ] })),
    } : e);
    const result = applyCommand(decorated, { expectedToken: contentToken(decorated), edit: { kind: 'split', eventId: first.event.id, atQ: rationalQ(1n, 2n) } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    const notes = [...indexDocument(result.nextDoc).notes.values()].slice(0, 2);
    expect(notes.map(n => n.note.techniques.map(t => t.kind))).toEqual([['accent', 'bend'], ['bend']]);
    expect(notes.map(n => n.note.techniques.flatMap(t => t.kind === 'bend' ? t.points.map(p => p.semitones) : []))).toEqual([
      [rationalQ(0n), rationalQ(1n)], [rationalQ(1n), rationalQ(2n)],
    ]);
  });
  it('moves complete tuplets between voices without leaving orphan memberships', () => {
    const { doc, first, selection } = setup('seven-four');
    const group = doc.tuplets[0];
    const target = first.staff.voices[1];
    if (!group || !target) throw new RangeError('Missing tuplet lane');
    const result = applyCommand(doc, { expectedToken: contentToken(doc),
      edit: { kind: 'moveVoice', eventIds: group.eventIds, targetVoiceId: target.id } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextDoc.tuplets).toEqual(doc.tuplets);
    expect(group.eventIds.map(id => indexDocument(result.nextDoc).events.get(id)?.voiceId)).toEqual(group.eventIds.map(() => target.id));
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });
  it('shortens a tuplet member with silence in the same authored ratio', () => {
    const { doc, first, selection } = setup('seven-four');
    if (first.event.duration === 'fullMeasure') throw new RangeError('Missing duration');
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: {
      kind: 'duration', eventId: first.event.id, duration: { ...first.event.duration, base: 8 },
    } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect([...indexDocument(result.nextDoc).events.values()].slice(0, 2).map(e => [e.event.kind, e.endQ])).toEqual([
      ['noteGroup', rationalQ(2n, 7n)], ['rest', rationalQ(4n, 7n)],
    ]);
    expect(result.nextDoc.tuplets[0]?.eventIds).toHaveLength(8);
  });
});
