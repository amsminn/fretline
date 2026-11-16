import { expect, it } from 'vitest';
import { applyStructureCommand } from '../../src/domain/commands/structure';
import { contentToken, freezeRoot } from '../../src/domain/commands/core';
import { validateScoped } from '../../src/domain/validate-scoped';
import { validateDocument } from '../../src/domain/validate';
import { schemaValidationWork } from '../../src/domain/schema/check';
import { firstSelection, perfDocument, recordDomainEvidence } from '../domain/perf-fixture';

it('validates only the changed path of performance score metadata', () => {
  const doc = perfDocument();
  const selection = firstSelection(doc);
  const before = schemaValidationWork().visitedNodes;

  const result = applyStructureCommand(doc, { expectedToken: contentToken(doc),
    edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'Changed' } } }, selection);

  expect(result.kind).toBe('applied');
  const visitedNodes = schemaValidationWork().visitedNodes - before;
  expect(visitedNodes).toBeLessThanOrEqual(64);
  recordDomainEvidence('metadata-schema', { visitedNodes, maximum: 64 });
});

it('rejects an invalid frozen cloned subtree that has not been certified', () => {
  const doc = perfDocument();
  const measures = structuredClone(doc.measures).map((measure, index) => index ? measure
    : { ...measure, meter: { ...measure.meter, beats: 0 } });
  const after = freezeRoot({ ...doc, measures, metadata: { ...doc.metadata, title: 'Changed' } });

  const expected = validateDocument(after);

  expect(expected.length).toBeGreaterThan(0);
  expect(validateScoped(doc, after)).toEqual(expected);
});

it('keeps the exact invalid metadata diagnostic and JSON path', () => {
  const doc = perfDocument();

  const result = applyStructureCommand(doc, { expectedToken: contentToken(doc),
    edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'x'.repeat(65537) } } }, firstSelection(doc));

  expect(result).toEqual({ kind: 'rejected', diagnostics: [
    { code: 'SCHEMA', path: '/metadata/title', message: 'String does not match schema' },
  ] });
});
