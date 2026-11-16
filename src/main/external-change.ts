import { createHash } from 'node:crypto';
import { readBoundedFile, isMissing } from './atomic-save';
import { projectLimits } from '../domain/project';
import { t } from '../renderer/i18n';

export class ExternalChangeError extends Error {
  readonly code = 'EXTERNAL_CHANGE';
  constructor() {
    super(`EXTERNAL_CHANGE: ${t('main.externalChange')}`);
    this.name = 'ExternalChangeError';
  }
}
export type SaveDestination = { readonly path: string; readonly expectedHash: string };
const observed = new Map<string, string>();
export function observeFile(path: string, bytes: Uint8Array): string {
  const hash = createHash('sha256').update(bytes).digest('hex');
  observed.set(path, hash);
  return hash;
}
export function observedFile(path: string): string | undefined { return observed.get(path); }
export async function fileHash(path: string): Promise<string | null> {
  try { return createHash('sha256').update(await readBoundedFile(path, projectLimits.compressed)).digest('hex'); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}
export async function assertUnchanged(path: string, expected: string | null): Promise<void> {
  if (await fileHash(path) !== expected) throw new ExternalChangeError();
}
