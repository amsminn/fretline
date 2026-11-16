import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fixtureHashes, sha256 } from './artifacts';
import { ArtifactEvidenceError, auditPlan, auditScenario, derivePlanRequirements, discoverResults, expectedNegativeChildren } from './lib/audit';
import { qaPlanPath } from './lib/plan';

try {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter(arg => arg !== '--'),
    options: { evidence: { type: 'string' }, plan: { type: 'string' }, exclude: { type: 'string', multiple: true },
      help: { type: 'boolean', default: false },
      'since-fixtures': { type: 'boolean', default: false },
      'allow-inconclusive-load': { type: 'boolean', default: false } },
    strict: true,
  });
  if (values.help) {
    console.log(`Usage: bun run qa:audit -- [--plan <file>] [--evidence <root>] [--exclude <relative-glob>]
  --plan <file>             Require plan-derived task, GP, UX, IS and token coverage
  --since-fixtures           List fixture hash mismatches as STALE (non-fatal)
  --allow-inconclusive-load  Accept valid INCONCLUSIVE-LOAD evidence (non-fatal)
  --help                    Show this usage
Audits exactly the supplied evidence root recursively; without --evidence, checks fixtures only.`);
  } else {
    if (values.plan && !values.evidence) throw new TypeError('--plan requires --evidence');
    const planPath = values.plan ?? qaPlanPath();
    const plan = planPath ? await readFile(planPath) : Buffer.alloc(0);
    const current = {
      fixtureHashes: await fixtureHashes(),
      planHash: planPath ? sha256(plan) : 'none',
      sinceFixtures: values['since-fixtures'],
    };
    if (values.evidence) {
      const root = resolve(values.evidence);
      const results = await discoverResults(root, values.exclude ?? []);
      if (results.length === 0 && !values.plan) throw new TypeError('No QA result.json files found after exclusions');
      if (values.plan) {
        const inventory = derivePlanRequirements(plan.toString('utf8'));
        console.log(`Plan inventory: ${inventory.tasks} tasks, ${inventory.scenarios} task scenarios, ${inventory.gpVersions.length} GP versions, ${inventory.uxRows} UX rows, ${inventory.isRows} IS rows`);
        console.log('STATUS\tREQUIREMENT\tPATH\tDETAIL');
        const verdicts = await auditPlan(inventory, results, current);
        for (const verdict of verdicts) {
          console.log(`${verdict.status}\t${verdict.id}\t${verdict.paths.join(', ') || '-'}\t${verdict.detail}`);
        }
        for (const item of inventory.notMachineCheckable) console.log(`NOT MACHINE-CHECKABLE\t${item}`);
        const counts = Object.fromEntries(['PASS', 'MISSING', 'FAIL', 'MUTATED'].map(status =>
          [status, verdicts.filter(verdict => verdict.status === status).length]));
        console.log(`Plan audit summary: ${JSON.stringify(counts)}; ${results.length} result(s) discovered`);
        process.exitCode = verdicts.every(verdict => verdict.status === 'PASS') ? 0 : 1;
      } else {
        const negatives = await expectedNegativeChildren(results);
        console.log('STATUS\tSCENARIO\tDETAIL');
        let failed = false;
        for (const file of results) {
          try {
            const status = await auditScenario(file, current, negatives.has(file));
            const detail = {
              PASS: 'Recorded inputs, assertions, action log and artifact bytes verified; plan coverage not checked',
              BLOCKED: 'Permission block recorded; inputs and artifact bytes verified; workflow not passed',
              EXPECTED_FAIL: 'Declared negative child, inputs and artifact bytes verified',
              INCONCLUSIVE: 'QA result INCONCLUSIVE-LOAD: performance was not measured on an unsaturated machine',
              HITCH: 'QA result INCONCLUSIVE-HITCH: a clean cursor timing run is still required',
              STALE: 'Fixture hash mismatch: historical evidence; not a current PASS',
            }[status];
            console.log(`${status}\t${file}\t${detail}`);
            if (status === 'INCONCLUSIVE' && !values['allow-inconclusive-load']) failed = true;
            if (status === 'HITCH') failed = true;
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            failed = true;
            console.log(`${error instanceof ArtifactEvidenceError ? error.status : 'FAIL'}\t${file}\t${error.message}`);
          }
        }
        console.log(`Audited ${results.length} scenario(s)`);
        process.exitCode = failed ? 1 : 0;
      }
    }
    console.log('Fixture input and independent expectation checksums verified');
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`FAIL\t${error.message}`);
  process.exitCode = 1;
}
