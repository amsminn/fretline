import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { unzipSync } from 'fflate';
import type { QaCase } from '../../lib/contracts';
import { fixtureDocument, fixtureId } from '../../../../tests/domain/fixtures';
import { readProjectFile, saveProjectFile, sha256 } from '../../../../src/main/projects';
import { receiptMatches } from '../../../../src/domain/project';
import type { PackageParts } from '../../../../src/domain/project';

export const run: QaCase = async context => {
  const source = await readFile('tests/fixtures/gp/gp5.gp5');
  const audio = await readFile('tests/fixtures/audio/impulse.wav');
  const assets = [{ id: fixtureId('asset', 'save-reopen'), sha256: sha256(audio), byteLength: audio.length, mediaType: 'audio/wav' }];
  const parts: PackageParts = {
    project: { schemaVersion: 1, projectId: fixtureId('project', 'save-reopen'),
      score: { ...fixtureDocument('pickup-6-8'), assets }, assets,
      source: { extension: 'gp5', name: 'gp5.gp5', sha256: sha256(source), byteLength: source.length },
      preservation: [{ feature: 'source', location: '/', status: 'unverified', detail: 'Original source retained byte-exact', dependencies: [] }] },
    blobs: [{ sha256: sha256(audio), bytes: audio }, { sha256: sha256(source), bytes: source }],
  };
  const directory = await mkdtemp(join(context.evidence, 'roundtrip-'));
  const path = join(directory, 'roundtrip.fretline');
  context.log('Save a native score with audio, provenance, and exact original GP bytes to the real filesystem');
  const first = await saveProjectFile(path, parts, 7);
  const saved = await readFile(path);
  const entries = unzipSync(saved);
  context.assert(isDeepStrictEqual(entries['source/original.gp5'], new Uint8Array(source)), 'Independent ZIP inspection preserves original GP bytes');
  context.assert(isDeepStrictEqual(entries[`assets/${sha256(audio)}`], new Uint8Array(audio)), 'Independent ZIP inspection preserves asset bytes');
  const reopened = await readProjectFile(path);
  context.assert(reopened.kind === 'editable', 'Saved archive reopens as an editable project');
  if (reopened.kind !== 'editable') return;
  context.assert(isDeepStrictEqual(reopened.parts.project, parts.project), 'Reopened score, provenance, assets and ledger equal captured input');
  context.assert(receiptMatches(first, reopened.receipt.contentHash), 'Save receipt describes the reopened captured content');
  const edited: PackageParts = { ...parts, project: { ...parts.project, score: { ...parts.project.score,
    metadata: { ...parts.project.score.metadata, title: 'Edited after first save' } } } };
  const second = await saveProjectFile(path, edited, 8);
  context.assert(!receiptMatches(first, second.contentHash), 'Late first acknowledgement leaves the newer content dirty');
  context.assert(isDeepStrictEqual(await readFile(`${path}.previous`), saved), 'Atomic replacement retains the complete previous archive');
  context.assert(sha256(await readFile('tests/fixtures/gp/gp5.gp5')) === sha256(source), 'Original GP source is unchanged');
  await writeFile(join(context.evidence, 'roundtrip.json'), JSON.stringify({
    path, first, second, input: parts.project, reopened: reopened.parts.project,
    archiveSha256: sha256(await readFile(path)), previousSha256: sha256(saved),
    sourceSha256: sha256(source), assetSha256: sha256(audio), entries: Object.keys(entries),
  }, null, 2));
};
