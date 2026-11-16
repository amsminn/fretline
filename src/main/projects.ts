import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { atomicReplace, isMissing, readBoundedFile } from './atomic-save';
import { parseManifest, parsePackageParts, parseProject, parseRevision, projectLimits, StorageError } from '../domain/project';
import type { PackageParts, ProjectManifest, ProjectRead, ProjectV1, SaveReceipt } from '../domain/project';
import { assertUnchanged, fileHash, observedFile, observeFile } from './external-change';
import type { SaveDestination } from './external-change';
import { migrateProject } from './migrations';

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function contentDigest(input: object): string {
  return sha256(Buffer.from(JSON.stringify(input, (_key, value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'))) : value)));
}
export const projectHash = (project: ProjectV1): string => contentDigest(project);
export function prepareProject(parts: PackageParts, revision: number): { readonly manifest: ProjectManifest; readonly scoreBytes: Uint8Array } {
  parseRevision(revision);
  const { score, ...metadata } = parts.project;
  const scoreBytes = Buffer.from(JSON.stringify(score));
  if (scoreBytes.length > projectLimits.json) throw new StorageError('LIMIT', 'Score exceeds project size limit');
  const references = [...metadata.assets, ...(metadata.source ? [metadata.source] : [])];
  const required = new Set(references.map(asset => asset.sha256));
  if (parts.blobs.length !== required.size) throw new StorageError('CHECKSUM', 'Missing or unreferenced asset bytes');
  for (const blob of parts.blobs) {
    if (!required.has(blob.sha256) || sha256(blob.bytes) !== blob.sha256 ||
      references.some(asset => asset.sha256 === blob.sha256 && asset.byteLength !== blob.bytes.byteLength)) {
      throw new StorageError('CHECKSUM', 'Asset content does not match its reference');
    }
  }
  const body = { ...metadata, revision, scoreSha256: sha256(scoreBytes), contentHash: projectHash(parts.project) };
  const manifest = { ...body, manifestSha256: contentDigest(body) };
  const manifestLength = Buffer.byteLength(JSON.stringify(manifest));
  const assetLengths = new Map(metadata.assets.map(asset => [asset.sha256, asset.byteLength]));
  const expanded = scoreBytes.length + manifestLength + [...assetLengths.values()].reduce((sum, length) => sum + length, 0) +
    (metadata.source?.byteLength ?? 0);
  if (expanded > projectLimits.expanded) throw new StorageError('LIMIT', 'Expanded project exceeds 1 GiB');
  return { manifest, scoreBytes };
}
export function parseStoredProject(manifest: ProjectManifest, scoreBytes: Uint8Array): ProjectV1 {
  const { manifestSha256, ...body } = manifest;
  if (contentDigest(body) !== manifestSha256) throw new StorageError('CHECKSUM', 'Manifest checksum failed');
  if (sha256(scoreBytes) !== manifest.scoreSha256) throw new StorageError('CHECKSUM', 'Score checksum failed');
  const { revision, scoreSha256, contentHash, ...metadata } = body;
  void revision; void scoreSha256;
  const project = parseProject({ ...metadata, score: parseJson(scoreBytes) });
  if (projectHash(project) !== contentHash) throw new StorageError('CHECKSUM', 'Project metadata checksum failed');
  return project;
}
export function encodeProject(input: PackageParts, revision: number): Uint8Array {
  const parts = parsePackageParts(input);
  const { manifest, scoreBytes } = prepareProject(parts, revision);
  const entries: Record<string, Uint8Array> = {
    'manifest.json': Buffer.from(JSON.stringify(manifest)), 'score.json': scoreBytes,
  };
  for (const asset of parts.project.assets) {
    const blob = parts.blobs.find(blob => blob.sha256 === asset.sha256);
    if (blob) entries[`assets/${asset.sha256}`] = blob.bytes;
  }
  if (parts.project.source) {
    const source = parts.project.source;
    const blob = parts.blobs.find(blob => blob.sha256 === source.sha256);
    if (blob) entries[`source/original.${source.extension}`] = blob.bytes;
  }
  const size = Object.values(entries).reduce((sum, bytes) => sum + bytes.byteLength, 0);
  if (size > projectLimits.expanded || Object.keys(entries).length > projectLimits.entries) throw new StorageError('LIMIT', 'Expanded archive exceeds limits');
  const bytes = zipSync(entries, { level: 1 });
  if (bytes.byteLength > projectLimits.compressed) throw new StorageError('LIMIT', 'Compressed archive exceeds 256 MiB');
  return bytes;
}
function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > projectLimits.json) throw new StorageError('LIMIT', 'JSON exceeds project size limit');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new StorageError('SCHEMA', 'Invalid UTF-8 JSON');
    throw error;
  }
}
// Inspect the complete directory before inflating anything. fflate's output map alone
// cannot expose duplicate names or symlink attributes, and trusts advertised sizes.
function archiveEntries(input: Uint8Array): ReadonlyMap<string, Uint8Array> {
  if (input.byteLength > projectLimits.compressed) throw new StorageError('LIMIT', 'Compressed archive exceeds 256 MiB');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const reject = (): never => { throw new StorageError('ARCHIVE', 'Invalid, unsafe, or unsupported ZIP'); };
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) &&
    (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end--;
  if (end < 0 || end < bytes.length - 65557) return reject();
  const count = bytes.readUInt16LE(end + 10);
  const directoryEnd = bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12);
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count || directoryEnd !== end) return reject();
  if (count > projectLimits.entries) throw new StorageError('LIMIT', 'Too many ZIP entries');
  const records: { name: string; size: number; compressed: number; offset: number; method: number; crc: number }[] = [];
  const names = new Set<string>();
  let cursor = bytes.readUInt32LE(end + 16);
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) return reject();
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (next > end) return reject();
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    const method = bytes.readUInt16LE(cursor + 10);
    const size = bytes.readUInt32LE(cursor + 24);
    const compressed = bytes.readUInt32LE(cursor + 20);
    if (!/^(manifest\.json|score\.json|assets\/[a-f0-9]{64}|source\/original\.(gp[345]?|gpx|musicxml|mxl|midi?))$/.test(name) ||
      names.has(name.normalize('NFC').toLowerCase()) || (mode & 0o170000) === 0o120000 ||
      (bytes.readUInt16LE(cursor + 8) & ~0x808) !== 0 || (method !== 0 && method !== 8) ||
      bytes.readUInt16LE(cursor + 34) !== 0) return reject();
    names.add(name.normalize('NFC').toLowerCase());
    expanded += size;
    const entryLimit = name.endsWith('.json') ? projectLimits.json : name.endsWith('.musicxml') ? projectLimits.xml : projectLimits.asset;
    if (size > entryLimit || expanded > projectLimits.expanded) throw new StorageError('LIMIT', 'Expanded archive exceeds limits');
    records.push({ name, size, compressed, method, offset: bytes.readUInt32LE(cursor + 42), crc: bytes.readUInt32LE(cursor + 16) });
    cursor = next;
  }
  if (cursor !== end) return reject();
  const entries = new Map<string, Uint8Array>();
  for (const record of records) {
    const at = record.offset;
    if (at + 30 > bytes.readUInt32LE(end + 16) || bytes.readUInt32LE(at) !== 0x04034b50 ||
      bytes.readUInt16LE(at + 8) !== record.method) return reject();
    const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28);
    if (start + record.compressed > bytes.readUInt32LE(end + 16) ||
      bytes.toString('utf8', at + 30, at + 30 + bytes.readUInt16LE(at + 26)) !== record.name) return reject();
    const compressed = bytes.subarray(start, start + record.compressed);
    let output: Uint8Array;
    try { output = record.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, record.size) }); }
    catch (error) { if (error instanceof Error) return reject(); throw error; }
    if (output.length !== record.size || crc32(output) !== record.crc) return reject();
    entries.set(record.name, output);
  }
  return entries;
}
export function decodeProject(bytes: Uint8Array): ProjectRead {
  const entries = archiveEntries(bytes);
  const manifestBytes = entries.get('manifest.json');
  const scoreBytes = entries.get('score.json');
  if (!manifestBytes || !scoreBytes) throw new StorageError('ARCHIVE', 'Missing manifest or score');
  const raw = parseJson(manifestBytes);
  if (typeof raw === 'object' && raw !== null && 'schemaVersion' in raw &&
    typeof raw.schemaVersion === 'number' && Number.isSafeInteger(raw.schemaVersion) && raw.schemaVersion > 1) {
    return { kind: 'inspect-only', schemaVersion: raw.schemaVersion };
  }
  const manifest = parseManifest(raw);
  const project = parseStoredProject(manifest, scoreBytes);
  const blobs = new Map<string, Uint8Array>();
  const required = new Set(['manifest.json', 'score.json']);
  for (const reference of [...project.assets.map(asset => ({ ...asset, path: `assets/${asset.sha256}` })),
    ...(project.source ? [{ ...project.source, path: `source/original.${project.source.extension}` }] : [])]) {
    required.add(reference.path);
    const content = entries.get(reference.path);
    if (!content || content.length !== reference.byteLength || sha256(content) !== reference.sha256) throw new StorageError('CHECKSUM', 'Asset checksum failed');
    blobs.set(reference.sha256, new Uint8Array(content));
  }
  if (entries.size !== required.size) throw new StorageError('ARCHIVE', 'Unreferenced archive entry');
  return { kind: 'editable', parts: { project, blobs: [...blobs].map(([sha256, bytes]) => ({ sha256, bytes })) },
    receipt: { revision: manifest.revision, contentHash: manifest.contentHash, projectId: manifest.projectId } };
}
export async function readProjectFile(path: string): Promise<ProjectRead> {
  const bytes = await readBoundedFile(path, projectLimits.compressed);
  const result = decodeProject(bytes);
  observeFile(path, bytes);
  return result.kind === 'editable' ? { ...result, parts: migrateProject(result.parts) } : result;
}
export async function saveProjectFile(destination: string | SaveDestination, parts: PackageParts, revision: number): Promise<SaveReceipt> {
  const path = typeof destination === 'string' ? destination : destination.path;
  if (extname(path).toLowerCase() !== '.fretline') throw new StorageError('DESTINATION', 'Save requires a .fretline destination');
  const bytes = encodeProject(parts, revision);
  const decoded = decodeProject(bytes);
  if (decoded.kind !== 'editable') throw new StorageError('FUTURE_SCHEMA', 'Cannot write a future project');
  let expected: string | null;
  await atomicReplace(path, bytes, {
    validate: async temporary => {
      decodeProject(temporary);
      expected = typeof destination === 'string' ? observedFile(path) ?? await fileHash(path) : destination.expectedHash;
      await assertUnchanged(path, expected);
      try {
        const previous = decodeProject(await readBoundedFile(path, projectLimits.compressed));
        if (previous.kind === 'inspect-only') throw new StorageError('FUTURE_SCHEMA', 'Future project cannot be overwritten');
      } catch (error) { if (!isMissing(error)) throw error; }
    },
    beforeReplace: () => assertUnchanged(path, expected),
    committed: () => { observeFile(path, bytes); },
  });
  return decoded.receipt;
}
