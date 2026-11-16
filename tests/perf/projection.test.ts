import { describe, expect, it } from 'vitest';
import { ScoreProjector } from '../../src/adapters/alphatab/project';
import { applyCommand, contentToken } from '../../src/domain/commands/core';
import { indexDocument } from '../../src/domain/event-time';
import { firstSelection, perfDocument } from '../domain/perf-fixture';
import { fixtureDocument, mapEvents } from '../domain/fixtures';
import { updateEvents } from '../../src/domain/commands/core';

describe('renderer projection work', () => {
  it('drops old cross-bar effect links when a legato source is removed', () => {
    const base = mapEvents(fixtureDocument('unison-strings'), event => event.kind === 'noteGroup' ?
      { ...event, notes: event.notes.map(note => note.kind === 'fretted' ? { ...note, string: 1 } : note) } : event);
    const notes = [...indexDocument(base).notes.values()];
    const from = notes[3];
    const to = notes[4];
    if (!from || !to) throw new RangeError('Missing cross-bar notes');
    const document = updateEvents(base, event => [event.id === from.location.event.id && event.kind === 'noteGroup' ?
      { ...event, notes: event.notes.map(note => ({ ...note, techniques: [{ kind: 'legato' as const, target: to.note.id }] })) } : event]);
    const projector = new ScoreProjector();
    const before = projector.project(document);
    expect(before.identity.notes.get(to.note.id)?.hammerPullOrigin?.id).toBe(before.identity.notes.get(from.note.id)?.id);
    const changed = applyCommand(document, { expectedToken: contentToken(document),
      edit: { kind: 'putNote', eventId: from.location.event.id, note: from.note } }, firstSelection(document));
    if (changed.kind !== 'applied') throw new TypeError('Effect removal rejected');

    const after = projector.project(changed.nextDoc);

    expect(after.identity.notes.get(to.note.id)?.hammerPullOrigin).toBeNull();
    expect(after.identity.notes.get(to.note.id)?.effectSlurOrigin).toBeNull();
  });

  it('reuses unchanged bars and publishes fresh pitch and identity for the edited bar', () => {
    const document = perfDocument();
    const track = document.tracks[0];
    const note = indexDocument(document).notes.values().next().value;
    if (!track || !note || note.note.kind !== 'fretted') throw new RangeError('Missing edit target');
    const projector = new ScoreProjector();
    const first = projector.project(document, [track.id]);
    const oldPitch = first.identity.notes.get(note.note.id)?.realValue;
    if (oldPitch === undefined) throw new RangeError('Missing projected pitch');
    const bars = [...first.score.tracks[0]?.staves[0]?.bars ?? []];
    const changedFret = note.note.fret + 1;
    const edited = applyCommand(document, { expectedToken: contentToken(document),
      edit: { kind: 'setFret', noteId: note.note.id, fret: changedFret } }, firstSelection(document));
    if (edited.kind !== 'applied') throw new TypeError('Fixture edit rejected');

    const next = projector.project(edited.nextDoc, [track.id]);

    const after = next.score.tracks[0]?.staves[0]?.bars ?? [];
    expect(after).toHaveLength(256);
    expect(after.filter((bar, i) => bar !== bars[i])).toHaveLength(1);
    expect(next.identity.notes.get(note.note.id)?.fret).toBe(changedFret);
    expect(next.identity.notes.get(note.note.id)?.realValue).toBe(oldPitch + 1);
    const engine = next.identity.notes.get(note.note.id);
    expect(engine && next.identity.noteIds.get(engine.id)).toBe(note.note.id);
    expect(document.tracks[0]).toBe(track);
  });

  it('builds only requested parts while keeping original measure identities and releasing hidden parts', () => {
    const document = perfDocument();
    const first = document.tracks[0];
    const second = document.tracks[1];
    if (!first || !second) throw new RangeError('Missing parts');
    const projector = new ScoreProjector();
    projector.project(document, [first.id]);

    const projection = projector.project(document, [second.id]);

    expect([...projection.identity.tracks.keys()]).toEqual([second.id]);
    expect(projection.score.tracks).toHaveLength(1);
    expect([...projection.identity.measures.keys()]).toEqual(document.measures.map(measure => measure.id));
    const expected = indexDocument({ ...document, tracks: [second] });
    expect([...projection.identity.notes.keys()]).toEqual([...expected.notes.keys()]);
  });
});
