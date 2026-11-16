import { expect, it } from 'vitest';
import { freezeRoot } from '../../src/domain/commands/core';
import { validationIndex } from '../../src/domain/validate-index';
import { hasScopedValues } from '../../src/domain/validate-shape';
import { fixtureDocument, fixtureId } from './fixtures';

it('rechecks rational values beneath a shallow-frozen parent after mutation', () => {
  const child = { n: '1', d: '1' };
  const value = Object.freeze({ child });
  expect(hasScopedValues(value)).toBe(true);

  child.n = '2';
  child.d = '2';

  expect(hasScopedValues(value)).toBe(false);
});

it.each(['root', 'track'] as const)('rebuilds an index when a shallow-frozen %s has a mutated note identity', kind => {
  const doc = fixtureDocument('unison-strings');
  switch (kind) {
    case 'root': Object.freeze(doc); break;
    case 'track': for (const track of doc.tracks) Object.freeze(track); break;
    default: { const exhaustive: never = kind; throw new TypeError(String(exhaustive)); }
  }
  const first = validationIndex(doc).notes.values().next().value;
  if (!first) throw new TypeError('Missing note');
  const previous = first.note.id;
  const replacement = fixtureId('note', 'mutable-child');

  Reflect.set(first.note, 'id', replacement);

  const updated = validationIndex(doc);
  expect(updated.notes.has(previous)).toBe(false);
  expect(updated.notes.get(replacement)?.note).toBe(first.note);
});

it('rebuilds a frozen track index after its shallow-frozen measures dependency changes', () => {
  const doc = fixtureDocument('loop-eight-bars');
  freezeRoot(doc.tracks);
  Object.freeze(doc.measures);
  const first = doc.measures[0];
  const second = doc.measures[1];
  if (!first || !second) throw new TypeError('Missing measures');
  const event = [...validationIndex(doc).events.values()].find(value => value.measureId === second.id);
  if (!event) throw new TypeError('Missing second measure event');
  expect(event.startQ).toEqual({ n: '4', d: '1' });

  Reflect.set(first.actualSpanQ, 'n', '8');

  expect(validationIndex(doc).events.get(event.event.id)?.startQ).toEqual({ n: '8', d: '1' });
});

it('rebuilds a frozen track index after its shallow-frozen tuplet dependency changes', () => {
  const doc = fixtureDocument('seven-four');
  freezeRoot(doc.tracks);
  freezeRoot(doc.measures);
  Object.freeze(doc.tuplets);
  const tuplet = doc.tuplets[0];
  const eventId = tuplet?.eventIds[0];
  if (!tuplet || !eventId) throw new TypeError('Missing tuplet');
  const before = validationIndex(doc).events.get(eventId);
  if (!before) throw new TypeError('Missing tuplet event');

  Reflect.set(tuplet, 'normal', tuplet.normal * 2);

  const after = validationIndex(doc).events.get(eventId);
  expect(after?.endQ).not.toEqual(before.endQ);
});
