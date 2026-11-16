import { afterEach, expect, it, vi } from 'vitest';
import { openFixture, services } from './shell-harness';
import { documentEdits } from '../../src/renderer/state/document-edits';
import * as schema from '../../src/domain/schema/check';
import * as contentHash from '../../src/domain/content-hash';
import { freezeRoot } from '../../src/domain/commands/core';
import { validateScoped } from '../../src/domain/validate-scoped';
import { compileOccurrences } from '../../src/domain/timeline';
import { fixtureDocument } from '../domain/fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('marks rapid revisions dirty immediately without serializing intermediate whole projects', async () => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Saved');
  vi.useFakeTimers();
  const stringify = vi.spyOn(JSON, 'stringify');
  const fullProjects = () => stringify.mock.calls.filter(([value]) =>
    value && typeof value === 'object' && 'score' in value &&
    typeof value.score === 'object' && value.score !== null && 'tracks' in value.score);

  for (const title of ['one', 'two', 'three', 'four']) {
    const active = context.documents.getSnapshot().active;
    if (!active) throw new TypeError('Missing document');
    context.documents.updateProject({ ...active.project, score: { ...active.project.score,
      metadata: { ...active.project.score.metadata, title } } });
    expect(context.documents.getSnapshot().active?.dirty).toBe(true);
  }

  expect(fullProjects()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fullProjects().length).toBeLessThanOrEqual(1);
});

it('confirms an equal-content replacement as clean after the burst settles', async () => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Saved');
  const saved = context.documents.getSnapshot().active;
  if (!saved) throw new TypeError('Missing document');
  vi.useFakeTimers();
  const confirmed = Promise.withResolvers<void>();
  const release = context.documents.subscribe(() => {
    if (context.documents.getSnapshot().active?.dirty === false) confirmed.resolve();
  });
  try {
    context.documents.updateProject(structuredClone(saved.project));
    expect(context.documents.getSnapshot().active?.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await confirmed.promise;
    expect(context.documents.getSnapshot().active?.dirty).toBe(false);
  } finally { release(); }
});

it('publishes a validated family edit without validating the whole score twice', async () => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Saved');
  const checks = vi.spyOn(schema, 'checkSchema');

  await documentEdits(context).edit('metadata', doc => ({ kind: 'structure',
    edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'Changed' } } }));

  expect(context.documents.getSnapshot().active?.project.score.metadata.title).toBe('Changed');
  expect(checks).toHaveBeenCalledTimes(1);
});

it('fully validates a measures-changing fallback once across publication and traversal', async () => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Saved');
  const active = context.documents.getSnapshot().active;
  if (!active) throw new TypeError('Missing document');
  const before = Object.freeze(fixtureDocument('loop-eight-bars'));
  const after = freezeRoot({ ...structuredClone(before), measures: before.measures.map(measure =>
    ({ ...structuredClone(measure), key: { ...measure.key, fifths: 1 } })) });
  const checks = vi.spyOn(schema, 'checkSchema');

  expect(validateScoped(before, after)).toEqual([]);
  expect(context.documents.updateProject({ ...active.project, score: after })).toBe(true);
  expect(compileOccurrences(after, { followRepeats: true }).length).toBe(8);

  expect(checks.mock.calls.filter(([input, , mode]) => input === after && mode !== 'shared')).toHaveLength(1);
});

it('cancels pending content confirmation when its document closes', async () => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Saved');
  vi.useFakeTimers();
  const hashes = vi.spyOn(contentHash, 'hashDocument');
  const active = context.documents.getSnapshot().active;
  if (!active) throw new TypeError('Missing document');
  context.documents.updateProject({ ...active.project, score: { ...active.project.score,
    metadata: { ...active.project.score.metadata, title: 'Closing' } } });

  context.documents.close(active.documentToken);
  await vi.advanceTimersByTimeAsync(1000);

  expect(hashes).toHaveBeenCalledTimes(0);
  expect(context.documents.getSnapshot().sessions).toEqual([]);
});
