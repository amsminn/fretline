import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { parseScoreDocument } from '../../src/domain/validate';
import type { ScoreDocument } from '../../src/domain/document';
import { indexDocument } from '../../src/domain/event-time';
import type { Selection } from '../../src/domain/selection';

export function perfDocument(): ScoreDocument {
  const entries = unzipSync(readFileSync('tests/fixtures/projects/perf.fretline'));
  const score = entries['score.json'];
  if (!score) throw new RangeError('Missing perf project score');
  return parseScoreDocument(JSON.parse(strFromU8(score)));
}

export function firstSelection(doc: ScoreDocument): Selection {
  const first = indexDocument(doc).events.values().next().value;
  if (!first) throw new RangeError('Fixture has no events');
  const point = { eventId: first.event.id, startQ: first.startQ, endQ: first.endQ };
  return { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [1] }, anchor: point, focus: point };
}

export function recordDomainEvidence(name: string, value: unknown): void {
  const directory = process.env['FRETLINE_DOMAIN_EVIDENCE'];
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(value, null, 2));
}
