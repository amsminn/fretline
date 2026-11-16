import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'fretline-harness-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function run(runner: string, scenario: string): Promise<{ readonly code: number | null; readonly result: Record<string, unknown> }> {
  const evidence = join(root, `${runner}-${scenario}`);
  const child = spawn('bun', [`script/qa/${runner}.ts`, '--case', scenario, '--evidence', evidence],
    { env: process.env, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  const json: unknown = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'));
  if (typeof json !== 'object' || json === null) throw new TypeError(`Missing result object: ${output}`);
  return { code, result: Object.fromEntries(Object.entries(json)) };
}

describe('QA CLI failure classification at real process boundaries', () => {
  it.each([
    { runner: 'domain', scenario: 'assertion-failure', code: 1, kind: 'assertion', status: 'FAIL' },
    { runner: 'domain', scenario: 'unregistered-case', code: 4, kind: 'unknownCase', status: 'FAIL' },
    { runner: 'electron', scenario: 'harness-crash', code: 5, kind: 'crash', status: 'FAIL' },
  ])('returns $code for $kind and writes honest evidence', async row => {
    const actual = await run(row.runner, row.scenario);
    expect(actual.code).toBe(row.code);
    expect(actual.result).toMatchObject({ status: row.status, exitCode: row.code, failure: { kind: row.kind } });
    if (row.kind === 'crash') {
      expect(actual.result['cleanup']).toEqual(expect.arrayContaining([expect.objectContaining({ reaped: true })]));
    }
  }, 90_000);

  it('passes a negative scenario only after its failing child exits', async () => {
    const actual = await run('domain', 'harness-negative');
    expect(actual.code).toBe(0);
    expect(actual.result).toMatchObject({ status: 'PASS', exitCode: 0, failure: null,
      cleanup: [expect.objectContaining({ exitCode: 1, signal: null, reaped: true })] });
  });
});
