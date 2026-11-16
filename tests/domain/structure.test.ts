import { describe, expect, it } from 'vitest';
import { applyStructureCommand } from '../../src/domain/commands/structure';
import type { StructureEdit } from '../../src/domain/commands/structure';
import { contentToken } from '../../src/domain/commands/core';
import { indexDocument, soundingPitch } from '../../src/domain/event-time';
import { validateDocument } from '../../src/domain/validate';
import { zeroQ } from '../../src/domain/rational';
import type { ScoreDocument } from '../../src/domain/document';
import type { Selection } from '../../src/domain/selection';
import { copyMusic } from '../../src/domain/clipboard';
import { fixtureDocument } from './fixtures';

const selection: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [] },
  anchor: { startQ: zeroQ, endQ: zeroQ }, focus: { startQ: zeroQ, endQ: zeroQ } };
function apply(doc: ScoreDocument, edit: StructureEdit) {
  return applyStructureCommand(doc, { expectedToken: contentToken(doc), edit }, selection);
}
function applied(doc: ScoreDocument, edit: StructureEdit): ScoreDocument {
  const result = apply(doc, edit);
  if (result.kind === 'rejected') throw new Error(JSON.stringify(result.diagnostics));
  return result.nextDoc;
}
describe('arrangement commands', () => {
  it.each(['fretted', 'pitched', 'percussion'] as const)('adds an aligned %s track with four voice lanes', kind => {
    const doc = fixtureDocument('loop-eight-bars');
    const next = applied(doc, { kind: 'addTrack', name: 'New', instrument: { kind, program: 25, bank: 0 } });
    const track = next.tracks.at(-1);
    expect(next.tracks.length).toBe(4);
    expect(track?.name).toBe('New');
    expect(track?.instrument.kind).toBe(kind);
    expect(track?.staves[0]?.voices.map(v => v.number)).toEqual([1, 2, 3, 4]);
    for (const voice of track?.staves[0]?.voices ?? []) expect(voice.bars.map(b => b.measureId)).toEqual(doc.measures.map(m => m.id));
    expect(validateDocument(next)).toEqual([]);
    expect(doc.tracks.length).toBe(3);
  });
  it('duplicates a whole track with new identities and copied event relationships', () => {
    const base = fixtureDocument('loop-eight-bars');
    const first = [...indexDocument(base).events.values()][0];
    if (!first) throw new Error('fixture');
    const doc = applied(base, { kind: 'lyrics', eventId: first.event.id, verse: 1, text: 'Hello', syllabic: 'single', extend: false });
    const track = doc.tracks.find(t => t.staves.some(s => s.id === first.staff.id));
    if (!track) throw new Error('fixture');
    const next = applied(doc, { kind: 'duplicateTrack', trackId: track.id });
    const copy = next.tracks.at(-1);
    expect(copy?.id).not.toBe(track.id);
    expect(copy?.staves[0]?.voices[0]?.bars.length).toBe(8);
    expect(next.lyrics.map(l => l.text)).toEqual(['Hello', 'Hello']);
    expect(new Set(next.lyrics.map(l => l.eventId)).size).toBe(2);
    expect(next.measures).toBe(doc.measures);
    expect(next.tracks[1]).toBe(doc.tracks[1]);
    expect(validateDocument(next)).toEqual([]);
  });
  it.each(['preservePitch', 'preserveFingering'] as const)('retunes with explicit %s policy', policy => {
    const doc = fixtureDocument('loop-eight-bars');
    const location = [...indexDocument(doc).notes.values()][0];
    if (!location) throw new Error('fixture');
    const staff = location.location.staff;
    const before = soundingPitch(location.note, staff);
    const next = applied(doc, { kind: 'tuning', staffId: staff.id, tuning: staff.tuning.map(p => p - 2), capo: 0, policy });
    const after = indexDocument(next).notes.get(location.note.id);
    if (!after) throw new Error('note lost');
    expect(after.location.staff.tuning).toEqual(staff.tuning.map(p => p - 2));
    expect(soundingPitch(after.note, after.location.staff)).toBe(policy === 'preservePitch' ? before : before - 2);
  });
  it('rejects impossible pitch-preserving retuning atomically', () => {
    const doc = fixtureDocument('loop-eight-bars');
    const staff = doc.tracks[0]?.staves[0];
    if (!staff) throw new Error('fixture');
    const original = JSON.stringify(doc);
    expect(apply(doc, { kind: 'tuning', staffId: staff.id, tuning: staff.tuning.map(() => 120), capo: 0, policy: 'preservePitch' }).kind).toBe('rejected');
    expect(JSON.stringify(doc)).toBe(original);
  });
  it.each(['notes', 'instrument'] as const)('transposes using explicit %s policy', policy => {
    const doc = fixtureDocument('loop-eight-bars');
    const track = doc.tracks[0];
    const note = [...indexDocument(doc).notes.values()][0];
    if (!track || !note) throw new Error('fixture');
    const next = applied(doc, { kind: 'transpose', trackIds: [track.id], semitones: 2, policy });
    const after = indexDocument(next).notes.get(note.note.id);
    if (!after) throw new Error('note lost');
    expect(soundingPitch(after.note, after.location.staff)).toBe(soundingPitch(note.note, note.location.staff) + (policy === 'notes' ? 2 : 0));
    expect(next.tracks[0]?.transposition ?? 0).toBe(policy === 'instrument' ? 2 : 0);
  });
  it('changes meter for every track and rejects discarded notes', () => {
    const doc = fixtureDocument('loop-eight-bars');
    const measure = doc.measures[0];
    if (!measure) throw new Error('fixture');
    expect(apply(doc, { kind: 'meter', measureId: measure.id, meter: { beats: 3, unit: 4 } }).kind).toBe('rejected');
    const next = applied(doc, { kind: 'meter', measureId: measure.id, meter: { beats: 5, unit: 4 } });
    expect(next.measures[0]?.actualSpanQ).toEqual({ n: '5', d: '1' });
    expect(validateDocument(next)).toEqual([]);
    for (const track of next.tracks) for (const staff of track.staves) for (const voice of staff.voices) {
      expect(voice.bars.map(b => b.measureId)).toEqual(next.measures.map(m => m.id));
    }
  });
  it('rejects stale inspector commits', () => {
    const doc = fixtureDocument('loop-eight-bars');
    const next = applied(doc, { kind: 'metadata', metadata: { ...doc.metadata, title: 'Changed' } });
    expect(applyStructureCommand(next, { expectedToken: contentToken(doc), edit: { kind: 'metadata', metadata: doc.metadata } }, selection).kind).toBe('rejected');
    expect(next.metadata.title).toBe('Changed');
  });
  it('pastes music and selected metadata into the corresponding destination voice', () => {
    const base = fixtureDocument('loop-eight-bars');
    const location = [...indexDocument(base).events.values()][0], sourceTrack = base.tracks[0];
    if (!location || !sourceTrack) throw new Error('fixture');
    const doc = applied(base, { kind: 'structureBatch', edits: [
      { kind: 'lyrics', eventId: location.event.id, verse: 2, text: 'Word', syllabic: 'begin', extend: true },
      { kind: 'chord', eventId: location.event.id, chord: { name: 'C', root: 0, intervals: [0, 4, 7] } },
      { kind: 'text', eventId: location.event.id, annotations: ['soft'] },
      { kind: 'addTrack', name: 'Destination', instrument: sourceTrack.instrument, tuning: [62, 57, 53, 48, 43, 38] },
    ] });
    const clipboard = copyMusic(doc, { kind: 'timeRange', scope: { trackIds: [sourceTrack.id], staffIds: [], voices: [1] },
      anchor: { startQ: zeroQ, endQ: { n: '1', d: '1' } }, focus: { startQ: { n: '3', d: '1' }, endQ: { n: '4', d: '1' } } });
    const target = doc.tracks.at(-1)?.staves[0]?.voices[0];
    if (!target) throw new Error('fixture');
    const next = applied(doc, { kind: 'specialPaste', target: { clipboard, expectedToken: contentToken(doc),
      startQ: zeroQ, voices: [{ source: location.voiceId, target: target.id }] },
    include: { text: false, lyrics: true, chords: false, automation: false, structure: false } });
    const pasted = [...indexDocument(next).events.values()].find(e => e.voiceId === target.id);
    if (!pasted || pasted.event.kind !== 'noteGroup') throw new Error('Missing pasted note');
    expect(pasted.event.id).not.toBe(location.event.id);
    expect(pasted.event.annotations).toEqual([]);
    expect(pasted.event.notes[0]?.kind === 'fretted' ? pasted.event.notes[0].fret : -1).toBe(5);
    expect(next.lyrics.filter(l => l.eventId === pasted.event.id).map(l => l.text)).toEqual(['Word']);
    expect(next.chords.filter(c => c.eventId === pasted.event.id)).toEqual([]);
    expect(validateDocument(next)).toEqual([]);
  });
  it('replaces automation at one location and rejects out-of-range values', () => {
    const base = fixtureDocument('loop-eight-bars');
    const track = base.tracks[0], measure = base.measures[0];
    if (!track || !measure) throw new Error('fixture');
    const automation = { trackId: track.id, measureId: measure.id, offsetQ: zeroQ, kind: 'pan' as const, value: -0.5 };
    const doc = applied(base, { kind: 'automation', automation });
    const next = applied(doc, { kind: 'automation', automation: { ...automation, value: 0.75 } });
    expect(next.automations).toEqual([{ ...automation, value: 0.75, id: doc.automations[0]?.id }]);
    expect(apply(next, { kind: 'automation', automation: { ...automation, value: 2 } }).kind).toBe('rejected');
  });
  it('removes track-owned relations without damaging remaining tracks', () => {
    const base = fixtureDocument('loop-eight-bars');
    const location = [...indexDocument(base).events.values()][0], track = base.tracks[0];
    if (!location || !track) throw new Error('fixture');
    const doc = applied(base, { kind: 'structureBatch', edits: [
      { kind: 'lyrics', eventId: location.event.id, verse: 1, text: 'Word', syllabic: 'single', extend: false },
      { kind: 'automation', automation: { trackId: track.id, measureId: location.measureId, offsetQ: zeroQ, kind: 'volume', value: 0.5 } },
    ] });
    const next = applied(doc, { kind: 'removeTrack', trackId: track.id });
    expect(next.tracks.map(t => t.id)).toEqual(doc.tracks.slice(1).map(t => t.id));
    expect(next.lyrics).toEqual([]);
    expect(next.automations).toEqual([]);
    expect(validateDocument(next)).toEqual([]);
  });
  it('does not reinterpret populated notes as percussion', () => {
    const doc = fixtureDocument('loop-eight-bars'), track = doc.tracks[0];
    if (!track) throw new Error('fixture');
    expect(apply(doc, { kind: 'instrument', trackId: track.id, instrument: { kind: 'percussion', program: 0, bank: 0 } }).kind).toBe('rejected');
    expect(doc.tracks[0]?.instrument.kind).toBe('fretted');
  });
  it('keeps pitched notes and chord symbols consistent when transposing', () => {
    const base = fixtureDocument('loop-eight-bars'), track = base.tracks[0];
    const event = [...indexDocument(base).events.values()][0];
    if (!track || !event) throw new Error('fixture');
    const doc = applied(base, { kind: 'chord', eventId: event.event.id, chord: { name: 'Cmaj7/E', root: 0, bass: 4, intervals: [0, 4, 7, 11] },
      diagram: { name: 'Cmaj7/E', frets: [0, 0, 0, 2, 3, 0], fingers: ['', '', '', '1', '2', ''], barres: [] } });
    const next = applied(doc, { kind: 'transpose', trackIds: [track.id], semitones: 2, policy: 'notes' });
    expect(next.chords[0]?.name).toBe('Dmaj7/F#');
    expect(next.chords[0]?.root).toBe(2);
    expect(next.chords[0]?.bass).toBe(6);
    expect(next.diagrams.find(d => d.id === next.chords[0]?.diagramId)?.frets).toEqual([2, 2, 2, 4, 5, 2]);
  });
  it('pastes automation without requiring unselected jump destinations', () => {
    const base = fixtureDocument('loop-eight-bars'), track = base.tracks[0];
    const [first, second] = base.measures;
    if (!track || !first || !second) throw new Error('fixture');
    const doc = applied(base, { kind: 'structureBatch', edits: [
      { kind: 'measureControls', measureId: first.id, jumps: [{ kind: 'segno' }] },
      { kind: 'measureControls', measureId: second.id, jumps: [{ kind: 'ds', target: first.id, until: 'end' }] },
      { kind: 'automation', automation: { trackId: track.id, measureId: second.id, offsetQ: zeroQ, kind: 'pan', value: 0.5 } },
      { kind: 'addTrack', name: 'Paste', instrument: track.instrument },
    ] });
    const voice = track.staves[0]?.voices[0], target = doc.tracks.at(-1)?.staves[0]?.voices[0];
    if (!voice || !target) throw new Error('fixture');
    const clipboard = copyMusic(doc, { kind: 'timeRange', scope: { trackIds: [track.id], staffIds: [], voices: [1] },
      anchor: { startQ: { n: '4', d: '1' }, endQ: { n: '5', d: '1' } }, focus: { startQ: { n: '7', d: '1' }, endQ: { n: '8', d: '1' } } });
    const next = applied(doc, { kind: 'specialPaste', target: { clipboard, expectedToken: contentToken(doc), startQ: zeroQ,
      voices: [{ source: voice.id, target: target.id }] }, include: { text: false, chords: false, lyrics: false, automation: true, structure: false } });
    expect(next.measures).toBe(doc.measures);
    expect(next.automations.at(-1)).toMatchObject({ trackId: next.tracks.at(-1)?.id, measureId: first.id, kind: 'pan', value: 0.5 });
  });
});
