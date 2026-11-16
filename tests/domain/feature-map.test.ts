import { expect, it } from 'vitest';
import { featureMap } from '../../src/domain/feature-map';
import { articulationFeatureMap } from '../../src/domain/commands/articulations';
import { copyMusic, pasteMusic } from '../../src/domain/clipboard';
import { contentToken } from '../../src/domain/commands/core';
import { asRest } from '../../src/domain/commands/notes';
import { indexDocument } from '../../src/domain/event-time';
import { rationalQ, zeroQ } from '../../src/domain/rational';
import { projectScore } from '../../src/adapters/alphatab/project';
import { fixtureDocument, mapEvents } from './fixtures';

it('publishes the canonical articulation preservation rules through the shared inventory', () => {
  expect(featureMap).toMatchObject({ articulations: articulationFeatureMap });
});

it('copies and projects an articulation-bearing fixture without unexpected loss diagnostics', () => {
  const bend = { kind: 'bend', points: [
    { position: zeroQ, semitones: zeroQ }, { position: rationalQ(1n), semitones: rationalQ(2n) },
  ] } as const;
  const doc = mapEvents(fixtureDocument('unison-strings'), event => event.kind === 'noteGroup' ? {
    ...event, notes: event.notes.map(note => ({ ...note, techniques: [bend, { kind: 'palmMute' }, { kind: 'accent' }] })),
  } : event);
  const first = [...indexDocument(doc).events.values()][0];
  if (!first) throw new RangeError('Missing fixture beat');
  const point = { eventId: first.event.id, startQ: first.startQ, endQ: first.endQ };
  const selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [1] }, anchor: point, focus: point } as const;
  const clipboard = copyMusic(doc, selection);
  const destination = mapEvents(doc, asRest);
  const pasted = pasteMusic(destination, { clipboard, expectedToken: contentToken(destination), startQ: zeroQ,
    voices: [{ source: first.voiceId, target: first.voiceId }] }, selection);
  if (pasted.kind === 'rejected') throw new RangeError(JSON.stringify(pasted.diagnostics));
  const note = [...indexDocument(pasted.nextDoc).notes.values()][0]?.note;
  expect(note?.techniques).toEqual([bend, { kind: 'palmMute' }, { kind: 'accent' }]);
  const projection = projectScore(pasted.nextDoc);
  expect(projection.diagnostics).toEqual([]);
  const projected = note ? projection.identity.notes.get(note.id) : undefined;
  expect(projected?.bendPoints?.map(p => [p.offset, p.value])).toEqual([[0, 0], [60, 4]]);
  expect(projected?.isPalmMute).toBe(true);
  expect(projected?.accentuated).toBe(1);
});
