import { hashPattern, parsePackageParts, parseRevision, projectLimits, StorageError } from '../domain/project';
import type { AssetBytes, PackageParts, ProjectManifest, ProjectV1 } from '../domain/project';
import { projectHash, sha256 } from './projects';
import { t } from '../renderer/i18n';

/** V1 is the first released format. Unknown predecessors are never guessed or repaired. */
export function migrateProject(input: unknown): PackageParts {
  if (typeof input === 'object' && input !== null && 'project' in input &&
    typeof input.project === 'object' && input.project !== null && 'schemaVersion' in input.project &&
    typeof input.project.schemaVersion === 'number' && input.project.schemaVersion > 1) {
    throw new StorageError('FUTURE_SCHEMA', t('main.migrations.futureSchema'));
  }
  // Boundary parsing clones the entire graph and asset bytes before any migration can operate.
  const parsed = parsePackageParts(input);
  // Node Buffer.slice() is a view; explicitly copy into platform-neutral bytes.
  return { project: parsed.project, blobs: parsed.blobs.map(blob => ({ sha256: blob.sha256, bytes: new Uint8Array(blob.bytes) })) };
}

export class MissingRecoveryAssets extends Error {
  readonly code = 'MISSING_ASSET';
  constructor(readonly hashes: readonly string[]) {
    super(`MISSING_ASSET: ${hashes.join(', ')}`);
    this.name = 'MissingRecoveryAssets';
  }
}

/** IPC already owns these bytes. Validate their envelope without making another copy. */
export function recoveryBlobs(input: unknown): readonly AssetBytes[] {
  if (!Array.isArray(input) || input.length > projectLimits.entries) throw new StorageError('SCHEMA', 'Expected bounded recovery blobs');
  const blobs: AssetBytes[] = []; const hashes = new Set<string>(); let total = 0;
  for (const blob of input) {
    if (typeof blob !== 'object' || blob === null || !('sha256' in blob) || typeof blob.sha256 !== 'string' ||
      !new RegExp(hashPattern).test(blob.sha256) || !('bytes' in blob) || !(blob.bytes instanceof Uint8Array) ||
      hashes.has(blob.sha256)) throw new StorageError('SCHEMA', 'Invalid recovery asset payload');
    total += blob.bytes.byteLength;
    if (blob.bytes.byteLength > projectLimits.asset || total > projectLimits.expanded) throw new StorageError('LIMIT', 'Recovery asset bytes exceed limits');
    hashes.add(blob.sha256); blobs.push({ sha256: blob.sha256, bytes: blob.bytes });
  }
  return blobs;
}

/** Recovery files contain references; verified asset bytes never need to enter the manifest encoder. */
export function prepareRecovery(project: ProjectV1, revision: number): { readonly manifest: ProjectManifest; readonly scoreBytes: Uint8Array } {
  parseRevision(revision);
  const { score, ...metadata } = project;
  const scoreBytes = Buffer.from(JSON.stringify(score));
  if (scoreBytes.length > projectLimits.json) throw new StorageError('LIMIT', 'Score exceeds project size limit');
  const body = { ...metadata, revision, scoreSha256: sha256(scoreBytes), contentHash: projectHash(project) };
  const manifest = { ...body, manifestSha256: sha256(Buffer.from(JSON.stringify(body, (_key, value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'))) : value))) };
  const lengths = new Map(metadata.assets.map(asset => [asset.sha256, asset.byteLength]));
  if (scoreBytes.length + Buffer.byteLength(JSON.stringify(manifest)) + [...lengths.values()].reduce((sum, length) => sum + length, 0) +
    (metadata.source?.byteLength ?? 0) > projectLimits.expanded) throw new StorageError('LIMIT', 'Expanded project exceeds 1 GiB');
  return { manifest, scoreBytes };
}
