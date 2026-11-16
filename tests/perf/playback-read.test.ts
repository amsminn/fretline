import { afterEach, expect, it, vi } from 'vitest';
import { linearizeScore } from '../../src/adapters/alphatab/linearize';
import { compileOccurrences } from '../../src/domain/timeline';
import * as schema from '../../src/domain/schema/check';
import { perfDocument } from '../domain/perf-fixture';
import { DomainError } from '../../src/domain/diagnostics';

afterEach(() => { vi.restoreAllMocks(); });

it('projects playback without revalidating the immutable root already admitted by the editor', () => {
  const root = perfDocument();
  const occurrences = compileOccurrences(root, { followRepeats: true });
  const checks = vi.spyOn(schema, 'checkSchema');

  const playback = linearizeScore(root, occurrences);

  expect(playback.score.tracks).toHaveLength(16);
  expect(checks).toHaveBeenCalledTimes(0);
});

it('rejects an untrusted frozen playback root that shares a valid document id', () => {
  const root = perfDocument();
  const occurrences = compileOccurrences(root, { followRepeats: true });
  const invalid = Object.freeze({ ...root, layout: { ...root.layout, scale: 0 } });

  expect(() => linearizeScore(invalid, occurrences)).toThrow(DomainError);
});
