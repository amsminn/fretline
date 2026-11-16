import type { Asset, ScoreDocument } from './document';
import type { Id } from './ids';
import { uuidPattern } from './ids';
import { checkSchema } from './schema/check';
import type { Schema } from './schema/check';
import { parseScoreDocument } from './validate';

export const projectLimits = {
  compressed: 256 * 1024 ** 2, expanded: 1024 ** 3, entries: 4096,
  asset: 512 * 1024 ** 2, json: 1024 ** 3, xml: 64 * 1024 ** 2,
} as const;
export const hashPattern = '^[a-f0-9]{64}$';
export type SourceProvenance = {
  readonly extension: 'gp3' | 'gp4' | 'gp5' | 'gpx' | 'gp' | 'musicxml' | 'mxl' | 'mid' | 'midi';
  readonly name: string;
  readonly sha256: string;
  readonly byteLength: number;
};
export type PreservationEntry = {
  readonly feature: string;
  readonly location: string;
  readonly status: 'mapped' | 'preserved' | 'unverified';
  readonly detail: string;
  readonly dependencies: readonly string[];
};
export type ProjectV1 = {
  readonly schemaVersion: 1;
  readonly projectId: Id<'project'>;
  readonly score: ScoreDocument;
  readonly assets: readonly Asset[];
  readonly source: SourceProvenance | null;
  readonly preservation: readonly PreservationEntry[];
};
export type AssetBytes = { readonly sha256: string; readonly bytes: Uint8Array };
export type PackageParts = { readonly project: ProjectV1; readonly blobs: readonly AssetBytes[] };
export type ProjectManifest = Omit<ProjectV1, 'score'> & {
  readonly revision: number;
  readonly scoreSha256: string;
  readonly contentHash: string;
  readonly manifestSha256: string;
};
export type SaveReceipt = {
  readonly revision: number;
  readonly contentHash: string;
  readonly projectId: Id<'project'>;
};
export type RecoveryReceipt = SaveReceipt & { readonly generation: string; readonly writtenAssetBytes: number };
export type ProjectRead =
  | { readonly kind: 'editable'; readonly parts: PackageParts; readonly receipt: SaveReceipt }
  | { readonly kind: 'inspect-only'; readonly schemaVersion: number };
export type DocumentToken = Id<'document-capability'>;
export type AssetToken = Id<'asset-capability'>;
export type ProjectOpen =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'inspect-only'; readonly schemaVersion: number }
  | { readonly kind: 'opened'; readonly documentToken: DocumentToken; readonly project: ProjectV1;
      readonly receipt: SaveReceipt; readonly assets: readonly { readonly sha256: string; readonly assetToken: AssetToken }[] };
export type ProjectSaved =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'saved'; readonly documentToken: DocumentToken; readonly receipt: SaveReceipt };
export type RecoveryItem = { readonly projectId: Id<'project'>; readonly generation: string; readonly receipt: SaveReceipt };
export type RecoveryOffer = RecoveryItem & {
  readonly recoveryToken: Id<'recovery-capability'>;
  readonly title: string;
  readonly savedAt: string;
};
export class StorageError extends Error {
  constructor(readonly code: 'SCHEMA' | 'LIMIT' | 'ARCHIVE' | 'CHECKSUM' | 'FUTURE_SCHEMA' | 'CAPABILITY' | 'DESTINATION', message: string) {
    super(`${code}: ${message}`);
    this.name = 'StorageError';
  }
}

const text: Schema = { type: 'string', maxLength: 65536 };
const hash: Schema = { type: 'string', pattern: hashPattern };
const uuid: Schema = { type: 'string', pattern: uuidPattern };
const length: Schema = { type: 'integer', minimum: 0, maximum: projectLimits.asset };
const assetSchema: Schema = {
  type: 'object', required: ['id', 'sha256', 'mediaType', 'byteLength'], additionalProperties: false,
  properties: { id: uuid, sha256: hash, mediaType: text, byteLength: length },
};
const projectProperties = {
  schemaVersion: { const: 1 },
  projectId: uuid,
  assets: { type: 'array', maxItems: projectLimits.entries - 3, items: assetSchema },
  source: { oneOf: [{ type: 'null' }, {
    type: 'object', required: ['extension', 'name', 'sha256', 'byteLength'], additionalProperties: false,
    properties: { extension: { enum: ['gp3', 'gp4', 'gp5', 'gpx', 'gp', 'musicxml', 'mxl', 'mid', 'midi'] },
      name: text, sha256: hash, byteLength: length },
  }] },
  preservation: { type: 'array', maxItems: 10000, items: {
    type: 'object', required: ['feature', 'location', 'status', 'detail', 'dependencies'], additionalProperties: false,
    properties: { feature: text, location: text, status: { enum: ['mapped', 'preserved', 'unverified'] },
      detail: text, dependencies: { type: 'array', maxItems: 10000, items: text } },
  } },
} satisfies Readonly<Record<string, Schema>>;
const required = Object.keys(projectProperties);
const manifestSchema: Schema = {
  type: 'object', additionalProperties: false,
  required: [...required, 'revision', 'scoreSha256', 'contentHash', 'manifestSha256'],
  properties: { ...projectProperties, revision: { type: 'integer', minimum: 0 },
    scoreSha256: hash, contentHash: hash, manifestSha256: hash },
};
function isManifest(input: unknown): input is ProjectManifest {
  return checkSchema(input, manifestSchema).length === 0;
}
export function parseManifest(input: unknown): ProjectManifest {
  if (!isManifest(input)) throw new StorageError('SCHEMA', 'Invalid project manifest');
  return input;
}
function isProject(input: unknown): input is ProjectV1 {
  return checkSchema(input, {
    type: 'object', required: [...required, 'score'], additionalProperties: false,
    properties: { ...projectProperties, score: { type: 'object' } },
  }).length === 0;
}
export function parseProject(input: unknown): ProjectV1 {
  if (!isProject(input)) throw new StorageError('SCHEMA', 'Invalid project');
  if (input.source?.extension === 'musicxml' && input.source.byteLength > projectLimits.xml) {
    throw new StorageError('LIMIT', 'XML exceeds 64 MiB');
  }
  const score = parseScoreDocument(input.score);
  const ids = new Set(input.assets.map(asset => asset.id));
  if (ids.size !== input.assets.length || input.assets.length !== score.assets.length ||
    input.assets.some(asset => !score.assets.some(other => other.id === asset.id &&
      other.sha256 === asset.sha256 && other.byteLength === asset.byteLength && other.mediaType === asset.mediaType))) {
    throw new StorageError('SCHEMA', 'Project asset manifest must match score assets');
  }
  return { ...input, score };
}
export function parsePackageParts(input: unknown): PackageParts {
  if (typeof input !== 'object' || input === null || !('project' in input) ||
    !('blobs' in input) || !Array.isArray(input.blobs) || input.blobs.length > projectLimits.entries) {
    throw new StorageError('SCHEMA', 'Expected bounded package parts');
  }
  const project = parseProject(input.project);
  const blobs: AssetBytes[] = [];
  let total = 0;
  for (const blob of input.blobs) {
    if (typeof blob !== 'object' || blob === null || !('sha256' in blob) ||
      typeof blob.sha256 !== 'string' || !new RegExp(hashPattern).test(blob.sha256) ||
      !('bytes' in blob) || !(blob.bytes instanceof Uint8Array)) throw new StorageError('SCHEMA', 'Invalid asset bytes');
    total += blob.bytes.byteLength;
    if (blob.bytes.byteLength > projectLimits.asset || total > projectLimits.expanded) throw new StorageError('LIMIT', 'Asset bytes exceed project limits');
    blobs.push({ sha256: blob.sha256, bytes: blob.bytes.slice() });
  }
  if (new Set(blobs.map(blob => blob.sha256)).size !== blobs.length) throw new StorageError('SCHEMA', 'Duplicate asset payload');
  return { project: structuredClone(project), blobs };
}
export function parseRevision(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) throw new StorageError('SCHEMA', 'Invalid revision');
  return input;
}
export function receiptMatches(receipt: SaveReceipt, currentContentHash: string): boolean {
  return receipt.contentHash === currentContentHash;
}
