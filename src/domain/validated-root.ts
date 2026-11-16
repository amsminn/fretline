import type { ScoreDocument } from './document';
import { hasSchemaCertificate } from './schema/check';
import { scoreSchema } from './schema/score';

const roots = new WeakSet<object>();

/** Only successful parsers and atomic edit validators certify an immutable root. */
export function rememberValidatedRoot(document: ScoreDocument): void {
  if (Object.isFrozen(document) && hasSchemaCertificate(document, scoreSchema)) roots.add(document);
}

export function isValidatedRoot(input: unknown): input is ScoreDocument {
  return typeof input === 'object' && input !== null && roots.has(input);
}
