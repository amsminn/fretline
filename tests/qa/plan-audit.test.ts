// @vitest-environment node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixtureHashes, writeResult } from '../../script/qa/artifacts';
import { QaFailure } from '../../script/qa/lib/contracts';
import { qaPlanHash } from '../../script/qa/lib/plan';

let root: string;
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
async function readResult(directory: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('Invalid result');
  return Object.fromEntries(Object.entries(parsed));
}
const plan = `## Scope
| Format | Required contract |
| GP3/4/5, GPX, GP7/8 input | Version fixtures |
| ID | Required behavior | Owner task | Scenario |
| UX01 | Open | 1 | import-gp-versions |
## Todos
- [ ] 1. Import formats
  Acceptance criteria: \`bun run lint:tokens\`
  QA scenarios: Happy — \`bun run qa:native -- --case import-gp-versions --evidence 01/happy\`. Failure — \`bun run qa:domain -- --case import-corrupt --evidence 01/failure\`.
## Final verification wave
## Success criteria
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| IS-1 | 1 | import-gp-versions; import-corrupt | \`01\` |
`;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'plan-audit-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function tree(name: string, text = plan) {
  const directory = join(root, name);
  await mkdir(directory);
  const planPath = join(directory, 'plan.md');
  await writeFile(planPath, text);
  const evidence = join(directory, 'evidence');
  await mkdir(evidence);
  return { planPath, evidence, text };
}

async function record(evidence: string, name: string, text: string,
  overrides: Readonly<Record<string, unknown>> = {}) {
  const directory = join(evidence, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'actions.log'), 'Verified independent output\n');
  await writeFile(join(directory, 'output.wav'), 'RIFF-test');
  const tokenGate = name === 'lint:tokens' || name === 'token-lint-negative';
  if (tokenGate) await writeFile(join(directory, 'lint-clean.log'), 'lint:tokens OK (.)\n');
  const artifacts = await Promise.all(['actions.log', 'output.wav', ...(tokenGate ? ['lint-clean.log'] : [])].map(async path => {
    const bytes = await readFile(join(directory, path));
    return { path, size: bytes.length, sha256: hash(bytes) };
  }));
  await writeFile(join(directory, 'result.json'), JSON.stringify({
    case: name, status: 'PASS', exitCode: 0, failure: null, cleanup: [],
    assertions: [...['GP3', 'GP4', 'GP5', 'GPX', 'GP7', 'GP8'].map(version =>
      ({ name: `${version} imported and checked`, passed: true })),
    ...(tokenGate ? [{ name: 'lint:tokens passes on the real tree', passed: true }] : [])],
    versions: { node: '24', bun: '1.4', electron: '45', alphatab: '1.9', playwright: '1', typescript: '6' },
    fixtureHashes: await fixtureHashes(), planHash: hash(text),
    runner: 'electron', headless: true, app: null, artifacts, ...overrides,
  }));
  return directory;
}

async function audit(evidence: string, planPath?: string) {
  const child = spawn('bun', ['script/qa/audit.ts', '--evidence', evidence,
    ...(planPath ? ['--plan', planPath] : [])], { env: process.env, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject); child.once('close', done);
  });
  return { code, output };
}

it('writes recursive artifact sizes and independent hashes without hashing its own result', async () => {
  const { evidence } = await tree('writer');
  await mkdir(join(evidence, 'exports'));
  await writeFile(join(evidence, 'exports', 'score.pdf'), '%PDF-fixture');
  await writeFile(join(evidence, 'result.json'), 'old result');
  await writeResult({
    evidence, app: undefined, actions: ['Checked score'], assertions: [], cleanup: [],
    expectedNegativeChildren: [], versions: {}, log() {}, assert() {},
  }, 'writer', new QaFailure('assertion', 'negative'));
  const result: unknown = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'));
  expect(result).toMatchObject({ status: 'FAIL', exitCode: 1, artifacts: [
    { path: 'actions.log', size: 14, sha256: hash('Checked score\n') },
    { path: 'exports/score.pdf', size: 12, sha256: hash('%PDF-fixture') },
  ] });
});

it.each(['changed', 'deleted', 'unlisted', 'omitted', 'escape', 'symlink'] as const)(
  'rejects %s artifacts in evidence-only mode', async kind => {
    const { evidence, text } = await tree(`artifacts-${kind}`);
    const directory = await record(evidence, 'artifact-check', text);
    if (kind === 'changed') await writeFile(join(directory, 'output.wav'), 'RIFF-tost');
    if (kind === 'deleted') await rm(join(directory, 'output.wav'));
    if (kind === 'unlisted') await writeFile(join(directory, 'extra.png'), 'PNG');
    if (kind === 'omitted' || kind === 'escape') {
      const result = await readResult(directory);
      if (kind === 'omitted') delete result['artifacts'];
      else result['artifacts'] = [{ path: '../outside', size: 1, sha256: hash('x') }];
      await writeFile(join(directory, 'result.json'), JSON.stringify(result));
    }
    if (kind === 'symlink') {
      const { symlink } = await import('node:fs/promises');
      await rm(join(directory, 'output.wav'));
      await symlink(join(directory, 'actions.log'), join(directory, 'output.wav'));
    }
    // Evidence-only mode still uses the repository plan hash.
    const result = await readResult(directory);
    result['planHash'] = await qaPlanHash();
    await writeFile(join(directory, 'result.json'), JSON.stringify(result));
    const actual = await audit(evidence);
    expect(actual.code).toBe(1);
    expect(actual.output).toMatch(/MUTATED|MISSING.*artifact|artifact.*manifest|Invalid artifact path/i);
  });

it('derives scenarios, version coverage, UX, IS and token gate from the supplied plan', async () => {
  const { evidence, planPath, text } = await tree('complete');
  for (const name of ['import-gp-versions', 'import-corrupt', 'lint:tokens']) {
    await record(evidence, name, text, { runner: name === 'import-corrupt' ? 'domain' : 'electron' });
  }
  const actual = await audit(evidence, planPath);
  expect(actual.code, actual.output).toBe(0);
  for (const requirement of ['T01 happy', 'T01 failure', 'GP3', 'GP4', 'GP5', 'GPX', 'GP7', 'GP8', 'UX01', 'IS-1', 'lint:tokens']) {
    expect(actual.output).toContain(`PASS\t${requirement}\t`);
  }
  expect(actual.output).toContain('native -> hidden runner');
});

it.each([
  { name: 'missing-case', overrides: { case: 'different-case' }, status: 'MISSING', requirement: 'T01 happy' },
  { name: 'blocked', overrides: { status: 'BLOCKED_PERMISSION', exitCode: 3,
    failure: { kind: 'permission', message: 'denied' } }, status: 'FAIL', requirement: 'T01 happy' },
  { name: 'missing-runner', overrides: { runner: null }, status: 'FAIL', requirement: 'T01 happy' },
  { name: 'visible', overrides: { headless: false }, status: 'FAIL', requirement: 'T01 happy' },
  { name: 'wrong-plan', overrides: { planHash: '0'.repeat(64) }, status: 'FAIL', requirement: 'T01 happy' },
  { name: 'missing-version', overrides: { assertions: [{ name: 'GP3 imported', passed: true }] },
    status: 'MISSING', requirement: 'GP8' },
])('rejects $name without relaxing required coverage', async ({ name, overrides, status, requirement }) => {
  const { evidence, planPath, text } = await tree(name);
  await record(evidence, 'import-gp-versions', text, overrides);
  const actual = await audit(evidence, planPath);
  expect(actual.code).toBe(1);
  expect(actual.output).toContain(`${status}\t${requirement}\t`);
  expect(actual.output).toContain('MISSING\tT01 failure\t');
  expect(actual.output).toContain('MISSING\tlint:tokens\t');
});

it('reports mutation against every requirement served by the damaged scenario', async () => {
  const { evidence, planPath, text } = await tree('plan-mutated');
  const directory = await record(evidence, 'import-gp-versions', text);
  await rm(join(directory, 'output.wav'));
  const actual = await audit(evidence, planPath);
  expect(actual.code).toBe(1);
  expect(actual.output).toContain('MUTATED\tT01 happy\t');
  expect(actual.output).toContain('MUTATED\tUX01\t');
});

it('requires --app provenance for packaged scenarios and derives newly added tasks', async () => {
  const text = plan.replace('## Final verification wave', `- [ ] 2. Package
  QA scenarios: Happy — \`bun run qa:native -- --case package-open --app App.app --evidence 02/happy\`. Failure — \`bun run qa:domain -- --case package-broken --evidence 02/failure\`.
## Final verification wave`);
  const setup = await tree('packaged', text);
  await record(setup.evidence, 'package-open', text);
  const actual = await audit(setup.evidence, setup.planPath);
  expect(actual.code).toBe(1);
  expect(actual.output).toContain('FAIL\tT02 happy\t');
  expect(actual.output).toContain('MISSING\tT02 failure\t');
});

it.each([
  { assertion: true, log: 'lint:tokens OK (.)\n', expected: 'PASS' },
  { assertion: false, log: 'lint:tokens OK (.)\n', expected: 'FAIL' },
  { assertion: true, log: 'src/file.ts:1: raw color literal\n', expected: 'FAIL' },
])('derives the token gate case and checks its real-tree receipt: $expected', async row => {
  const text = plan.replace('import-corrupt', 'token-lint-negative');
  const setup = await tree(`token-${row.assertion}-${row.expected}`, text);
  const directory = await record(setup.evidence, 'token-lint-negative', text, {
    runner: 'domain',
    assertions: [{ name: row.assertion ? 'lint:tokens passes on the real tree' : 'Injected lint failures detected', passed: true }],
  });
  await writeFile(join(directory, 'lint-clean.log'), row.log);
  const result = await readResult(directory);
  result['artifacts'] = await Promise.all(['actions.log', 'output.wav', 'lint-clean.log'].map(async path => {
    const bytes = await readFile(join(directory, path));
    return { path, size: bytes.length, sha256: hash(bytes) };
  }));
  await writeFile(join(directory, 'result.json'), JSON.stringify(result));
  const actual = await audit(setup.evidence, setup.planPath);
  expect(actual.output).toContain(`${row.expected}\tlint:tokens\t`);
});

it('keeps all evidence-linked rows and final packaged commands required when evidence is empty', async () => {
  const text = `${plan.replace('## Final verification wave', `## Final verification wave
- [ ] F3. Manual QA
  Run \`bun run qa:native -- --case release-journey --app App.app --evidence F3\`.
`)}
| IS-9 | 1 | additional-case | \`extra\` |
| UX20 | Extra behavior | 1 | extra-ux |
`;
  const setup = await tree('empty-evidence', text);
  const actual = await audit(setup.evidence, setup.planPath);
  expect(actual.code).toBe(1);
  for (const id of ['F3', 'IS-9', 'UX20', 'T01 happy', 'GP8', 'lint:tokens']) {
    expect(actual.output).toContain(`MISSING\t${id}\t`);
  }
});
