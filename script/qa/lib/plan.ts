import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** QA results record the hash of the plan they were checked against; without FRETLINE_QA_PLAN it is 'none'. */
export const qaPlanPath = (): string | null => process.env['FRETLINE_QA_PLAN'] || null;

export async function qaPlanHash(path: string | null = qaPlanPath()): Promise<string> {
  return path ? createHash('sha256').update(await readFile(path)).digest('hex') : 'none';
}

/** Directory holding private reference screenshots for side-by-side captures, if available. */
export const qaReferenceDir = (): string | null => process.env['FRETLINE_QA_REFERENCES'] || null;
