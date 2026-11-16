import { expect, it, vi } from 'vitest';
import { applyCommand, contentToken, freezeRoot } from '../../src/domain/commands/core';
import * as scoped from '../../src/domain/validate-scoped';
import { validateDocument } from '../../src/domain/validate';
import { fixtureDocument } from './fixtures';
import { firstSelection, perfDocument, recordDomainEvidence } from './perf-fixture';
import { randomEdit, seededRandom } from './scoped-sequences';

it('matches full verdicts and diagnostic codes throughout 2000 seeded command sequences', () => {
  const fixtures = ['unison-strings', 'seven-four', 'pickup-6-8', 'alternate-endings', 'ds-al-coda', 'loop-eight-bars']
    .map(name => freezeRoot(fixtureDocument(name)));
  const perf = perfDocument();
  const original = scoped.validateScoped;
  let compared = 0;
  let accepted = 0;
  let rejected = 0;
  const kinds = new Set<string>();
  const validator = vi.spyOn(scoped, 'validateScoped').mockImplementation((before, after) => {
    const actual = original(before, after);
    const expected = validateDocument(after);
    expect(actual.map(d => d.code)).toEqual(expected.map(d => d.code));
    expect(actual.length === 0).toBe(expected.length === 0);
    compared++;
    return actual;
  });
  try {
    for (let sequence = 0; sequence < 2000; sequence++) {
      const random = seededRandom(0xdefaced + sequence);
      // Twenty independent large-score sequences plus all six task-2 musical cases.
      let doc = sequence % 100 === 0 ? perf : fixtures[sequence % fixtures.length];
      if (!doc) throw new RangeError('Missing sequence fixture');
      let selection = firstSelection(doc);
      const length = 3 + Math.floor(random() * 4);
      for (let step = 0; step < length; step++) {
        const edit = randomEdit(doc, random);
        kinds.add(edit.kind);
        const result = applyCommand(doc, { expectedToken: contentToken(doc), edit }, selection);
        // Also compare execution-stage rejections against the full-validation command path.
        validator.mockImplementationOnce((_before, after) => validateDocument(after));
        const oracle = applyCommand(doc, { expectedToken: contentToken(doc), edit }, selection);
        // An execution-stage rejection never consumes mockImplementationOnce.
        validator.mockReset().mockImplementation((before, after) => {
          const actual = original(before, after);
          const expected = validateDocument(after);
          expect(actual.map(d => d.code)).toEqual(expected.map(d => d.code));
          compared++;
          return actual;
        });
        expect(result.kind).toBe(oracle.kind);
        expect(result.diagnostics.map(d => d.code)).toEqual(oracle.diagnostics.map(d => d.code));
        switch (result.kind) {
          case 'applied': accepted++; doc = result.nextDoc; selection = result.nextSelection; break;
          case 'rejected': rejected++; break;
        }
      }
    }
  } finally {
    validator.mockRestore();
  }
  expect(kinds.size).toBe(13);
  expect(accepted).toBeGreaterThan(2000);
  expect(rejected).toBeGreaterThan(1000);
  expect(compared).toBeGreaterThan(4000);
  console.log('SCOPED_EQUIVALENCE', JSON.stringify({ sequences: 2000, perfSequences: 20, compared, accepted, rejected, kinds: [...kinds].sort() }));
  recordDomainEvidence('equivalence', { sequences: 2000, perfSequences: 20, compared, accepted, rejected, kinds: [...kinds].sort() });
}, 600000);
