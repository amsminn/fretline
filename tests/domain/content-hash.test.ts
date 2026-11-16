import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { contentToken, applyCommand, freezeRoot } from '../../src/domain/commands/core';
import { hashDocument, createHistory, executeCommand, isDirty } from '../../src/domain/history';
import { indexDocument } from '../../src/domain/event-time';
import { fixtureDocument } from './fixtures';
import { firstSelection, perfDocument, recordDomainEvidence } from './perf-fixture';
import { ContentHashCache } from '../../src/domain/content-hash';

describe('root identity and Merkle content equality', () => {
  it('does not issue a native digest for every tiny immutable leaf', async () => {
    const cache = new ContentHashCache();
    const input = freezeRoot({ items: Array.from({ length: 256 }, (_, value) => ({ value })), version: 1 });
    const digests = vi.spyOn(globalThis.crypto.subtle, 'digest');
    try {
      await cache.hash(input);
      expect(digests.mock.calls.length).toBeLessThanOrEqual(4);
    } finally { digests.mockRestore(); }
  });
  it('matches an independent SHA-256 implementation for a framed large leaf', async () => {
    const value = 'a'.repeat(512);
    const message = `object:7:"value"521:scalar:"${value}"`;
    const expected = createHash('sha256').update(message).digest('hex');

    expect(await new ContentHashCache().hash(freezeRoot({ value }))).toBe(expected);
  });
  it('bounds cold setup before yielding instead of starting one promise per tree node', async () => {
    const cache = new ContentHashCache();
    const doc = freezeRoot(perfDocument());
    const pending = cache.hash(doc);
    const started = cache.freshlyHashedNodes;
    await pending;

    expect(started).toBeLessThanOrEqual(32);
    recordDomainEvidence('cold-hash-setup', { beforeFirstYield: started, total: cache.freshlyHashedNodes, maximum: 32 });
  });
  it('stores a settled frozen-tree hash as a string and does zero fresh work on its second hash', async () => {
    const cache = new ContentHashCache();
    const doc = freezeRoot(fixtureDocument('unison-strings'));
    const expected = await cache.hash(doc);
    const misses = cache.freshlyHashedNodes;
    const second = cache.hash(doc);
    expect(typeof second).toBe('string');
    expect(second).toBe(expected);
    expect(cache.freshlyHashedNodes - misses).toBe(0);
  });
  it('shares one in-flight hash for concurrent requests of the same frozen tree', async () => {
    const cache = new ContentHashCache();
    const doc = freezeRoot(fixtureDocument('unison-strings'));
    const first = cache.hash(doc);
    const misses = cache.freshlyHashedNodes;
    const second = cache.hash(doc);
    expect(first).toBeInstanceOf(Promise);
    expect(second).toBe(first);
    expect(cache.freshlyHashedNodes - misses).toBe(0);
    await first;
  });
  it('makes a command root immutable when its token is issued', () => {
    const doc = fixtureDocument('unison-strings');
    const metadata = { ...doc.metadata };
    contentToken({ ...doc, metadata });
    expect(() => { metadata.title = 'Changed after command construction'; }).toThrow(TypeError);
  });
  it('rejects commands from a different root even when content is equal', () => {
    const doc = fixtureDocument('unison-strings');
    const clone = structuredClone(doc);
    const result = applyCommand(clone, { expectedToken: contentToken(doc), edit: { kind: 'batch', edits: [] } }, firstSelection(clone));
    expect(result).toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'REFERENCE', path: 'expectedToken' }] });
  });

  it('hashes equal frozen content equally despite allocation and property order', async () => {
    const doc = freezeRoot(fixtureDocument('unison-strings'));
    const clone = structuredClone(doc);
    const reordered = freezeRoot({ ...clone, metadata: {
      notices: clone.metadata.notices, instructions: clone.metadata.instructions, copyright: clone.metadata.copyright,
      music: clone.metadata.music, words: clone.metadata.words, album: clone.metadata.album,
      artist: clone.metadata.artist, subtitle: clone.metadata.subtitle, title: clone.metadata.title,
    } });
    expect(await hashDocument(reordered)).toEqual(await hashDocument(doc));
  });

  it('does not reuse cached hashes for mutable caller input', async () => {
    const doc = fixtureDocument('unison-strings');
    const metadata = { ...doc.metadata };
    const input = { ...doc, metadata };
    const original = await hashDocument(input);
    metadata.title = 'Changed title';
    expect(await hashDocument(input)).not.toEqual(original);
  });

  it('keeps no-op history and clears dirty after a content-restoring edit', async () => {
    const doc = fixtureDocument('unison-strings');
    const note = indexDocument(doc).notes.values().next().value?.note;
    if (!note || note.kind !== 'fretted') throw new RangeError('Missing fretted fixture');
    const history = await createHistory(doc, firstSelection(doc));
    const noop = await executeCommand(history, { expectedToken: contentToken(doc), edit: { kind: 'setFret', noteId: note.id, fret: note.fret } });
    expect(noop.history).toBe(history);
    const changed = await executeCommand(history, { expectedToken: contentToken(doc), edit: { kind: 'setFret', noteId: note.id, fret: note.fret + 1 } });
    expect(isDirty(changed.history)).toBe(true);
    const restored = await executeCommand(changed.history, { expectedToken: contentToken(changed.history.present.doc),
      edit: { kind: 'setFret', noteId: note.id, fret: note.fret } });
    expect(isDirty(restored.history)).toBe(false);
    expect(restored.history.present.doc).not.toBe(doc);
  });
});
