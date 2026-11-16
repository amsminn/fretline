import { expect, it } from 'vitest';
import { contentToken } from '../../src/domain/commands/core';
import type { Edit } from '../../src/domain/commands/core';
import { createHistory, executeCommand } from '../../src/domain/history';
import { indexDocument } from '../../src/domain/event-time';
import { newId } from '../../src/domain/ids';
import { firstSelection, perfDocument, recordDomainEvidence } from '../domain/perf-fixture';
import { contentHashWork } from '../../src/domain/content-hash';
import { scopedValidationWork } from '../../src/domain/validate-scoped';

it('validates and freshly hashes only changed subtrees across 50 warm edits', async () => {
  const doc = perfDocument();
  expect(doc.tracks).toHaveLength(16);
  expect(doc.measures).toHaveLength(256);
  const index = indexDocument(doc);
  expect(index.notes.size).toBe(10000);
  const note = [...index.notes.values()].find(entry => entry.note.kind === 'fretted');
  const measure = doc.measures[0];
  if (!note || !measure || note.location.event.duration === 'fullMeasure') throw new RangeError('Missing perf edit targets');
  let history = await createHistory(doc, firstSelection(doc));
  const samples: Record<'setFret' | 'duration' | 'insertMeasure', number[]> = { setFret: [], duration: [], insertMeasure: [] };
  const work: Record<string, { readonly validated: number; readonly hashed: number }[]> = {};
  for (const kind of ['setFret', 'duration', 'insertMeasure'] as const) {
    for (let i = 0; i < 55; i++) {
      let edit: Edit;
      switch (kind) {
        case 'setFret': edit = { kind, noteId: note.note.id, fret: i % 12 }; break;
        case 'duration': edit = { kind, eventId: note.location.event.id,
          duration: { ...note.location.event.duration, base: i % 2 === 0 ? 8 : 4 } }; break;
        case 'insertMeasure': edit = { kind, beforeMeasureId: measure.id, measure: { ...measure, id: newId('measure') } }; break;
      }
      const start = performance.now();
      const validation = scopedValidationWork();
      const hashing = contentHashWork();
      const result = await executeCommand(history, { expectedToken: contentToken(history.present.doc), edit });
      const elapsed = performance.now() - start;
      expect(result.kind).toBe('applied');
      history = result.history;
      if (i >= 5) {
        samples[kind].push(elapsed);
        const validated = scopedValidationWork().validatedNodes - validation.validatedNodes;
        const hashed = contentHashWork().freshlyHashedNodes - hashing.freshlyHashedNodes;
        (work[kind] ??= []).push({ validated, hashed });
        expect(scopedValidationWork().fullValidations - validation.fullValidations).toBe(0);
        // A local edit changes one voice/bar/event path. Insertion changes every lane.
        const lanes = doc.tracks.reduce((count, track) => count + track.staves.reduce((sum, staff) => sum + staff.voices.length, 0), 0);
        expect(validated).toBeLessThanOrEqual(kind === 'insertMeasure' ? lanes * 3 + 4 : 24);
        expect(hashed).toBeLessThanOrEqual(kind === 'insertMeasure' ? lanes * 8 + 32 : 32);
      }
    }
  }
  const p95 = Object.fromEntries(Object.entries(samples).map(([kind, values]) => [kind, [...values].sort((a, b) => a - b)[47]]));
  console.log('DOMAIN_EDIT_BENCHMARK', JSON.stringify({ samples, p95, work, runtime: process.version }));
  recordDomainEvidence('benchmark', { samples, p95, work, runtime: process.version, warmups: 5, measured: 50 });
}, 120000);
