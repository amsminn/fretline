import { describe, expect, it } from 'vitest';
import { applyArticulationCommand } from '../../src/domain/commands/articulations';
import type { ArticulationEdit } from '../../src/domain/commands/articulations';
import { applyCommand, contentToken } from '../../src/domain/commands/core';
import { indexDocument } from '../../src/domain/event-time';
import type { Technique } from '../../src/domain/notation';
import type { ScoreDocument } from '../../src/domain/document';
import type { Selection } from '../../src/domain/selection';
import { rationalQ, zeroQ } from '../../src/domain/rational';
import { fixtureDocument, mapEvents } from './fixtures';
import { copyMusic, pasteMusic } from '../../src/domain/clipboard';
import { asRest } from '../../src/domain/commands/notes';

function setup() {
  const doc = mapEvents(fixtureDocument('unison-strings'), event => event.kind === 'noteGroup'
    ? { ...event, notes: event.notes.map(note => ({ ...note, kind: 'fretted' as const, string: 1, fret: 3 })) } : event);
  const locations = [...indexDocument(doc).notes.values()];
  const first = locations[0];
  const second = locations[1];
  if (!first || !second) throw new RangeError('Fixture notes missing');
  const point = { eventId: first.location.event.id, startQ: first.location.startQ, endQ: first.location.endQ };
  const selection: Selection = { kind: 'noteSet', scope: { trackIds: [], staffIds: [], voices: [1] },
    anchor: point, focus: point, noteIds: [first.note.id] };
  return { doc, first, second, selection };
}
function applied(doc: ScoreDocument, edit: ArticulationEdit, selection: Selection) {
  const result = applyArticulationCommand(doc, { expectedToken: contentToken(doc), edit }, selection);
  if (result.kind === 'rejected') throw new RangeError(JSON.stringify(result.diagnostics));
  return result.nextDoc;
}
const techniques: readonly Technique[] = [
  { kind: 'bend', points: [{ position: zeroQ, semitones: zeroQ }, { position: rationalQ(1n), semitones: rationalQ(2n) }] },
  { kind: 'harmonic', style: 'artificial', fret: rationalQ(7n) },
  { kind: 'vibrato', strength: 'wide' }, { kind: 'trill', fret: 5, base: 16 },
  { kind: 'tremoloPicking', base: 32 }, { kind: 'fingering', left: '2', right: 'm' },
  { kind: 'pickStroke', direction: 'up' }, { kind: 'palmMute' }, { kind: 'letRing' },
  { kind: 'staccato' }, { kind: 'accent' }, { kind: 'heavyAccent' }, { kind: 'dead' },
  { kind: 'ghost' }, { kind: 'tap' }, { kind: 'slap' }, { kind: 'pop' },
];
describe('articulation editing', () => {
  it.each(techniques)('sets and removes %j without touching unselected notes', technique => {
    const { doc, first, second, selection } = setup();
    const next = applied(doc, { kind: 'technique', noteIds: [first.note.id], technique }, selection);
    expect(indexDocument(next).notes.get(first.note.id)?.note.techniques).toEqual([technique]);
    expect(indexDocument(next).notes.get(second.note.id)?.note).toBe(second.note);
    const cleared = applied(next, { kind: 'removeTechnique', noteIds: [first.note.id], techniqueKind: technique.kind }, selection);
    expect(indexDocument(cleared).notes.get(first.note.id)?.note.techniques).toEqual([]);
    expect(first.note.techniques).toEqual([]);
  });
  it.each(['legato', 'slide'] as const)('connects %s to an adjacent same-string attack', kind => {
    const { doc, first, second, selection } = setup();
    const technique: Technique = kind === 'legato' ? { kind, target: second.note.id } : { kind, style: 'shift', target: second.note.id };
    const next = applied(doc, { kind: 'technique', noteIds: [first.note.id], technique }, selection);
    expect(indexDocument(next).notes.get(first.note.id)?.note.techniques).toEqual([technique]);
  });
  it('rejects a legato target on another string atomically across a batch', () => {
    const { doc, first, second, selection } = setup();
    const other = mapEvents(doc, event => event.id === second.location.event.id && event.kind === 'noteGroup'
      ? { ...event, notes: event.notes.map(note => ({ ...note, kind: 'fretted' as const, string: 2, fret: 3 })) } : event);
    const before = JSON.stringify(other);
    const result = applyArticulationCommand(other, { expectedToken: contentToken(other), edit: { kind: 'articulationBatch', edits: [
      { kind: 'technique', noteIds: [first.note.id], technique: { kind: 'palmMute' } },
      { kind: 'technique', noteIds: [first.note.id], technique: { kind: 'legato', target: second.note.id } },
    ] } }, selection);
    expect(result).toMatchObject({ kind: 'rejected', diagnostics: [{ path: first.note.id }] });
    expect(JSON.stringify(other)).toBe(before);
  });
  it('rejects bend on percussion with the original root intact', () => {
    const { doc, first, selection } = setup();
    const percussion = mapEvents(doc, event => event.kind === 'noteGroup' ? { ...event,
      notes: event.notes.map(note => ({ id: note.id, kind: 'percussion' as const, midi: 38, articulation: '', techniques: [] })) } : event);
    const drumDoc = { ...percussion, tracks: percussion.tracks.map(t => ({ ...t, instrument: { ...t.instrument, kind: 'percussion' as const },
    })) };
    const result = applyArticulationCommand(drumDoc, { expectedToken: contentToken(drumDoc),
      edit: { kind: 'technique', noteIds: [first.note.id], technique: techniques[0] ?? { kind: 'palmMute' } } }, selection);
    expect(result).toMatchObject({ kind: 'rejected', diagnostics: [{ message: 'Pitched techniques cannot target percussion' }] });
    expect(indexDocument(drumDoc).notes.get(first.note.id)?.note.techniques).toEqual([]);
  });
  it.each([-1, 128, NaN])('rejects invalid note velocity %s at the command boundary', velocity => {
    const { doc, first, selection } = setup();
    const result = applyArticulationCommand(doc, { expectedToken: contentToken(doc),
      edit: { kind: 'noteAudio', noteIds: [first.note.id], audio: { velocity, offsetQ: zeroQ, durationQ: rationalQ(1n) } } }, selection);
    expect(result.kind).toBe('rejected');
    expect(first.note.audio).toBeUndefined();
  });
  it('preserves exact audio timing and removes its override on request', () => {
    const { doc, first, selection } = setup();
    const audio = { velocity: 93, offsetQ: rationalQ(-1n, 16n), durationQ: rationalQ(7n, 8n) };
    const next = applied(doc, { kind: 'noteAudio', noteIds: [first.note.id], audio }, selection);
    expect(indexDocument(next).notes.get(first.note.id)?.note.audio).toEqual(audio);
    expect(indexDocument(applied(next, { kind: 'noteAudio', noteIds: [first.note.id], audio: undefined }, selection))
      .notes.get(first.note.id)?.note.audio).toBeUndefined();
  });
  it('replaces a sustain controller at the same position without duplicating it', () => {
    const { doc, first, selection } = setup();
    const track = doc.tracks[0];
    if (!track) throw new RangeError('Fixture track missing');
    const edit = { kind: 'sustain' as const, trackId: track.id, measureId: first.location.measureId, offsetQ: zeroQ, down: true };
    const next = applied(doc, edit, selection);
    const up = applied(next, { ...edit, down: false }, selection);
    expect(up.automations).toEqual([{ ...next.automations[0], value: 0 }]);
  });
  it.each(['fade', 'rasgueado'] as const)('rejects undefined %s splitting without mutation', field => {
    const { doc, first, selection } = setup();
    const expression = field === 'fade' ? { fade: 'in' as const } : { rasgueado: 'ii' };
    const next = applied(doc, { kind: 'expression', eventIds: [first.location.event.id], expression }, selection);
    const before = JSON.stringify(next);
    expect(applyCommand(next, { expectedToken: contentToken(next), edit: {
      kind: 'split', eventId: first.location.event.id, atQ: rationalQ(1n, 2n),
    } }, selection)).toMatchObject({ kind: 'rejected', diagnostics: [{ path: first.location.event.id }] });
    expect(JSON.stringify(next)).toBe(before);
  });
  it('rejects duplicate curve positions before publishing any selected note', () => {
    const { doc, first, selection } = setup();
    const result = applyArticulationCommand(doc, { expectedToken: contentToken(doc), edit: {
      kind: 'technique', noteIds: [first.note.id], technique: { kind: 'bend', points: [
        { position: zeroQ, semitones: zeroQ }, { position: zeroQ, semitones: rationalQ(1n) },
        { position: rationalQ(1n), semitones: rationalQ(2n) },
      ] },
    } }, selection);
    expect(result).toMatchObject({ kind: 'rejected', diagnostics: [{ path: 'curve' }] });
  });
  it('rejects stale previews', () => {
    const { doc, first, selection } = setup();
    expect(applyArticulationCommand(doc, { expectedToken: 'stale',
      edit: { kind: 'technique', noteIds: [first.note.id], technique: { kind: 'palmMute' } } }, selection))
      .toMatchObject({ kind: 'rejected', diagnostics: [{ path: 'expectedToken' }] });
  });
  it('splits a linear bend into normalized curves and tied continuation identities', () => {
    const { doc, first, selection } = setup();
    const bend = techniques[0];
    if (!bend) throw new RangeError('Missing bend fixture');
    const next = applied(doc, { kind: 'technique', noteIds: [first.note.id], technique: bend }, selection);
    const result = applyCommand(next, { expectedToken: contentToken(next), edit: {
      kind: 'split', eventId: first.location.event.id, atQ: rationalQ(1n, 2n),
    } }, selection);
    if (result.kind === 'rejected') throw new RangeError(JSON.stringify(result.diagnostics));
    const [a, b] = [...indexDocument(result.nextDoc).notes.values()];
    expect(a?.note.id).toBe(first.note.id);
    expect(b?.note.id).not.toBe(first.note.id);
    expect([a?.note.techniques, b?.note.techniques]).toEqual([
      [{ kind: 'bend', points: [{ position: zeroQ, semitones: zeroQ }, { position: rationalQ(1n), semitones: rationalQ(1n) }] }],
      [{ kind: 'bend', points: [{ position: zeroQ, semitones: rationalQ(1n) }, { position: rationalQ(1n), semitones: rationalQ(2n) }] }],
    ]);
    expect(result.nextDoc.ties).toEqual([{ id: result.nextDoc.ties[0]?.id, from: a?.note.id, to: b?.note.id }]);
  });
  it('copies curves exactly with fresh identities and drops external hammer targets', () => {
    const { doc, first, second, selection } = setup();
    const bend = techniques[0];
    if (!bend) throw new RangeError('Missing bend fixture');
    const source = applied(doc, { kind: 'articulationBatch', edits: [
      { kind: 'technique', noteIds: [first.note.id], technique: bend },
      { kind: 'technique', noteIds: [first.note.id], technique: { kind: 'legato', target: second.note.id } },
    ] }, selection);
    const clipboard = copyMusic(source, selection);
    const target = mapEvents(doc, asRest);
    const result = pasteMusic(target, { clipboard, expectedToken: contentToken(target), startQ: zeroQ,
      voices: [{ source: first.location.voiceId, target: first.location.voiceId }] }, selection);
    if (result.kind === 'rejected') throw new RangeError(JSON.stringify(result.diagnostics));
    const pasted = [...indexDocument(result.nextDoc).notes.values()][0]?.note;
    expect(pasted?.id).not.toBe(first.note.id);
    expect(pasted?.techniques).toEqual([bend]);
  });
  it('deletes incident hammer targets without inventing replacement connections', () => {
    const { doc, first, second, selection } = setup();
    const source = applied(doc, { kind: 'technique', noteIds: [first.note.id],
      technique: { kind: 'legato', target: second.note.id } }, selection);
    const result = applyCommand(source, { expectedToken: contentToken(source),
      edit: { kind: 'deleteNotes', noteIds: [second.note.id] } }, selection);
    if (result.kind === 'rejected') throw new RangeError(JSON.stringify(result.diagnostics));
    expect(indexDocument(result.nextDoc).notes.get(first.note.id)?.note.techniques).toEqual([]);
    expect(indexDocument(result.nextDoc).events.get(second.location.event.id)?.event.kind).toBe('rest');
  });
  it('preserves unrelated event expressions when another expression changes', () => {
    const { doc, first, selection } = setup();
    const eventIds = [first.location.event.id];
    const source = applied(doc, { kind: 'expression', eventIds, expression: { fade: 'in', brush: 'down' } }, selection);
    const next = applied(source, { kind: 'expression', eventIds, expression: { brush: 'up' } }, selection);
    expect(indexDocument(next).events.get(first.location.event.id)?.event).toMatchObject({ fade: 'in', brush: 'up' });
  });
});
