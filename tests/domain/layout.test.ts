import { describe, expect, it } from 'vitest';
import { applyLayoutCommand, spellMidi } from '../../src/domain/commands/layout';
import type { LayoutEdit } from '../../src/domain/commands/layout';
import { applyStructureCommand } from '../../src/domain/commands/structure';
import { contentToken } from '../../src/domain/commands/core';
import { indexDocument } from '../../src/domain/event-time';
import { validateDocument } from '../../src/domain/validate';
import type { ScoreDocument } from '../../src/domain/document';
import type { Selection } from '../../src/domain/selection';
import { fixtureDocument, mapEvents } from './fixtures';

const doc = fixtureDocument('loop-eight-bars');
const events = [...indexDocument(doc).events.values()];
const first = events[0];
const second = events[1];
const firstTrack = doc.tracks[0];
if (!first || !second || !firstTrack) throw new Error('fixture needs events');
const selection: Selection = { kind: 'noteSet', noteIds: first.event.kind === 'noteGroup' ? first.event.notes.map(n => n.id) : [],
  scope: { trackIds: [firstTrack.id], staffIds: [first.staff.id], voices: [1] },
  anchor: { eventId: first.event.id, startQ: first.startQ, endQ: first.endQ }, focus: { eventId: first.event.id, startQ: first.startQ, endQ: first.endQ } };
const apply = (source: ScoreDocument, edit: LayoutEdit) => applyLayoutCommand(source, { expectedToken: contentToken(source), edit }, selection);
function applied(source: ScoreDocument, edit: LayoutEdit): ScoreDocument {
  const result = apply(source, edit);
  if (result.kind === 'rejected') throw new Error(JSON.stringify(result.diagnostics));
  return result.nextDoc;
}
const measureAt = (index: number) => {
  const measure = doc.measures[index];
  if (!measure) throw new Error('fixture measure');
  return measure;
};

describe('layout commands', () => {
  it('keeps the selection, every event identity and the music when the layout is rearranged', () => {
    const next = applied(doc, { kind: 'layoutBatch', edits: [
      { kind: 'systemBreak', measureId: measureAt(1).id, enabled: true },
      { kind: 'eventSpacing', entries: [{ eventId: first.event.id, width: 64 }, { eventId: second.event.id, width: 48 }] },
      { kind: 'notationMode', staffIds: [first.staff.id], mode: 'tab' },
      { kind: 'view', view: 'horizontal' },
      { kind: 'scale', scale: 1.5 },
    ] });
    const result = apply(doc, { kind: 'scale', scale: 0.9 });
    expect(result.kind === 'applied' && result.nextSelection).toBe(selection);
    expect(next.layout.systemBreaks).toEqual([measureAt(1).id]);
    expect(next.layout.eventSpacing).toEqual([{ eventId: first.event.id, width: 64 }, { eventId: second.event.id, width: 48 }]);
    expect(next.layout.view).toBe('horizontal');
    expect(next.layout.scale).toBe(1.5);
    expect(next.tracks[0]?.staves[0]?.notationMode).toBe('tab');
    expect(next.tracks[1]).toBe(doc.tracks[1]);
    expect([...indexDocument(next).events.keys()]).toEqual(events.map(e => e.event.id));
    expect(next.measures).toBe(doc.measures);
    expect(validateDocument(next)).toEqual([]);
  });
  it('orders system breaks by written measure order and removes them idempotently', () => {
    const next = applied(applied(doc, { kind: 'systemBreak', measureId: measureAt(5).id, enabled: true }), { kind: 'systemBreak', measureId: measureAt(2).id, enabled: true });
    expect(next.layout.systemBreaks).toEqual([measureAt(2).id, measureAt(5).id]);
    const cleared = applied(applied(next, { kind: 'systemBreak', measureId: measureAt(5).id, enabled: false }), { kind: 'systemBreak', measureId: measureAt(5).id, enabled: false });
    expect(cleared.layout.systemBreaks).toEqual([measureAt(2).id]);
  });
  it('keeps spacing overrides attached to their event IDs when the track moves', () => {
    const spaced = applied(doc, { kind: 'eventSpacing', entries: [{ eventId: first.event.id, width: 80 }] });
    const lastTrack = spaced.tracks.at(-1);
    if (!lastTrack) throw new Error('fixture track');
    const moved = applyStructureCommand(spaced, { expectedToken: contentToken(spaced), edit: { kind: 'moveTrack', trackId: lastTrack.id, beforeTrackId: spaced.tracks[0]?.id ?? null } }, selection);
    if (moved.kind === 'rejected') throw new Error(JSON.stringify(moved.diagnostics));
    expect(moved.nextDoc.tracks[0]?.id).toBe(lastTrack.id);
    expect(moved.nextDoc.layout.eventSpacing).toEqual([{ eventId: first.event.id, width: 80 }]);
    expect(indexDocument(moved.nextDoc).events.get(first.event.id)?.staff.id).toBe(first.staff.id);
    const cleared = applied(spaced, { kind: 'eventSpacing', entries: [{ eventId: first.event.id, width: null }] });
    expect(cleared.layout.eventSpacing).toBeUndefined();
  });
  it('rejects out-of-range scale, spacing and an invisible stylesheet without changing the root', () => {
    for (const edit of [
      { kind: 'scale', scale: 3 },
      { kind: 'eventSpacing', entries: [{ eventId: first.event.id, width: 2 }] },
      { kind: 'stylesheet', stylesheet: { showTab: false, showStandard: false } },
      { kind: 'stylesheet', stylesheet: { fontSize: 2 } },
      { kind: 'notationMode', staffIds: [], mode: 'both' },
    ] as const satisfies readonly LayoutEdit[]) {
      const result = apply(doc, edit);
      expect(result.kind).toBe('rejected');
    }
    expect(apply(doc, { kind: 'stylesheet', stylesheet: { fontSize: 14, showChordDiagrams: false } }).kind).toBe('applied');
    expect(applyLayoutCommand(doc, { expectedToken: 'stale', edit: { kind: 'view', view: 'page' } }, selection).kind).toBe('rejected');
  });
  it('spells pitched notes enharmonically and toggles courtesy accidentals, rejecting fretted notes', () => {
    const pianoTracks = mapEvents(doc, event => event.kind === 'noteGroup' && events.some(e => e.event.id === event.id && e.staff.id === first.staff.id)
      ? { ...event, notes: event.notes.map(note => ({ kind: 'pitched', id: note.id, midi: 61, techniques: [] })) } : event);
    const pitched: ScoreDocument = { ...pianoTracks, tracks: pianoTracks.tracks.map(track => track.id === firstTrack.id
      ? { ...track, instrument: { kind: 'pitched', program: 0, bank: 0 }, staves: track.staves.map(staff => ({ ...staff, tuning: [] })) } : track) };
    const noteIds = first.event.kind === 'noteGroup' ? first.event.notes.map(n => n.id) : [];
    const flat = applied(pitched, { kind: 'spelling', noteIds, mode: 'flat' });
    const noteId = noteIds[0];
    if (!noteId) throw new Error('fixture note');
    const flatNote = indexDocument(flat).notes.get(noteId)?.note;
    expect(flatNote?.kind === 'pitched' && flatNote.spelling).toEqual({ step: 'D', alter: -1, octave: 4 });
    const courtesy = applied(flat, { kind: 'courtesyAccidental', noteIds, courtesy: true });
    const courtesyNote = indexDocument(courtesy).notes.get(noteId)?.note;
    expect(courtesyNote?.kind === 'pitched' && courtesyNote.spelling).toEqual({ step: 'D', alter: -1, octave: 4, courtesy: true });
    const sharp = applied(courtesy, { kind: 'spelling', noteIds, mode: 'sharp' });
    const sharpNote = indexDocument(sharp).notes.get(noteId)?.note;
    expect(sharpNote?.kind === 'pitched' && sharpNote.spelling).toEqual({ step: 'C', alter: 1, octave: 4, courtesy: true });
    expect(spellMidi(60, 'auto')).toEqual({ step: 'C', alter: 0, octave: 4 });
    expect(apply(doc, { kind: 'spelling', noteIds, mode: 'flat' }).kind).toBe('rejected');
    expect(validateDocument(sharp)).toEqual([]);
  });
});
