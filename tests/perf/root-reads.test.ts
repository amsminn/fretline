import { afterEach, expect, it, vi } from 'vitest';
import { applyCommand, contentToken } from '../../src/domain/commands/core';
import { indexDocument } from '../../src/domain/event-time';
import { validationIndex } from '../../src/domain/validate-index';
import { compileOccurrences } from '../../src/domain/timeline';
import * as rational from '../../src/domain/rational';
import * as schema from '../../src/domain/schema/check';
import { arrangementSeconds } from '../../src/renderer/toolbar/Lcd';
import { describeSelection, focusTargets } from '../../src/renderer/editor/focus';
import { firstSelection, perfDocument } from '../domain/perf-fixture';
import { parseScoreDocument } from '../../src/domain/validate';
import { editTargets } from '../../src/renderer/editor/targets';

afterEach(() => { vi.restoreAllMocks(); });

it('shares an edited immutable root with zero repeated schema or index arithmetic across shell consumers', () => {
  const score = perfDocument();
  const target = indexDocument(score).notes.values().next().value;
  if (!target || target.note.kind !== 'fretted') throw new TypeError('Missing performance note');
  const changed = applyCommand(score, { expectedToken: contentToken(score),
    edit: { kind: 'setFret', noteId: target.note.id, fret: target.note.fret + 1 } }, firstSelection(score));
  if (changed.kind !== 'applied') throw new TypeError('Performance edit rejected');
  const root = changed.nextDoc;
  const index = indexDocument(root);
  const traversal = compileOccurrences(root, { followRepeats: true });
  const targets = editTargets(root);
  const additions = vi.spyOn(rational, 'addQ');
  const checks = vi.spyOn(schema, 'checkSchema');

  for (let consumer = 0; consumer < 4; consumer++) {
    expect(arrangementSeconds(root)).toBe(512);
    expect(describeSelection(root, changed.nextSelection)).toBe('마디 1 박 1 커서');
    expect(focusTargets(root, changed.nextSelection)).toHaveLength(1);
    expect(indexDocument(root)).toBe(index);
    expect(validationIndex(root)).toBe(index);
    expect(compileOccurrences(root, { followRepeats: true })).toBe(traversal);
    expect(editTargets(root)).toBe(targets);
  }

  expect(additions).toHaveBeenCalledTimes(0);
  expect(checks).toHaveBeenCalledTimes(0);
  expect(index.notes.get(target.note.id)?.note).toMatchObject({ fret: target.note.fret + 1 });
  expect(indexDocument(score).notes.get(target.note.id)?.note).toMatchObject({ fret: target.note.fret });
});

it('validates a distinct untrusted root even when it reuses a previously compiled document id', () => {
  const score = perfDocument();
  compileOccurrences(score, { followRepeats: true });
  const invalid = { ...score, measures: score.measures.map((measure, index) =>
    index ? measure : { ...measure, actualSpanQ: { n: '0', d: '1' } }) };

  expect(() => parseScoreDocument(invalid)).toThrow();
  expect(() => compileOccurrences(invalid, { followRepeats: true })).toThrow();
});
