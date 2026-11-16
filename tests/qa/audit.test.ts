import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactManifest, fixtureHashes, writeResult } from '../../script/qa/artifacts';
import { discoverResults } from '../../script/qa/lib/audit';
import { QaFailure } from '../../script/qa/lib/contracts';
import { qaPlanHash } from '../../script/qa/lib/plan';

let root: string;
let valid: Record<string, unknown>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fretline-audit-'));
  valid = {
    case: 'audit-fixture', status: 'PASS', exitCode: 0,
    assertions: [{ name: 'independent check', passed: true }],
    versions: { node: '24.16.0', bun: '1.4.0', alphatab: '1.9.0', playwright: '1.65.0',
      electronPackage: '45.2.3', typescript: '6.0.3' },
    fixtureHashes: await fixtureHashes(),
    planHash: await qaPlanHash(),
    cleanup: [], failure: null,
  };
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function scenario(path: string, overrides: Readonly<Record<string, unknown>> = {}): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'result.json'), JSON.stringify({ ...valid, ...overrides }));
  await writeFile(join(path, 'actions.log'), 'Executed independent check\n');
}

async function audit(path: string, excludes: readonly string[] = [],
  options: { readonly allowInconclusiveLoad?: boolean; readonly sinceFixtures?: boolean } = {}) {
  // Seal synthetic trees after all nested cases have been assembled, just as
  // writeResult seals the real parent after its child has finished.
  for (const file of [...await discoverResults(path, [])].sort((a, b) => b.length - a.length)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const result = Object.fromEntries(Object.entries(parsed));
      if (result['artifacts'] !== undefined) continue;
      await writeFile(file, JSON.stringify({ ...result, artifacts: await artifactManifest(join(file, '..')) }));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error; // malformed JSON is intentionally audited below
    }
  }
  const child = spawn('bun', ['script/qa/audit.ts', '--evidence', path,
    ...(options.allowInconclusiveLoad ? ['--allow-inconclusive-load'] : []),
    ...(options.sinceFixtures ? ['--since-fixtures'] : []),
    ...excludes.flatMap(glob => ['--exclude', glob])], { env: process.env, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  return { code, output };
}

describe('QA audit CLI evidence contract', () => {
  it('audits every nested scenario including children of a scenario directory', async () => {
    const tree = join(root, 'valid');
    await scenario(tree);
    await scenario(join(tree, 'round', 'happy'));
    await scenario(join(tree, 'round', 'failure'));
    const actual = await audit(tree);
    expect(actual.code).toBe(0);
    expect(actual.output.split('\n').filter(line => line.startsWith('PASS\t'))).toHaveLength(3);
    expect(actual.output).toContain(join(tree, 'round', 'failure', 'result.json'));
  });

  it('accepts Electron runtime versions with empty optional build components', async () => {
    const tree = join(root, 'electron');
    await scenario(tree, { versions: { node: '24.22.2', bun: '1.4.0', alphatab: '1.9.0',
      playwright: '1.65.0', typescript: '6.0.3', electron: '45.2.3', nghttp3: '', ngtcp2: '' } });
    const actual = await audit(tree);
    expect(actual.code).toBe(0);
    expect(actual.output).toContain(`PASS\t${join(tree, 'result.json')}`);
  });

  it.each([
    { name: 'FAIL anywhere', overrides: { status: 'FAIL', exitCode: 1,
      failure: { kind: 'assertion', message: 'regression' } }, reason: 'QA result failed' },
    { name: 'missing assertions', overrides: { assertions: null }, reason: 'Missing assertions' },
    { name: 'failed assertion', overrides: { assertions: [{ name: 'bad', passed: false }] }, reason: 'Failed assertion' },
    { name: 'empty assertions', overrides: { assertions: [] }, reason: 'Invalid PASS' },
    { name: 'wrong exit', overrides: { exitCode: 2 }, reason: 'Invalid PASS' },
    { name: 'missing versions', overrides: { versions: {} }, reason: 'Missing version' },
    { name: 'stale plan', overrides: { planHash: '0'.repeat(64) }, reason: 'Plan hash mismatch' },
    { name: 'stale fixtures', overrides: { fixtureHashes: {} }, reason: 'Fixture hash mismatch' },
    { name: 'unreaped child', overrides: { cleanup: [{ name: 'child', reaped: false }] }, reason: 'unreaped child' },
    { name: 'unknown status', overrides: { status: 'UNKNOWN' }, reason: 'Invalid QA status' },
    { name: 'saturated machine', overrides: { status: 'INCONCLUSIVE-LOAD', exitCode: 6,
      failure: { kind: 'load', message: 'load1=12 cpuCount=8' } }, reason: 'QA result INCONCLUSIVE-LOAD' },
    { name: 'forged load status', overrides: { status: 'INCONCLUSIVE-LOAD', exitCode: 0 }, reason: 'Invalid load claim' },
    { name: 'host hitch', overrides: { status: 'INCONCLUSIVE-HITCH', exitCode: 6,
      failure: { kind: 'hitch', message: 'off-CPU renderer stall' } }, reason: 'INCONCLUSIVE-HITCH' },
    { name: 'forged hitch status', overrides: { status: 'INCONCLUSIVE-HITCH', exitCode: 0,
      failure: { kind: 'hitch', message: 'forged' } }, reason: 'Invalid hitch claim' },
  ])('rejects $name without abandoning other scenarios', async ({ name, overrides, reason }) => {
    const tree = join(root, name);
    await scenario(join(tree, 'a', 'nested'), overrides);
    await scenario(join(tree, 'z'));
    const actual = await audit(tree);
    expect(actual.code).toBe(1);
    expect(actual.output).toContain(reason);
    expect(actual.output).toContain(`PASS\t${join(tree, 'z', 'result.json')}`);
  });

  it.each(['missing', 'empty'] as const)('rejects a %s actions.log', async kind => {
    const tree = join(root, `actions-${kind}`);
    await scenario(tree);
    if (kind === 'missing') await rm(join(tree, 'actions.log'));
    else await writeFile(join(tree, 'actions.log'), ' \n');
    const actual = await audit(tree);
    expect(actual.code).toBe(1);
    expect(actual.output).toContain(kind === 'missing' ? 'actions.log' : 'Empty action log');
  });

  it('reports permission evidence as BLOCKED without claiming PASS', async () => {
    const tree = join(root, 'blocked');
    await scenario(tree, { status: 'BLOCKED_PERMISSION', exitCode: 3,
      assertions: [{ name: 'Accessibility and Screen Recording permission granted', passed: false }],
      failure: { kind: 'permission', message: 'Permissions denied' } });
    const actual = await audit(tree);
    expect(actual.code).toBe(0);
    expect(actual.output).toContain(`BLOCKED\t${join(tree, 'result.json')}`);
    expect(actual.output).not.toContain('PASS');
  });

  it.each([
    { allow: false, code: 1 },
    { allow: true, code: 0 },
  ])('reports load evidence as INCONCLUSIVE with allow=$allow and exit $code', async ({ allow, code }) => {
    const tree = join(root, `load-${allow}`);
    await mkdir(tree, { recursive: true });
    await writeResult({
      evidence: tree, app: undefined, actions: ['Load remained above CPU count after 60 seconds'],
      assertions: [], cleanup: [], expectedNegativeChildren: [],
      versions: { node: '24.16.0', bun: '1.4.0', alphatab: '1.9.0', playwright: '1.65.0',
        electronPackage: '45.2.3', typescript: '6.0.3' },
      log() {}, assert() {},
    }, 'perf-render-edit', new QaFailure('load', 'load1=12 cpuCount=8'));
    const result: unknown = JSON.parse(await readFile(join(tree, 'result.json'), 'utf8'));
    expect(result).toMatchObject({ status: 'INCONCLUSIVE-LOAD', exitCode: 6, failure: { kind: 'load' } });
    const actual = await audit(tree, [], { allowInconclusiveLoad: allow });
    expect(actual.code).toBe(code);
    expect(actual.output).toContain(`INCONCLUSIVE\t${join(tree, 'result.json')}`);
    expect(actual.output).not.toContain('PASS');
  });

  it('never waives a hitch with --allow-inconclusive-load', async () => {
    const tree = join(root, 'hitch-load-flag');
    await scenario(tree, { status: 'INCONCLUSIVE-HITCH', exitCode: 6,
      failure: { kind: 'hitch', message: 'off-CPU renderer stall' } });
    const actual = await audit(tree, [], { allowInconclusiveLoad: true });
    expect(actual.code).toBe(1);
    expect(actual.output).toContain('INCONCLUSIVE-HITCH');
    expect(actual.output).not.toContain('PASS');
  });

  it.each([
    { name: 'forged-load-allowed', overrides: { status: 'INCONCLUSIVE-LOAD', exitCode: 0,
      failure: { kind: 'load', message: 'forged' } }, reason: 'Invalid load claim' },
    { name: 'wrong-load-kind-allowed', overrides: { status: 'INCONCLUSIVE-LOAD', exitCode: 6,
      failure: { kind: 'assertion', message: 'forged' } }, reason: 'Invalid load claim' },
    { name: 'failed-allowed', overrides: { status: 'FAIL', exitCode: 1,
      failure: { kind: 'assertion', message: 'regression' } }, reason: 'QA result failed' },
  ])('does not waive $name with --allow-inconclusive-load', async ({ name, overrides, reason }) => {
    const tree = join(root, name);
    await scenario(tree, overrides);
    const actual = await audit(tree, [], { allowInconclusiveLoad: true });
    expect(actual.code).toBe(1);
    expect(actual.output).toContain(`FAIL\t${join(tree, 'result.json')}\t${reason}`);
  });

  it('excludes only explicitly matched historical paths', async () => {
    const tree = join(root, 'excluded');
    await scenario(join(tree, 'current', 'happy'));
    await scenario(join(tree, 'verify-w1', '01-happy'), { status: 'FAIL', exitCode: 1 });
    await scenario(join(tree, 'other-history'), { status: 'FAIL', exitCode: 1 });
    const actual = await audit(tree, ['verify-w1/**', 'other-history']);
    expect(actual.code).toBe(0);
    expect(actual.output).toContain('Audited 1 scenario(s)');
    expect(actual.output).not.toContain('01-happy');
  });

  it.each([
    { name: 'changed', sinceFixtures: false, status: 'FAIL', code: 1 },
    { name: 'changed', sinceFixtures: true, status: 'STALE', code: 0 },
    { name: 'missing', sinceFixtures: false, status: 'FAIL', code: 1 },
    { name: 'missing', sinceFixtures: true, status: 'STALE', code: 0 },
    { name: 'added', sinceFixtures: false, status: 'FAIL', code: 1 },
    { name: 'added', sinceFixtures: true, status: 'STALE', code: 0 },
  ])('lists $name fixtures as $status with sinceFixtures=$sinceFixtures', async ({ name, sinceFixtures, status, code }) => {
    const tree = join(root, `fixtures-${name}-${sinceFixtures}`);
    const hashes = await fixtureHashes();
    const historical = {
      changed: Object.fromEntries(Object.keys(hashes).map(path => [path, '0'.repeat(64)])),
      missing: {},
      added: { ...hashes, 'removed-fixture': '0'.repeat(64) },
    }[name];
    await scenario(join(tree, 'old'), { fixtureHashes: historical });
    await scenario(join(tree, 'current'));
    const actual = await audit(tree, [], { sinceFixtures });
    expect(actual.code).toBe(code);
    expect(actual.output).toContain(`${status}\t${join(tree, 'old', 'result.json')}\tFixture hash mismatch`);
    expect(actual.output).toContain(`PASS\t${join(tree, 'current', 'result.json')}`);
    expect(actual.output).toContain('Audited 2 scenario(s)');
  });

  it.each([
    { name: 'failed', overrides: { status: 'FAIL', exitCode: 1 }, reason: 'QA result failed' },
    { name: 'unreaped', overrides: { cleanup: [{ name: 'child', reaped: false }] }, reason: 'Malformed or unreaped child' },
    { name: 'plan', overrides: { planHash: '0'.repeat(64) }, reason: 'Plan hash mismatch' },
    { name: 'malformed', overrides: { fixtureHashes: null }, reason: 'Expected evidence object' },
  ])('keeps $name evidence fatal with --since-fixtures', async ({ name, overrides, reason }) => {
    const tree = join(root, `stale-invalid-${name}`);
    await scenario(tree, { fixtureHashes: {}, ...overrides });
    const actual = await audit(tree, [], { sinceFixtures: true });
    expect(actual.code).toBe(1);
    expect(actual.output).toContain(`FAIL\t${join(tree, 'result.json')}\t${reason}`);
    expect(actual.output).not.toContain('STALE\t');
  });

  it('fails when exclusions leave no scenarios', async () => {
    const tree = join(root, 'empty');
    await scenario(join(tree, 'history'));
    const actual = await audit(tree, ['**']);
    expect(actual.code).toBe(1);
    expect(actual.output).toContain('No QA result.json');
  });

  it('rejects malformed JSON in single-scenario mode', async () => {
    const tree = join(root, 'malformed');
    await scenario(tree);
    await writeFile(join(tree, 'result.json'), '{');
    const actual = await audit(tree);
    expect(actual.code).toBe(1);
    expect(actual.output).toContain(`FAIL\t${join(tree, 'result.json')}`);
  });
it('accepts a declared negative child only as EXPECTED_FAIL under a passing parent', async () => {
    const tree = join(root, 'negative-accepted');
    await scenario(tree, { expectedNegativeChildren: ['child/result.json'] });
    await scenario(join(tree, 'child'), { status: 'FAIL', exitCode: 1,
      failure: { kind: 'assertion', message: 'intentional' } });
    const actual = await audit(tree);
    expect(actual.code).toBe(0);
    expect(actual.output).toContain(`EXPECTED_FAIL\t${join(tree, 'child', 'result.json')}`);
    expect(actual.output).not.toContain('QA result failed');
  });

  it('rejects a declared negative child when the declaring parent did not pass', async () => {
    const tree = join(root, 'negative-parent-failed');
    await scenario(tree, { status: 'FAIL', exitCode: 1, expectedNegativeChildren: ['child/result.json'],
      failure: { kind: 'assertion', message: 'parent broke' } });
    await scenario(join(tree, 'child'), { status: 'FAIL', exitCode: 1,
      failure: { kind: 'assertion', message: 'intentional' } });
    const actual = await audit(tree);
    expect(actual.code).toBe(1);
    expect(actual.output).toContain(`FAIL\t${join(tree, 'child', 'result.json')}\tQA result failed`);
  });

  it('rejects a declared negative child that unexpectedly passed', async () => {
    const tree = join(root, 'negative-passed');
    await scenario(tree, { expectedNegativeChildren: ['child/result.json'] });
    await scenario(join(tree, 'child'));
    const actual = await audit(tree);
    expect(actual.code).toBe(1);
    expect(actual.output).toContain('Declared negative child did not fail');
  });

  it('does not let an undeclared failing child pass', async () => {
    const tree = join(root, 'negative-undeclared');
    await scenario(tree);
    await scenario(join(tree, 'child'), { status: 'FAIL', exitCode: 1,
      failure: { kind: 'assertion', message: 'real regression' } });
    const actual = await audit(tree);
    expect(actual.code).toBe(1);
  });
});
