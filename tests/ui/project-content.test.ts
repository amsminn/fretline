import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectV1 } from '../../src/domain/project';
import { ProjectContent } from '../../src/renderer/state/project-content';
import * as contentHash from '../../src/domain/content-hash';
import { fixtureDocument, fixtureId } from '../domain/fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const changes: { readonly [K in keyof ProjectV1]-?: (project: ProjectV1) => ProjectV1 } = {
  score: project => ({ ...project, score: { ...project.score } }),
  assets: project => ({ ...project, assets: [{ id: fixtureId('asset', 'changed'), sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'audio/wav' }] }),
  source: project => ({ ...project, source: { extension: 'gp5', name: 'changed.gp5', sha256: 'b'.repeat(64), byteLength: 1 } }),
  preservation: project => ({ ...project, preservation: [{ feature: 'changed', location: 'score', status: 'mapped', detail: '', dependencies: [] }] }),
  projectId: project => ({ ...project, projectId: fixtureId('project', 'changed') }),
  schemaVersion: project => {
    const changed = { ...project };
    // A future runtime header must never be called clean merely because its other roots match.
    Reflect.set(changed, 'schemaVersion', 2);
    return changed;
  },
};

it.each(Object.entries(changes))('marks a change to only %s dirty immediately', (_field, change) => {
  const project: ProjectV1 = { schemaVersion: 1, projectId: fixtureId('project', 'saved'),
    score: fixtureDocument('loop-eight-bars'), assets: [], source: null, preservation: [] };
  const token = fixtureId('document-capability', 'content');
  const content = new ProjectContent(() => undefined, error => { throw error; });
  content.remember(token, project);
  try {
    expect(content.dirty(token, project)).toBe(false);

    expect(content.dirty(token, change(project))).toBe(true);
  } finally { content.forget(token); }
});

it('retries a failed baseline hash on the next confirmation while keeping the document dirty', async () => {
  vi.useFakeTimers();
  const project: ProjectV1 = { schemaVersion: 1, projectId: fixtureId('project', 'retry'),
    score: fixtureDocument('loop-eight-bars'), assets: [], source: null, preservation: [] };
  const token = fixtureId('document-capability', 'retry');
  const confirmed = Promise.withResolvers<void>();
  const failed = vi.fn();
  let dirty = false;
  const content = new ProjectContent((_token, _project, value) => {
    dirty = value;
    confirmed.resolve();
  }, failed);
  const failure = new DOMException('Temporary digest failure', 'OperationError');
  vi.spyOn(contentHash, 'hashDocument').mockRejectedValueOnce(failure);
  content.remember(token, project);
  try {
    dirty = content.dirty(token, structuredClone(project));
    await vi.advanceTimersByTimeAsync(1000);
    expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
    expect(dirty).toBe(true);

    dirty = content.dirty(token, structuredClone(project));
    await vi.advanceTimersByTimeAsync(1000);
    expect(failed).toHaveBeenCalledTimes(1);
    await confirmed.promise;
    expect(dirty).toBe(false);
  } finally { content.forget(token); }
});
