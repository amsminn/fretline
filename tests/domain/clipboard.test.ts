import { describe, expect, it } from 'vitest';
import { copyMusic, cutMusic, parseClipboard, pasteMusic } from '../../src/domain/clipboard';
import { applyCommand, contentToken } from '../../src/domain/commands/core';
import { indexDocument, soundingPitch } from '../../src/domain/event-time';
import { createHistory, executeCommand, undo } from '../../src/domain/history';
import { rationalQ } from '../../src/domain/rational';
import type { Selection } from '../../src/domain/selection';
import { parseScoreDocument, validateDocument } from '../../src/domain/validate';
import { fixtureDocument, mapEvents } from './fixtures';

function setup(name = 'unison-strings') {
  const doc = parseScoreDocument(fixtureDocument(name));
  const entry = [...indexDocument(doc).events.values()][0];
  if (!entry) throw new RangeError('Missing fixture');
  const selection: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [1] },
    anchor: { eventId: entry.event.id, startQ: entry.startQ, endQ: entry.endQ },
    focus: { eventId: entry.event.id, startQ: entry.startQ, endQ: entry.endQ } };
  const destination = mapEvents(doc, e => ({ kind: 'rest', id: e.id, duration: e.duration }));
  return { doc, entry, selection, destination };
}
describe('musical clipboard', () => {
  it('preserves pitch on the corresponding retuned string with fresh identities', () => {
    const { doc, entry, selection, destination } = setup();
    const clip = copyMusic(doc, selection);
    const target = { ...destination, tracks: destination.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({
      ...s, tuning: s.tuning.map(p => p - 2),
    })) })) };
    const result = pasteMusic(target, { clipboard: clip, expectedToken: contentToken(target), startQ: rationalQ(0n),
      voices: [{ source: entry.voiceId, target: entry.voiceId }] }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    const copied = [...indexDocument(result.nextDoc).notes.values()][0];
    const source = [...indexDocument(doc).notes.values()][0];
    if (!copied || !source) throw new RangeError('Missing copied note');
    expect(copied.note).toMatchObject({ kind: 'fretted', string: 1, fret: 2 });
    expect(soundingPitch(copied.note, copied.location.staff)).toBe(soundingPitch(source.note, source.location.staff));
    expect(copied.note.id).not.toBe(source.note.id);
    expect(copied.location.event.id).not.toBe(entry.event.id);
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });
  it('rejects unplayable pitch without silently changing string or octave', () => {
    const { doc, entry, selection, destination } = setup();
    const target = { ...destination, tracks: destination.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({
      ...s, tuning: s.tuning.map(p => p + 12),
    })) })) };
    const before = JSON.stringify(target);
    const result = pasteMusic(target, { clipboard: copyMusic(doc, selection), expectedToken: contentToken(target),
      startQ: rationalQ(0n), voices: [{ source: entry.voiceId, target: entry.voiceId }] }, selection);
    expect(result.kind).toBe('rejected');
    expect(result.diagnostics[0]?.message).toContain('revoicing');
    expect(JSON.stringify(target)).toBe(before);
  });
  it('copies complete tuplets and refuses a partial authored group', () => {
    const { doc, entry, selection } = setup('seven-four');
    expect(() => copyMusic(doc, selection)).toThrow('complete tuplet');
    const full: Selection = { ...selection, kind: 'timeRange', focus: { startQ: rationalQ(0n), endQ: rationalQ(4n) } };
    const clip = copyMusic(doc, full);
    const targetVoice = entry.staff.voices[1];
    if (!targetVoice) throw new RangeError('Missing lane');
    const result = pasteMusic(doc, { clipboard: clip, expectedToken: contentToken(doc), startQ: rationalQ(0n),
      voices: [{ source: entry.voiceId, target: targetVoice.id }] }, full);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextDoc.tuplets).toHaveLength(doc.tuplets.length + 1);
    expect(result.nextDoc.tuplets.at(-1)?.eventIds).toHaveLength(7);
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });
  it('round-trips a clipboard through the untrusted JSON boundary and rejects dangling IDs', () => {
    const { doc, selection } = setup();
    const clip = copyMusic(doc, selection);
    expect(parseClipboard(JSON.parse(JSON.stringify(clip)))).toEqual(clip);
    expect(() => parseClipboard({ ...clip, eventIds: [doc.id] })).toThrow('identities');
    expect(() => parseClipboard({ ...clip, version: 2 })).toThrow('Invalid musical clipboard');
  });
  it('preserves history and selection when clipboard writing fails', async () => {
    const { doc, selection } = setup();
    let history = await createHistory(doc, selection);
    const before = history;
    const result = await cutMusic({ current: () => history, commit: (expected, next) => {
      if (history !== expected) return false;
      history = next; return true;
    } }, () => Promise.reject(new Error('clipboard unavailable')));
    expect(result.kind).toBe('rejected');
    expect(history).toBe(before);
    expect(result.history).toBe(before);
  });
  it('cuts only after a successful clipboard write and restores exact roots on undo', async () => {
    const { doc, selection, entry } = setup();
    let history = await createHistory(doc, selection);
    const before = history;
    const result = await cutMusic({ current: () => history, commit: (expected, next) => {
      if (history !== expected) return false;
      history = next; return true;
    } }, clipboard => {
      expect(history).toBe(before);
      expect(clipboard.eventIds).toEqual([entry.event.id]);
      return Promise.resolve();
    });
    expect(result.kind).toBe('applied');
    expect(indexDocument(history.present.doc).events.get(entry.event.id)?.event.kind).toBe('rest');
    expect(undo(history).present).toBe(before.present);
  });
  it('rejects a cut when another edit wins during the clipboard write', async () => {
    const { doc, selection } = setup();
    const note = [...indexDocument(doc).notes.values()][0]?.note;
    if (!note) throw new RangeError('Missing note');
    let history = await createHistory(doc, selection);
    let changed = history;
    const result = await cutMusic({ current: () => history, commit: (expected, next) => {
      if (history !== expected) return false;
      history = next; return true;
    } }, async () => {
      changed = (await executeCommand(history, { expectedToken: contentToken(doc), edit: { kind: 'setFret', noteId: note.id, fret: 7 } })).history;
      history = changed;
    });
    expect(result.kind).toBe('rejected');
    expect(history).toBe(changed);
    expect(history.past).toHaveLength(1);
    expect(indexDocument(history.present.doc).notes.get(note.id)?.note).toMatchObject({ fret: 7 });
  });
  it('copies internal ties using fresh endpoint IDs', () => {
    const { doc, entry, selection } = setup();
    const split = applyCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'split', eventId: entry.event.id, atQ: rationalQ(1n, 2n) } }, selection);
    if (split.kind !== 'applied') throw new RangeError('Split failed');
    const range: Selection = { ...selection, kind: 'timeRange' };
    const target = entry.staff.voices[1];
    if (!target) throw new RangeError('Missing voice');
    const result = pasteMusic(split.nextDoc, { clipboard: copyMusic(split.nextDoc, range), expectedToken: contentToken(split.nextDoc),
      startQ: rationalQ(0n), voices: [{ source: entry.voiceId, target: target.id }] }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextDoc.ties).toHaveLength(2);
    const copiedTie = result.nextDoc.ties[1];
    expect(copiedTie?.from).not.toBe(split.nextDoc.ties[0]?.from);
    expect(copiedTie?.to).not.toBe(split.nextDoc.ties[0]?.to);
    expect(validateDocument(result.nextDoc)).toEqual([]);
  });
});
