import { describe, expect, it } from 'vitest';
import { barSlots } from '../../src/domain/bar-slot';
import { applyCommand, contentToken } from '../../src/domain/commands/core';
import type { Edit } from '../../src/domain/commands/core';
import { selectVoice } from '../../src/domain/commands/voices';
import { copyMusic, pasteMusic } from '../../src/domain/clipboard';
import type { ScoreDocument } from '../../src/domain/document';
import { indexDocument } from '../../src/domain/event-time';
import { createHistory, executeCommand, hashDocument, redo, undo } from '../../src/domain/history';
import { rationalQ, zeroQ } from '../../src/domain/rational';
import { transformSelection } from '../../src/domain/selection-transform';
import { normalizeSelection } from '../../src/domain/selection';
import type { Selection } from '../../src/domain/selection';
import { parseScoreDocument, validateDocument } from '../../src/domain/validate';
import { fixtureDocument, fixtureId } from './fixtures';

const quarter = { base: 4, dots: 0, tupletIds: [] } as const;
function setup(span = rationalQ(4n), beats = 4) {
  const source = fixtureDocument('unison-strings');
  const document: ScoreDocument = { ...source, measures: source.measures.map((measure, i) =>
    ({ ...measure, meter: { beats, unit: 4 }, actualSpanQ: i === 0 ? span : rationalQ(BigInt(beats)) })),
  tracks: source.tracks.map(track => ({ ...track, staves: track.staves.map(staff => ({ ...staff,
    voices: staff.voices.map(voice => ({ ...voice, bars: voice.bars.map(bar =>
      ({ kind: 'inactive', measureId: bar.measureId })) })),
  })) })) };
  const slot = barSlots(document)[0];
  if (!slot) throw new RangeError('Missing fixture slot');
  const point = { barSlot: slot.barSlot, startQ: slot.startQ, endQ: slot.endQ };
  const selection: Selection = { kind: 'barSlot', anchor: point, focus: point, string: 3, duration: quarter,
    scope: { trackIds: [slot.trackId], staffIds: [slot.staff.id], voices: [slot.voice.number] } };
  const event = { kind: 'noteGroup', id: fixtureId('event', 'empty-entry'), duration: quarter,
    notes: [{ kind: 'fretted', id: fixtureId('note', 'empty-entry'), string: 3, fret: 12, techniques: [] }] } as const;
  const edit: Edit = { kind: 'activateBar', target: slot.barSlot, event };
  return { document, slot, selection, edit, event };
}
describe('inactive bar transactions', () => {
  it.each([{ span: rationalQ(4n), beats: 4, count: 4 }, { span: rationalQ(7n), beats: 7, count: 7 },
    { span: rationalQ(1n), beats: 4, count: 1 }])('enters at bar start and fills $beats/4 span $span exactly', ({ span, beats, count }) => {
    const { document, slot, selection, edit, event } = setup(span, beats);
    const before = JSON.stringify(document);
    const result = applyCommand(document, { expectedToken: contentToken(document), edit }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    const entries = [...indexDocument(result.nextDoc).events.values()];
    expect(entries).toHaveLength(count);
    expect(entries[0]).toMatchObject({ event, startQ: zeroQ });
    expect(entries.at(-1)?.endQ).toEqual(span);
    expect(entries.slice(1).map(entry => entry.event.kind)).toEqual(Array.from({ length: count - 1 }, () => 'rest'));
    expect(result.nextSelection).toMatchObject({ kind: 'caret', focus: { eventId: event.id } });
    expect(result.nextDoc.tracks[0]?.staves[0]?.voices[1]).toBe(slot.staff.voices[1]);
    expect(validateDocument(result.nextDoc)).toEqual([]);
    expect(JSON.stringify(document)).toBe(before);
  });
  it('rejects stale activation and overlong entry without mutating the root', () => {
    const { document, selection, edit, slot, event } = setup();
    expect(applyCommand(document, { expectedToken: 'stale', edit }, selection)).toMatchObject({ kind: 'rejected',
      diagnostics: [{ code: 'REFERENCE', path: 'expectedToken' }] });
    const result = applyCommand(document, { expectedToken: contentToken(document),
      edit: { kind: 'activateBar', target: slot.barSlot, event: { ...event, duration: { ...quarter, base: 1, dots: 1 } } } }, selection);
    expect(result.kind).toBe('rejected');
    expect(indexDocument(document).events.size).toBe(0);
  });
  it('rest entry is active and one undo restores inactive content and the exact caret; redo reuses IDs', async () => {
    const { document, slot, selection, event } = setup();
    const history = await createHistory(document, selection);
    const result = await executeCommand(history, { expectedToken: contentToken(document),
      edit: { kind: 'activateBar', target: slot.barSlot, event: { kind: 'rest', id: event.id, duration: quarter } } });
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.history.past).toHaveLength(1);
    expect(indexDocument(result.history.present.doc).events.get(event.id)?.event.kind).toBe('rest');
    const undone = undo(result.history);
    expect(undone.present).toEqual(history.present);
    expect(undone.present.selection).toBe(selection);
    expect(redo(undone).present).toBe(result.history.present);
    expect((await hashDocument(parseScoreDocument(document))).sha256).toBe(history.present.contentHash.sha256);
  });
  it('selects an inactive second voice without activating it and edits only that voice', () => {
    const source = fixtureDocument('unison-strings');
    const first = [...indexDocument(source).events.values()][0];
    if (!first) throw new RangeError('Missing event');
    const point = { eventId: first.event.id, startQ: first.startQ, endQ: first.endQ };
    const original: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [first.staff.id], voices: [1] }, anchor: point, focus: point };
    const selection = selectVoice(source, original, 2);
    expect(selection).toMatchObject({ kind: 'barSlot', scope: { voices: [2] } });
    if (selection.kind !== 'barSlot') throw new RangeError('Expected slot');
    const { event } = setup();
    const result = applyCommand(source, { expectedToken: contentToken(source),
      edit: { kind: 'activateBar', target: selection.focus.barSlot, event } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextDoc.tracks[0]?.staves[0]?.voices[0]).toBe(source.tracks[0]?.staves[0]?.voices[0]);
    expect(source.tracks[0]?.staves[0]?.voices[1]?.bars[0]?.kind).toBe('inactive');
  });
  it('retains slot identity through insertion and remaps a removed bar to the next inactive bar', () => {
    const { document, selection } = setup();
    const first = document.measures[0];
    if (!first) throw new RangeError('Missing measure');
    const inserted = { ...first, id: fixtureId('measure', 'before-empty') };
    const after: ScoreDocument = { ...document, measures: [inserted, ...document.measures],
      tracks: document.tracks.map(track => ({ ...track, staves: track.staves.map(staff => ({ ...staff,
        voices: staff.voices.map(voice => ({ ...voice, bars: [{ kind: 'inactive', measureId: inserted.id }, ...voice.bars] })),
      })) })) };
    expect(transformSelection({ before: document, after, selection })).toMatchObject({ kind: 'barSlot',
      anchor: { barSlot: selection.anchor.barSlot, startQ: rationalQ(4n), endQ: rationalQ(8n) } });
    const result = applyCommand(document, { expectedToken: contentToken(document),
      edit: { kind: 'deleteMeasures', measureIds: [first.id] } }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextSelection).toMatchObject({ kind: 'barSlot', focus: { barSlot: { measureId: document.measures[1]?.id }, startQ: zeroQ } });
  });
  it('rejects copying an empty caret and accepts paste into its inactive voice', () => {
    const { document, selection, slot } = setup();
    expect(() => copyMusic(document, selection)).toThrow('Selection contains no events');
    const source = fixtureDocument('unison-strings');
    const event = [...indexDocument(source).events.values()][0];
    if (!event) throw new RangeError('Missing source');
    const point = { eventId: event.event.id, startQ: event.startQ, endQ: event.endQ };
    const clipboard = copyMusic(source, { kind: 'caret', anchor: point, focus: point, scope: selection.scope });
    const result = pasteMusic(document, { clipboard, expectedToken: contentToken(document), startQ: zeroQ,
      voices: [{ source: event.voiceId, target: slot.voice.id }] }, selection);
    expect(result.kind).toBe('applied');
  });
  it('normalizes a reverse empty-bar range to its full silent time span', () => {
    const { document, slot, selection } = setup();
    const second = barSlots(document).find(candidate => candidate.voice.id === slot.voice.id && candidate.barSlot.measureId !== slot.barSlot.measureId);
    if (!second) throw new RangeError('Missing second slot');
    const normalized = normalizeSelection({ kind: 'timeRange', scope: selection.scope,
      anchor: { barSlot: second.barSlot, startQ: second.startQ, endQ: second.endQ }, focus: selection.focus });
    expect(normalized).toMatchObject({ direction: 'reverse', range: { startQ: zeroQ, endQ: rationalQ(8n) } });
  });
});
