import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { QaContext } from './lib/contracts';
import { QaFailure, exitCodes, failureStatus } from './lib/contracts';
import { qaPlanHash } from './lib/plan';

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export type Artifact = { readonly path: string; readonly size: number; readonly sha256: string };

// Snapshot after case teardown and actions.log flush. No live-file exclusions:
// only this directory's own result.json is excluded to avoid a recursive hash.
// Nested child results are artifacts of their parent as well as separate evidence.
export async function artifactManifest(root: string): Promise<readonly Artifact[]> {
  const artifacts: Artifact[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (file === resolve(root, 'result.json')) continue;
      if (entry.isDirectory()) await visit(file);
      else {
        if (!entry.isFile()) throw new TypeError(`Unsupported artifact (not a regular file): ${file}`);
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of createReadStream(file)) {
          hash.update(chunk);
          size += chunk.length;
        }
        artifacts.push({ path: relative(root, file).replaceAll('\\', '/'), size, sha256: hash.digest('hex') });
      }
    }
  }
  await visit(root);
  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}
export async function fixtureHashes(): Promise<Readonly<Record<string, string>>> {
  const manifest: unknown = JSON.parse(await readFile('tests/fixtures/manifest.json', 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('fixtures' in manifest) || !Array.isArray(manifest.fixtures)) {
    throw new QaFailure('infrastructure', 'Invalid fixture manifest');
  }
  const hashes: Record<string, string> = {};
  for (const entry of manifest.fixtures) {
    if (typeof entry !== 'object' || entry === null ||
      !('path' in entry) || typeof entry.path !== 'string' ||
      !('expected' in entry) || typeof entry.expected !== 'string' ||
      !('sha256' in entry) || typeof entry.sha256 !== 'string' ||
      !('expectedSha256' in entry) || typeof entry.expectedSha256 !== 'string') {
      throw new QaFailure('infrastructure', 'Invalid fixture entry');
    }
    for (const [path, expected] of [[entry.path, entry.sha256], [entry.expected, entry.expectedSha256]] as const) {
      if (path.split('/').includes('..') || path.startsWith('/')) throw new QaFailure('infrastructure', 'Fixture path escapes root');
      const actual = sha256(await readFile(resolve('tests/fixtures', path)));
      if (actual !== expected) throw new QaFailure('infrastructure', `Fixture checksum mismatch: ${path}`);
      hashes[path] = actual;
    }
  }
  return hashes;
}
export async function writeResult(context: QaContext, scenario: string, failure: QaFailure | undefined,
  execution?: { readonly runner: 'domain' | 'electron' | 'native'; readonly headless: boolean }): Promise<void> {
  const exitCode = failure ? exitCodes[failure.kind] : 0;
  await writeFile(resolve(context.evidence, 'actions.log'), `${context.actions.join('\n')}\n`);
  await writeFile(resolve(context.evidence, 'result.json'), JSON.stringify({
    case: scenario, status: failureStatus(failure),
    exitCode, assertions: context.assertions, versions: context.versions,
    fixtureHashes: await fixtureHashes(),
    planHash: await qaPlanHash(),
    artifacts: await artifactManifest(context.evidence),
    runner: execution?.runner ?? null, headless: execution?.headless ?? null, app: context.app ?? null,
    cleanup: context.cleanup, expectedNegativeChildren: context.expectedNegativeChildren, failure: failure ? { kind: failure.kind, message: failure.message } : null,
  }, null, 2));
}
