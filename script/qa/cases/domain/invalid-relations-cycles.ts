import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { DomainError } from '../../../../src/domain/diagnostics';
import { parseScoreDocument } from '../../../../src/domain/validate';
import { compileOccurrences } from '../../../../src/domain/timeline';
import { fixtureDocument, fixtureId, mapEvents } from '../../../../tests/domain/fixtures';

export const run: QaCase = async context => {
  const source = fixtureDocument('unison-strings');
  const cases = [
    { name: 'dangling-tie', expectedCode: 'TIE', input: { ...source,
      ties: [{ id: fixtureId('tie', 'invalid'), from: fixtureId('note', 'absent-a'), to: fixtureId('note', 'absent-b') }] } },
    { name: 'voice-underfill', expectedCode: 'VOICE', input: mapEvents(source, e => ({ ...e, duration: { base: 8, dots: 0, tupletIds: [] } })) },
    { name: 'excessive-repeat-cycle', expectedCode: 'TRAVERSAL_LIMIT', input: { ...source,
      measures: source.measures.map((m, i) => ({ ...m, repeats: { start: i === 0, ...(i === 1 ? { totalPlays: Number.MAX_SAFE_INTEGER } : {}) } })) } },
    { name: 'dangling-segno', expectedCode: 'JUMP', input: { ...source,
      measures: source.measures.map(m => ({ ...m, jumps: [{ kind: 'ds', target: fixtureId('measure', 'absent'), until: 'coda' }] })) } },
  ];
  for (const scenario of cases) {
    const before = JSON.stringify(scenario.input);
    let rejected: DomainError | undefined;
    try {
      const doc = parseScoreDocument(scenario.input);
      compileOccurrences(doc, { followRepeats: true });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      rejected = error;
    }
    context.assert(rejected !== undefined, `${scenario.name}: document is rejected`);
    context.assert(rejected?.diagnostics.some(d => d.code === scenario.expectedCode && d.path.length > 0 && d.message.length > 0) === true,
      `${scenario.name}: structured diagnostic identifies the violated relation or visit limit`);
    context.assert(JSON.stringify(scenario.input) === before, `${scenario.name}: original document remains byte-for-byte unchanged`);
    await writeFile(resolve(context.evidence, `${scenario.name}.json`), JSON.stringify({
      source: JSON.parse(before), after: scenario.input, diagnostics: rejected?.diagnostics,
    }, null, 2));
  }
  context.log('Rejected malformed relations and a cyclic repeat path without returning partial occurrences');
};
