import { describe, expect, it } from 'vitest';
import { applyStructureCommand } from '../../src/domain/commands/structure';
import { contentToken } from '../../src/domain/commands/core';
import { compileOccurrences } from '../../src/domain/timeline';
import { zeroQ } from '../../src/domain/rational';
import type { Selection } from '../../src/domain/selection';
import { fixtureDocument, measureOrder } from './fixtures';

const selection: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [] },
  anchor: { startQ: zeroQ, endQ: zeroQ }, focus: { startQ: zeroQ, endQ: zeroQ } };
describe('repeat editing', () => {
  it('commits alternate endings as one valid traversal', () => {
    const doc = fixtureDocument('loop-eight-bars');
    const [m1, , m3, m4] = doc.measures;
    if (!m1 || !m3 || !m4) throw new Error('fixture');
    const result = applyStructureCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'structureBatch', edits: [
      { kind: 'measureControls', measureId: m1.id, repeats: { start: true } },
      { kind: 'measureControls', measureId: m3.id, repeats: { start: false, totalPlays: 2 }, endings: [1] },
      { kind: 'measureControls', measureId: m4.id, endings: [2] },
    ] } }, selection);
    if (result.kind === 'rejected') throw new Error(JSON.stringify(result.diagnostics));
    expect(measureOrder(result.nextDoc, compileOccurrences(result.nextDoc, { followRepeats: true }))).toEqual([1, 2, 3, 1, 2, 4, 5, 6, 7, 8]);
  });
  it('rejects dangling D.S. without changing the source', () => {
    const doc = fixtureDocument('loop-eight-bars');
    const [first, second] = doc.measures;
    if (!first || !second) throw new Error('fixture');
    const result = applyStructureCommand(doc, { expectedToken: contentToken(doc),
      edit: { kind: 'measureControls', measureId: second.id, jumps: [{ kind: 'ds', target: first.id, until: 'fine' }] } }, selection);
    expect(result.kind).toBe('rejected');
    expect(doc.measures[1]?.jumps).toEqual([]);
  });
  it('rejects traversal exceeding the visit bound atomically', () => {
    const doc = fixtureDocument('loop-eight-bars');
    const [first, second, third, fourth] = doc.measures;
    if (!first || !second || !third || !fourth) throw new Error('fixture');
    const result = applyStructureCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'structureBatch', edits: [
      { kind: 'measureControls', measureId: first.id, repeats: { start: true } },
      { kind: 'measureControls', measureId: second.id, repeats: { start: true } },
      { kind: 'measureControls', measureId: third.id, repeats: { start: false, totalPlays: 100 } },
      { kind: 'measureControls', measureId: fourth.id, repeats: { start: false, totalPlays: 100 } },
    ] } }, selection);
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.diagnostics.some(d => d.code === 'TRAVERSAL_LIMIT')).toBe(true);
    expect(doc.measures.every(m => !m.repeats.start && m.repeats.totalPlays === undefined)).toBe(true);
  });
  it('resolves D.S. al Fine only after the one-shot return', () => {
    const doc = fixtureDocument('loop-eight-bars');
    const [first, second, third] = doc.measures;
    if (!first || !second || !third) throw new Error('fixture');
    const result = applyStructureCommand(doc, { expectedToken: contentToken(doc), edit: { kind: 'structureBatch', edits: [
      { kind: 'measureControls', measureId: first.id, jumps: [{ kind: 'segno' }] },
      { kind: 'measureControls', measureId: second.id, jumps: [{ kind: 'fine' }] },
      { kind: 'measureControls', measureId: third.id, jumps: [{ kind: 'ds', target: first.id, until: 'fine' }] },
    ] } }, selection);
    if (result.kind === 'rejected') throw new Error(JSON.stringify(result.diagnostics));
    expect(measureOrder(result.nextDoc, compileOccurrences(result.nextDoc, { followRepeats: true }))).toEqual([1, 2, 3, 1, 2]);
  });
  it('rejects an unclosed repeat start instead of publishing a broken arrangement', () => {
    const doc = fixtureDocument('loop-eight-bars'), first = doc.measures[0];
    if (!first) throw new Error('fixture');
    const result = applyStructureCommand(doc, { expectedToken: contentToken(doc), edit: {
      kind: 'measureControls', measureId: first.id, repeats: { start: true },
    } }, selection);
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.diagnostics.some(d => d.code === 'REPEAT')).toBe(true);
  });
});
