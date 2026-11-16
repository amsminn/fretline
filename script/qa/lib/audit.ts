import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { artifactManifest } from '../artifacts';

type CurrentEvidence = {
  readonly fixtureHashes: Readonly<Record<string, string>>;
  readonly planHash: string;
  readonly sinceFixtures: boolean;
};

export class ArtifactEvidenceError extends Error {
  constructor(readonly status: 'MISSING' | 'MUTATED', message: string) { super(message); }
}

async function auditArtifacts(file: string, result: Record<string, unknown>): Promise<void> {
  const manifest = result['artifacts'];
  if (!Array.isArray(manifest)) throw new ArtifactEvidenceError('MISSING', 'Missing artifacts manifest');
  const recorded = new Map<string, { readonly size: number; readonly sha256: string }>();
  for (const item of manifest) {
    const artifact = object(item);
    const path = artifact['path'];
    const size = artifact['size'];
    const hash = artifact['sha256'];
    requireEvidence(typeof path === 'string' && path.length > 0 && !path.includes('\\') &&
      !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || part === '') &&
      path !== 'result.json', 'Invalid artifact path');
    requireEvidence(typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 &&
      typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), `Invalid artifact manifest entry: ${path}`);
    requireEvidence(!recorded.has(path), `Duplicate artifact path: ${path}`);
    recorded.set(path, { size, sha256: hash });
  }
  let actual;
  try { actual = await artifactManifest(dirname(file)); } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new ArtifactEvidenceError('MUTATED', error.message);
  }
  for (const artifact of actual) {
    const expected = recorded.get(artifact.path);
    if (!expected) throw new ArtifactEvidenceError('MUTATED', `Unlisted artifact: ${artifact.path}`);
    if (expected.size !== artifact.size || expected.sha256 !== artifact.sha256) {
      throw new ArtifactEvidenceError('MUTATED', `Artifact size/hash mismatch: ${artifact.path}`);
    }
    recorded.delete(artifact.path);
  }
  if (recorded.size > 0) throw new ArtifactEvidenceError('MUTATED', `Missing artifact: ${[...recorded.keys()].join(', ')}`);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected evidence object');
  }
  return Object.fromEntries(Object.entries(value));
}

function requireEvidence(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

// Exclusions match POSIX paths relative to --evidence, either a directory or
// result.json. Directory matches prune their entire subtree; nothing is implicit.
export async function discoverResults(root: string, excludes: readonly string[]): Promise<readonly string[]> {
  const patterns = excludes.map(pattern => new Bun.Glob(pattern));
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const local = relative(root, path).replaceAll('\\', '/');
      if (patterns.some(pattern => pattern.match(local))) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === 'result.json') results.push(path);
    }
  }
  await visit(root);
  return results.sort();
}

// A scenario may declare child result.json files it deliberately drives to FAIL and
// asserts on (expectedNegativeChildren, relative to its own directory). Such a child
// is accepted as EXPECTED_FAIL only when the declaring parent itself is PASS; the
// child must still be a well-formed FAIL record. Children of non-PASS parents are
// audited like any other scenario.
export async function expectedNegativeChildren(files: readonly string[]): Promise<ReadonlySet<string>> {
  const expected = new Set<string>();
  for (const file of files) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = Object.fromEntries(Object.entries(parsed));
    const children = record['expectedNegativeChildren'];
    if (record['status'] !== 'PASS' || !Array.isArray(children)) continue;
    for (const child of children) {
      if (typeof child !== 'string' || child.startsWith('/') || child.split('/').includes('..')) continue;
      expected.add(resolve(dirname(file), child));
    }
  }
  return expected;
}

export async function auditScenario(file: string, current: CurrentEvidence,
  expectedNegative = false): Promise<'PASS' | 'BLOCKED' | 'EXPECTED_FAIL' | 'INCONCLUSIVE' | 'HITCH' | 'STALE'> {
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  const result = object(parsed);
  requireEvidence(typeof result['case'] === 'string' && result['case'].trim().length > 0, 'Missing scenario case');
  const assertions = result['assertions'];
  requireEvidence(Array.isArray(assertions), 'Missing assertions');
  for (const value of assertions) {
    const assertion = object(value);
    requireEvidence(typeof assertion['name'] === 'string' && assertion['name'].trim().length > 0 &&
      typeof assertion['passed'] === 'boolean', 'Malformed assertion');
  }
  const versions = object(result['versions']);
  requireEvidence(Object.values(versions).every(value => typeof value === 'string'), 'Malformed versions');
  for (const name of ['node', 'bun', 'alphatab', 'playwright', 'typescript']) {
    requireEvidence(typeof versions[name] === 'string' && versions[name].trim().length > 0, `Missing version: ${name}`);
  }
  const electron = versions['electronPackage'] ?? versions['electron'];
  requireEvidence(typeof electron === 'string' && electron.trim().length > 0, 'Missing version: electron');
  requireEvidence(result['planHash'] === current.planHash, 'Plan hash mismatch');
  const hashes = object(result['fixtureHashes']);
  const stale = Object.keys(hashes).length !== Object.keys(current.fixtureHashes).length ||
    Object.entries(current.fixtureHashes).some(([path, hash]) => hashes[path] !== hash);
  requireEvidence(!stale || current.sinceFixtures, 'Fixture hash mismatch');
  const cleanup = result['cleanup'];
  requireEvidence(Array.isArray(cleanup), 'Missing cleanup records');
  for (const value of cleanup) {
    const receipt = object(value);
    requireEvidence(typeof receipt['name'] === 'string' && receipt['reaped'] === true, 'Malformed or unreaped child');
  }
  requireEvidence((await readFile(resolve(dirname(file), 'actions.log'), 'utf8')).trim().length > 0,
    'Empty action log');
  const status = result['status'];
  if (expectedNegative && status !== 'FAIL') throw new TypeError('Declared negative child did not fail');
  switch (status) {
    case 'PASS':
      requireEvidence(result['exitCode'] === 0 && assertions.length > 0 && result['failure'] === null,
        'Invalid PASS claim');
      requireEvidence(assertions.every(value => object(value)['passed'] === true), 'Failed assertion in PASS claim');
      await auditArtifacts(file, result);
      return stale ? 'STALE' : 'PASS';
    case 'BLOCKED_PERMISSION':
      requireEvidence(result['exitCode'] === 3 && object(result['failure'])['kind'] === 'permission',
        'Invalid permission claim');
      await auditArtifacts(file, result);
      return stale ? 'STALE' : 'BLOCKED';
    case 'INCONCLUSIVE-LOAD':
      requireEvidence(result['exitCode'] === 6 && object(result['failure'])['kind'] === 'load',
        'Invalid load claim');
      await auditArtifacts(file, result);
      return stale ? 'STALE' : 'INCONCLUSIVE';
    case 'INCONCLUSIVE-HITCH':
      requireEvidence(result['exitCode'] === 6 && object(result['failure'])['kind'] === 'hitch',
        'Invalid hitch claim');
      await auditArtifacts(file, result);
      return stale ? 'STALE' : 'HITCH';
    case 'FAIL':
      requireEvidence(Number.isInteger(result['exitCode']) && typeof result['exitCode'] === 'number' &&
        result['exitCode'] > 0 && result['exitCode'] !== 3, 'Invalid FAIL exit code');
      if (expectedNegative) {
        await auditArtifacts(file, result);
        return stale ? 'STALE' : 'EXPECTED_FAIL';
      }
      throw new TypeError('QA result failed');
    default:
      throw new TypeError(`Invalid QA status: ${String(status)}`);
  }
}

type PlanRequirement = {
  readonly id: string;
  readonly cases: readonly string[];
  readonly runner?: string;
  readonly packaged?: boolean;
  readonly version?: string;
  readonly tokenGate?: boolean;
};
export type PlanInventory = {
  readonly tasks: number;
  readonly scenarios: number;
  readonly gpVersions: readonly string[];
  readonly uxRows: number;
  readonly isRows: number;
  readonly requirements: readonly PlanRequirement[];
  readonly notMachineCheckable: readonly string[];
};

// Parse the plan's machine-bearing tables and command lines, never a copied case
// inventory. Unparseable obligations remain explicit and block the final audit.
export function derivePlanRequirements(text: string): PlanInventory {
  const requirements: PlanRequirement[] = [];
  const notMachineCheckable: string[] = [
    'Visual fidelity to GP references, real OS focus/input, audible quality, independent reader correctness and silent export loss require reviewer inspection of the hashed artifacts.',
    'Artifact integrity proves recorded bytes and completeness within each evidence directory, not that a case produced every semantically required output or that assertions are truthful.',
  ];
  const tasks = [...text.matchAll(/^- \[[ xX]\] (\d+)\. (.*?)(?=^- \[[ xX]\] \d+\.|^## (?!Todos)|$(?![\s\S]))/gms)];
  let scenarios = 0;
  for (const task of tasks) {
    const id = `T${String(task[1]).padStart(2, '0')}`;
    const body = task[2] ?? '';
    const qa = body.split('\n').find(line => line.trimStart().startsWith('QA scenarios:')) ?? '';
    const commands = [...qa.matchAll(/`bun run qa:(\w+) -- ([^`]+)`/g)];
    for (const [index, command] of commands.entries()) {
      const args = command[2] ?? '';
      const scenario = /--case\s+([\w-]+)/.exec(args)?.[1];
      if (!scenario) continue;
      requirements.push({ id: `${id} ${index === 0 ? 'happy' : 'failure'}`, cases: [scenario],
        runner: command[1] ?? '', packaged: /--app\s+\S+/.test(args) });
      scenarios++;
    }
    if (commands.length !== 2) {
      requirements.push({ id: `${id} unparsed QA scenarios`, cases: [] });
      notMachineCheckable.push(`${id}: expected happy and failure commands, found ${commands.length}; manual reconciliation required.`);
    }
  }
  requireEvidence(tasks.length > 0, 'Plan has no task QA inventory');
  const final = text.split('## Final verification wave')[1]?.split(/^## /m)[0] ?? '';
  for (const command of final.matchAll(/^- \[[ xX]\] (F\d+)\.([\s\S]*?)(?=^- \[[ xX]\] F\d+\.|$(?![\s\S]))/gm)) {
    const body = command[2] ?? '';
    const qa = /`bun run qa:(native|electron|domain|bootstrap) -- ([^`]+)`/.exec(body);
    const scenario = qa && /--case\s+([\w-]+)/.exec(qa[2] ?? '')?.[1];
    if (qa && scenario) requirements.push({ id: command[1] ?? '', cases: [scenario],
      runner: qa[1] ?? '', packaged: /--app\s+\S+/.test(qa[2] ?? '') });
  }
  let uxRows = 0;
  let isRows = 0;
  for (const line of text.split('\n')) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim().replaceAll('`', ''));
    const id = cells[0] ?? '';
    if (/^UX\d+$/.test(id)) {
      uxRows++;
      requirements.push({ id, cases: (cells[3] ?? '').split(/[;,]/).map(name => name.trim()).filter(Boolean) });
    }
    if (/^IS-\d+$/.test(id) && cells.length >= 4) {
      isRows++;
      requirements.push({ id, cases: (cells[2] ?? '').split(/[;,]/).map(name => name.trim()).filter(Boolean) });
    }
  }
  const input = text.split('\n').find(line => /^\|\s*GP.*\binput\s*\|/.test(line)) ?? '';
  const formats = input.split('|')[1] ?? '';
  const gpVersions: string[] = [];
  for (const group of formats.matchAll(/GP(X|\d+(?:\/\d+)*)/g)) {
    for (const part of (group[1] ?? '').split('/')) gpVersions.push(`GP${part}`);
  }
  const importCase = requirements.find(requirement => requirement.cases.some(name => /import.*gp.*version/.test(name)))?.cases[0];
  for (const version of gpVersions) {
    requirements.push({ id: version, cases: importCase ? [importCase] : [], version });
  }
  if (text.includes('lint:tokens')) {
    const gateCase = requirements.flatMap(requirement => requirement.cases)
      .find(name => /token.*lint|lint.*token/.test(name));
    requirements.push({ id: 'lint:tokens', cases: [gateCase ?? 'lint:tokens'], tokenGate: true });
  }
  if (gpVersions.length === 0) {
    requirements.push({ id: 'GP input inventory unparsed', cases: [] });
    notMachineCheckable.push('No GP input format table could be parsed; manual reconciliation required.');
  }
  return { tasks: tasks.length, scenarios, gpVersions, uxRows, isRows, requirements, notMachineCheckable };
}

export type RequirementVerdict = {
  readonly id: string;
  readonly status: 'PASS' | 'MISSING' | 'FAIL' | 'MUTATED';
  readonly paths: readonly string[];
  readonly detail: string;
};

export async function auditPlan(inventory: PlanInventory, files: readonly string[],
  current: CurrentEvidence): Promise<readonly RequirementVerdict[]> {
  const records: { readonly file: string; readonly result: Record<string, unknown> }[] = [];
  const malformed: RequirementVerdict[] = [];
  for (const file of files) {
    try { records.push({ file, result: object(JSON.parse(await readFile(file, 'utf8'))) }); } catch (error) {
      if (!(error instanceof Error)) throw error;
      malformed.push({ id: 'unreadable result', status: 'FAIL', paths: [file], detail: error.message });
    }
  }
  // A result can serve task, UX, IS and GP requirements; hash it only once.
  const checked = new Map<string, Promise<void>>();
  const verify = (file: string): Promise<void> => {
    let pending = checked.get(file);
    if (!pending) {
      pending = (async () => {
        const status = await auditScenario(file, { ...current, sinceFixtures: false });
        requireEvidence(status === 'PASS', `Required scenario is ${status}; only PASS with exit code 0 satisfies coverage`);
      })();
      checked.set(file, pending);
    }
    return pending;
  };
  const verdicts: RequirementVerdict[] = [];
  for (const requirement of inventory.requirements) {
    const paths: string[] = [];
    const details: string[] = [];
    let status: RequirementVerdict['status'] = 'PASS';
    if (requirement.cases.length === 0) status = 'MISSING';
    for (const scenario of requirement.cases) {
      const candidates = records.filter(record => record.result['case'] === scenario);
      if (candidates.length === 0) {
        if (status !== 'MUTATED' && status !== 'FAIL') status = 'MISSING';
        details.push(`No result records case ${scenario}`);
        continue;
      }
      const failures: RequirementVerdict[] = [];
      let satisfied = false;
      for (const { file, result } of candidates) {
        try {
          await verify(file);
          if (requirement.runner) {
            const runner = result['runner'];
            if (requirement.runner === 'native' && runner === 'electron') {
              requireEvidence(result['headless'] === true, 'Native substitute must use the hidden runner');
            } else {
              requireEvidence(runner === requirement.runner, `Required runner: ${requirement.runner}; recorded: ${String(runner)}`);
            }
          }
          if (requirement.packaged) requireEvidence(typeof result['app'] === 'string' &&
            result['app'].trim().length > 0, 'Packaged case missing --app provenance');
          if (requirement.version) {
            const pattern = new RegExp(`\\b${requirement.version}\\b`, 'i');
            // A fixture checksum inventory alone cannot prove that version was exercised.
            const assertions = result['assertions'];
            const names = Array.isArray(assertions) ? assertions.map(value => String(object(value)['name'])) : [];
            if (!names.some(name => pattern.test(name))) {
              throw new ArtifactEvidenceError('MISSING', `No passing import assertion for ${requirement.version}`);
            }
          }
          if (requirement.tokenGate) {
            const assertions = result['assertions'];
            requireEvidence(Array.isArray(assertions) && assertions.some(value =>
              object(value)['passed'] === true && /lint:tokens.*passes.*real tree/i.test(String(object(value)['name']))),
            'Missing real-tree lint:tokens passing assertion');
            const artifacts = result['artifacts'];
            requireEvidence(Array.isArray(artifacts), 'Missing artifacts manifest');
            let cleanLog = false;
            for (const artifact of artifacts) {
              const path = String(object(artifact)['path']);
              if (path.endsWith('.log') &&
                /(?:^|\n)lint:tokens OK \(\.\)(?:\n|$)/.test(await readFile(resolve(dirname(file), path), 'utf8'))) {
                cleanLog = true;
              }
            }
            requireEvidence(cleanLog, 'Missing hashed real-tree lint:tokens success log');
          }
          paths.push(file);
          if (requirement.runner === 'native' && result['runner'] === 'electron') {
            details.push('native -> hidden runner');
          }
          satisfied = true;
          break;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          failures.push({ id: requirement.id, status: error instanceof ArtifactEvidenceError ? error.status : 'FAIL',
            paths: [file], detail: error.message });
        }
      }
      if (!satisfied) {
        const failure = failures.find(value => value.status === 'MUTATED') ??
          failures.find(value => value.status === 'FAIL') ?? failures[0];
        if (failure) {
          if (status !== 'MUTATED') status = failure.status;
          paths.push(...failure.paths);
          details.push(failure.detail);
        }
      }
    }
    verdicts.push({ id: requirement.id, status, paths, detail: details.join('; ') ||
      (status === 'PASS' ? 'Manifest, assertions, inputs, action log and actual artifact bytes verified' : 'No machine-readable scenario mapping') });
  }
  return [...verdicts, ...malformed];
}
