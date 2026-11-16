import { describe, expect, it } from 'vitest';
import { applyCommand, contentToken, freezeRoot } from '../../src/domain/commands/core';
import type { Edit } from '../../src/domain/commands/core';
import type { ScoreDocument, ScoreEvent } from '../../src/domain/document';
import { indexDocument } from '../../src/domain/event-time';
import { rationalQ } from '../../src/domain/rational';
import { validateDocument } from '../../src/domain/validate';
import { validateScoped } from '../../src/domain/validate-scoped';
import { fixtureDocument, fixtureId, mapEvents } from './fixtures';
import { firstSelection } from './perf-fixture';

function tiedFixture() {
  const original = mapEvents(fixtureDocument('unison-strings'), event => event.kind === 'noteGroup'
    ? { ...event, notes: event.notes.map(note => ({ ...note, kind: 'fretted' as const, string: 1, fret: 0 })) } : event);
  const events = [...indexDocument(original).events.values()];
  const first = events[0];
  const second = events[1];
  const target = first?.staff.voices[1];
  if (!first || !second || !target || first.event.kind !== 'noteGroup' || second.event.kind !== 'noteGroup') throw new RangeError('Missing tied fixture');
  const from = first.event.notes[0];
  const to = second.event.notes[0];
  if (!from || !to) throw new RangeError('Missing tied notes');
  const doc = freezeRoot({ ...original, ties: [{ id: fixtureId('tie', 'adjacent'), from: from.id, to: to.id }] });
  expect(validateDocument(doc)).toEqual([]);
  return { doc, first, second, from, to, target };
}

describe('incident relation checks at the command boundary', () => {
  it.each(['setFret', 'duration', 'moveVoice', 'replaceSpan', 'batch'] as const)('%s rejects a broken tie atomically', kind => {
    const { doc, first, from, target } = tiedFixture();
    let edit: Edit;
    switch (kind) {
      case 'setFret': edit = { kind, noteId: from.id, fret: 3 }; break;
      case 'duration': edit = { kind, eventId: first.event.id, duration: { base: 8, dots: 0, tupletIds: [] } }; break;
      case 'moveVoice': edit = { kind, eventIds: [first.event.id], targetVoiceId: target.id }; break;
      case 'replaceSpan': {
        if (first.event.kind !== 'noteGroup') throw new RangeError('Missing chord');
        const event: ScoreEvent = { ...first.event, notes: [{ ...from, kind: 'fretted', string: 1, fret: 3 }] };
        edit = { kind, replacement: { voiceId: first.voiceId, startQ: first.startQ, endQ: first.endQ, events: [event], replaceIds: [event.id] } };
        break;
      }
      case 'batch': edit = { kind, edits: [{ kind: 'setFret', noteId: from.id, fret: 3 }, { kind: 'relations', ties: [], tuplets: [], chords: [], diagrams: [], lyrics: [], scales: [] }] }; break;
    }
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit }, firstSelection(doc));
    expect(result).toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'TIE' }] });
    expect(indexDocument(doc).notes.get(from.id)?.note).toBe(from);
  });

  it('putNote rejects an identity duplicated in an untouched bar', () => {
    const { doc, first, to } = tiedFixture();
    const edit: Edit = { kind: 'putNote', eventId: first.event.id, note: { ...to, kind: 'fretted', string: 2, fret: 5 } };
    expect(applyCommand(doc, { expectedToken: contentToken(doc), edit }, firstSelection(doc)))
      .toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'DUPLICATE_ID' }] });
  });

  it.each(['deleteNotes', 'rest'] as const)('%s removes incident ties and preserves the live endpoint', kind => {
    const { doc, first, from, to } = tiedFixture();
    const edit: Edit = kind === 'deleteNotes' ? { kind, noteIds: [from.id] } : { kind, eventIds: [first.event.id] };
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit }, firstSelection(doc));
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextDoc.ties).toEqual([]);
    expect(indexDocument(result.nextDoc).notes.has(to.id)).toBe(true);
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });

  it('split preserves the outgoing tie through its new continuation', () => {
    const { doc, first, from, to } = tiedFixture();
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'split', eventId: first.event.id, atQ: rationalQ(1n, 2n) } }, firstSelection(doc));
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextDoc.ties).toHaveLength(2);
    const continuation = result.nextDoc.ties.find(tie => tie.from === from.id)?.to;
    expect(result.nextDoc.ties.find(tie => tie.to === to.id)?.from).toBe(continuation);
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });

  it('ripple rejects a new time gap at an unchanged tie source', () => {
    const { doc, first, second } = tiedFixture();
    const silent = freezeRoot(mapEvents(doc, event => event.id === first.event.id || event.id === second.event.id ? event :
      { kind: 'rest', id: event.id, duration: event.duration }));
    const result = applyCommand(silent, { expectedToken: contentToken(silent), edit: {
      kind: 'ripple', voiceId: second.voiceId, startQ: second.startQ, endQ: second.endQ, deltaQ: rationalQ(1n),
    } }, firstSelection(silent));
    expect(result).toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'TIE' }] });
  });

  it('insertMeasure rechecks the former pickup at its new global position', () => {
    const doc = freezeRoot(fixtureDocument('pickup-6-8'));
    const measure = doc.measures[1];
    const pickup = doc.measures[0];
    if (!measure || !pickup) throw new RangeError('Missing measure');
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit: {
      kind: 'insertMeasure', beforeMeasureId: pickup.id, measure: { ...measure, id: fixtureId('measure', 'before-pickup') },
    } }, firstSelection(doc));
    expect(result).toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'VOICE' }] });
  });

  it('deleteMeasures removes incident notation and keeps every lane aligned', () => {
    const { doc, first, second } = tiedFixture();
    const decorated = freezeRoot({ ...doc, chords: [{ id: fixtureId('chord', 'removed'), eventId: second.event.id, name: 'C', root: 0, intervals: [0, 4, 7] }] });
    const result = applyCommand(decorated, { expectedToken: contentToken(decorated), edit: { kind: 'deleteMeasures', measureIds: [first.measureId] } }, firstSelection(decorated));
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextDoc.chords).toEqual([]);
    expect(result.nextDoc.ties).toEqual([]);
    expect(result.nextDoc.tracks.flatMap(t => t.staves.flatMap(s => s.voices.map(v => v.bars.map(b => b.measureId)))))
      .toEqual(Array.from({ length: 4 }, () => result.nextDoc.measures.map(m => m.id)));
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });

  it.each(['chord', 'lyric', 'diagram', 'tuplet', 'scale'] as const)('relations rejects a dangling %s dependency', kind => {
    const { doc, first } = tiedFixture();
    const missing = fixtureId('event', 'missing');
    const edit: Extract<Edit, { kind: 'relations' }> = { kind: 'relations', ties: [], tuplets: [], chords: [], lyrics: [], diagrams: [], scales: [],
      ...(kind === 'chord' ? { chords: [{ id: fixtureId('chord', kind), eventId: missing, name: 'C', root: 0, intervals: [] }] } : {}),
      ...(kind === 'lyric' ? { lyrics: [{ id: fixtureId('lyric', kind), eventId: missing, verse: 1, text: 'la', syllabic: 'single' as const, extend: false }] } : {}),
      ...(kind === 'diagram' ? { chords: [{ id: fixtureId('chord', kind), eventId: first.event.id, name: 'C', root: 0, intervals: [], diagramId: fixtureId('diagram', 'missing') }] } : {}),
      ...(kind === 'tuplet' ? { tuplets: [{ id: fixtureId('tuplet', kind), actual: 3, normal: 2, unit: 8, eventIds: [missing] }] } : {}),
      ...(kind === 'scale' ? { scales: [{ id: fixtureId('scale', kind), eventId: missing, name: 'major', root: 0, intervals: [] }] } : {}),
    };
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit }, firstSelection(doc));
    expect(result.kind).toBe('rejected');
    expect(result.diagnostics.map(d => d.code)).toEqual([kind === 'tuplet' ? 'TUPLET' : 'REFERENCE']);
  });
});

describe('scope dependency closure', () => {
  it('finds dangling tuplets after removing their complete lane contents', () => {
    const doc = freezeRoot(fixtureDocument('seven-four'));
    const after = freezeRoot(mapEvents(doc, event => ({ id: fixtureId('event', event.id), kind: 'rest', duration: { base: 4, dots: 0, tupletIds: [] } })));
    expect(validateScoped(doc, after)).toEqual(validateDocument(after));
    expect(validateScoped(doc, after).map(d => d.code)).toContain('TUPLET');
  });

  it('checks a global alignment change even when every retained bar is shared', () => {
    const doc = freezeRoot(fixtureDocument('loop-eight-bars'));
    const after: ScoreDocument = freezeRoot({ ...doc, measures: doc.measures.slice(1) });
    const expected = validateDocument(after);
    expect(expected.map(d => d.code)).toContain('VOICE');
    expect(validateScoped(doc, after)).toEqual(expected);
  });

  it('rechecks an unchanged D.S. instruction when its target marker disappears', () => {
    const doc = freezeRoot(fixtureDocument('ds-al-coda'));
    const after = freezeRoot({ ...doc, measures: doc.measures.map(m => m.jumps.some(j => j.kind === 'segno') ? { ...m, jumps: [] } : m) });
    expect(validateScoped(doc, after)).toEqual(validateDocument(after));
    expect(validateScoped(doc, after).map(d => d.code)).toEqual(['JUMP']);
  });
});
