import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { encodeProject, decodeProject, readProjectFile, saveProjectFile, projectHash, sha256 } from '../../src/main/projects';
import type { PackageParts } from '../../src/domain/project';
import { parseManifest, receiptMatches } from '../../src/domain/project';
import { registerIpcHandlers } from '../../src/main/ipc';

const desktop = vi.hoisted(() => ({
  root: '', handlers: new Map<string, (...args: readonly unknown[]) => unknown>(),
  destroyed: new Map<number, () => void>(), open: vi.fn(), save: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => desktop.root, on: vi.fn() },
  dialog: { showOpenDialog: desktop.open, showSaveDialog: desktop.save },
  ipcMain: {
    handle: (name: string, handler: (...args: readonly unknown[]) => unknown) => desktop.handlers.set(name, handler),
    on: (name: string, handler: (...args: readonly unknown[]) => unknown) => desktop.handlers.set(name, handler),
  },
}));
let root: string;
const parts: PackageParts = { project: { schemaVersion: 1, projectId: fixtureId('project', 'storage'),
  score: fixtureDocument('pickup-6-8'), assets: [], source: null, preservation: [] }, blobs: [] };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'projects-'));
  desktop.root = root;
  registerIpcHandlers();
});
afterEach(async () => {
  for (const destroyed of desktop.destroyed.values()) destroyed();
  desktop.destroyed.clear();
  await rm(root, { recursive: true, force: true });
});
async function invoke(channel: string, args: readonly unknown[], owner = 1): Promise<unknown> {
  const handler = desktop.handlers.get(`desktop:${channel}`);
  if (!handler) throw new TypeError('Missing IPC handler');
  const frame = { url: 'app://fretline/index.html' };
  return handler({ senderFrame: frame, sender: { id: owner, mainFrame: frame,
    once: (_event: string, callback: () => void) => desktop.destroyed.set(owner, callback) } }, ...args);
}
it('round trips an owned score through a checksummed ZIP', () => {
  const opened = decodeProject(encodeProject(parts, 4));
  expect(opened.kind).toBe('editable');
  if (opened.kind !== 'editable') throw new TypeError('Expected editable project');
  expect(opened.parts).toEqual(parts);
  expect(opened.receipt.revision).toBe(4);
});
it('acknowledges the captured save while a newer edit stays dirty', async () => {
  const pending = saveProjectFile(join(root, 'score.fretline'), parts, 4);
  const next = { ...parts.project, score: { ...parts.project.score, metadata: { ...parts.project.score.metadata, title: 'new edit' } } };
  const receipt = await pending;
  expect(receiptMatches(receipt, projectHash(next))).toBe(false);
  expect(receiptMatches(receipt, projectHash(parts.project))).toBe(true);
});
it.each(['traversal', 'duplicate', 'truncated'])('rejects hostile %s ZIP before creating a document', async name => {
  const bytes = await readFile(`tests/fixtures/archives/${name}.zip`);
  expect(() => decodeProject(bytes)).toThrow(/ARCHIVE/);
});
it('rejects duplicate manifest entries in an otherwise valid project archive', () => {
  const entries = unzipSync(encodeProject(parts, 0));
  const manifest = entries['manifest.json'];
  if (!manifest) throw new TypeError('Expected manifest');
  const zip = Buffer.from(zipSync({ ...entries, 'xanifest.json': manifest }));
  for (let offset = zip.indexOf('xanifest.json'); offset !== -1; offset = zip.indexOf('xanifest.json', offset + 1)) {
    zip.write('manifest.json', offset);
  }
  expect(() => decodeProject(zip)).toThrow(/ARCHIVE/);
});
it('rejects changed score bytes with the original checksum', () => {
  const entries = unzipSync(encodeProject(parts, 0));
  entries['score.json'] = strToU8(JSON.stringify({ ...parts.project.score, metadata: { ...parts.project.score.metadata, title: 'tampered' } }));
  expect(() => decodeProject(zipSync(entries))).toThrow(/CHECKSUM/);
});
it('rejects changed manifest revision with the original checksum', () => {
  const entries = unzipSync(encodeProject(parts, 0));
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(entries['manifest.json'])));
  entries['manifest.json'] = strToU8(JSON.stringify({ ...manifest, revision: 99 }));
  expect(() => decodeProject(zipSync(entries))).toThrow(/CHECKSUM/);
});
it('rejects corrupted asset bytes even when ZIP CRC is recomputed', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const asset = { id: fixtureId('asset', 'checksum'), sha256: sha256(bytes), byteLength: bytes.length, mediaType: 'audio/wav' };
  const withAsset: PackageParts = { project: { ...parts.project, assets: [asset], score: { ...parts.project.score, assets: [asset] } },
    blobs: [{ sha256: asset.sha256, bytes }] };
  const entries = unzipSync(encodeProject(withAsset, 0));
  entries[`assets/${asset.sha256}`] = new Uint8Array([4, 5, 6]);
  expect(() => decodeProject(zipSync(entries))).toThrow(/CHECKSUM/);
});
it('rejects an oversized compressed project without reading its payload', async () => {
  const path = join(root, 'oversized.fretline');
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'wx');
  try { await handle.truncate(256 * 1024 ** 2 + 1); } finally { await handle.close(); }
  await expect(readProjectFile(path)).rejects.toThrow(/LIMIT/);
});
it('returns future schema as inspect only and refuses overwriting it', async () => {
  const entries = unzipSync(encodeProject(parts, 0));
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(entries['manifest.json'])));
  entries['manifest.json'] = strToU8(JSON.stringify({ ...manifest, schemaVersion: 2 }));
  const bytes = zipSync(entries);
  expect(decodeProject(bytes)).toEqual({ kind: 'inspect-only', schemaVersion: 2 });
  const path = join(root, 'future.fretline');
  await writeFile(path, bytes);
  await expect(saveProjectFile(path, parts, 1)).rejects.toThrow(/FUTURE_SCHEMA/);
  expect(await readFile(path)).toEqual(Buffer.from(bytes));
});
it('refuses saving a native package over a GP source path', async () => {
  await expect(saveProjectFile(join(root, 'source.gp'), parts, 1)).rejects.toThrow(/DESTINATION/);
});
it('rejects a ZIP symlink entry before parsing its target', () => {
  const zip = zipSync({ 'manifest.json': [strToU8('/etc/passwd'), { os: 3, attrs: 0o120777 << 16 }] });
  expect(() => decodeProject(zip)).toThrow(/ARCHIVE/);
});
it.each(['entry-count', 'expanded-size', 'forged-small-size'])('enforces the %s ZIP limit before unbounded inflation', condition => {
  const zip = Buffer.from(encodeProject(parts, 0));
  const end = zip.length - 22;
  const directory = zip.readUInt32LE(end + 16);
  switch (condition) {
    case 'entry-count':
      zip.writeUInt16LE(4097, end + 8); zip.writeUInt16LE(4097, end + 10); break;
    case 'expanded-size': zip.writeUInt32LE(1024 ** 3 + 1, directory + 24); break;
    case 'forged-small-size': zip.writeUInt32LE(1, directory + 24); break;
  }
  expect(() => decodeProject(zip)).toThrow(condition === 'forged-small-size' ? /ARCHIVE/ : /LIMIT/);
});
it('applies the XML limit before inflating a preserved source', () => {
  const entries = unzipSync(encodeProject(parts, 0));
  const zip = Buffer.from(zipSync({ ...entries, 'source/original.musicxml': strToU8('<score-partwise/>') }));
  const directory = zip.readUInt32LE(zip.length - 6);
  const name = zip.indexOf('source/original.musicxml', directory);
  zip.writeUInt32LE(64 * 1024 ** 2 + 1, name - 46 + 24);
  expect(() => decodeProject(zip)).toThrow(/LIMIT/);
});
it('rejects structurally dangling IDs and non-finite numbers at the save boundary', () => {
  const invalid = { ...parts, project: { ...parts.project, score: { ...parts.project.score,
    layout: { ...parts.project.score.layout, systemBreaks: [fixtureId('measure', 'missing')] } } } };
  expect(() => encodeProject(invalid, 1)).toThrow();
  expect(() => encodeProject({ ...parts, project: { ...parts.project, score: { ...parts.project.score,
    layout: { ...parts.project.score.layout, scale: Infinity } } } }, 1)).toThrow();
});
it('binds native Save As authorization to its sender and project identity', async () => {
  const path = join(root, 'authorized.fretline');
  desktop.save.mockResolvedValue({ canceled: false, filePath: path });
  const result = await invoke('save-project-as', [null, 3, parts]);
  if (typeof result !== 'object' || result === null || !('documentToken' in result)) throw new TypeError('Expected saved result');
  await expect(invoke('save-project', [result.documentToken, 4, parts], 2)).rejects.toThrow(/CAPABILITY/);
  await expect(invoke('save-project', [path, 4, parts])).rejects.toThrow();
  await expect(invoke('save-project', [result.documentToken, 4, { ...parts, project: {
    ...parts.project, projectId: fixtureId('project', 'other') } }])).rejects.toThrow(/CAPABILITY/);
  await expect(invoke('save-project', [result.documentToken, 4, parts])).resolves.toMatchObject({ kind: 'saved', receipt: { revision: 4 } });
  const saved = decodeProject(await readFile(path));
  expect(saved.kind === 'editable' && saved.receipt.revision).toBe(4);
});
it('returns typed dialog cancellation and rejects malformed revisions before showing save dialogs', async () => {
  desktop.save.mockResolvedValue({ canceled: true });
  await expect(invoke('save-project-as', [null, 1, parts])).resolves.toEqual({ kind: 'cancelled' });
  await expect(invoke('save-project-as', [null, Infinity, parts])).rejects.toThrow(/SCHEMA/);
});
it('requires a trusted main frame for every project capability', async () => {
  const handler = desktop.handlers.get('desktop:create-project');
  if (!handler) throw new TypeError('Missing handler');
  expect(() => handler({ senderFrame: { url: 'https://attacker/' }, sender: { mainFrame: {} } }, parts.project)).toThrow(/REJECTED_SENDER/);
});
it('bounds asset capability reads and revokes them with their document', async () => {
  const bytes = new Uint8Array([10, 20, 30]);
  const hash = sha256(bytes);
  const asset = { id: fixtureId('asset', 'ipc'), sha256: hash, byteLength: bytes.length, mediaType: 'audio/wav' };
  const packageParts: PackageParts = { project: { ...parts.project, assets: [asset], score: { ...parts.project.score, assets: [asset] } },
    blobs: [{ sha256: hash, bytes }] };
  const path = join(root, 'assets.fretline');
  await saveProjectFile(path, packageParts, 1);
  desktop.open.mockResolvedValue({ canceled: false, filePaths: [path] });
  const opened = await invoke('open-document', []);
  if (typeof opened !== 'object' || opened === null || !('assets' in opened) || !Array.isArray(opened.assets) ||
    !('documentToken' in opened)) throw new TypeError('Expected opened project');
  const assetToken: unknown = opened.assets[0]?.assetToken;
  await expect(invoke('read-asset', [assetToken, 1, 2])).resolves.toEqual(new Uint8Array([20, 30]));
  await expect(invoke('read-asset', [assetToken, 0, 4])).rejects.toThrow(/LIMIT/);
  await expect(invoke('read-asset', [assetToken, 0, 1], 2)).rejects.toThrow(/CAPABILITY/);
  await invoke('release-document', [opened.documentToken]);
  await expect(invoke('read-asset', [assetToken, 0, 1])).rejects.toThrow(/CAPABILITY/);
});
it('writes and restores recovery through sender capabilities', async () => {
  vi.useFakeTimers();
  try {
    const token = await invoke('create-project', [parts.project]);
    const writing = invoke('write-recovery', [token, 9, parts]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(writing).resolves.toMatchObject({ revision: 9 });
    const offers = await invoke('list-recovery', []);
    if (!Array.isArray(offers)) throw new TypeError('Expected recovery offers');
    const offer: unknown = offers[0];
    if (typeof offer !== 'object' || offer === null || !('recoveryToken' in offer)) throw new TypeError('Missing recovery capability');
    await expect(invoke('restore-recovery', [offer.recoveryToken], 2)).rejects.toThrow(/CAPABILITY/);
    await expect(invoke('restore-recovery', [offer.recoveryToken])).resolves.toMatchObject({ kind: 'opened', project: parts.project });
    await invoke('discard-recovery', [offer.recoveryToken]);
    await expect(invoke('list-recovery', [])).resolves.toEqual([]);
  } finally { vi.useRealTimers(); }
});
