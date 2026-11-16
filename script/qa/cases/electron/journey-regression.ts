import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QaCase } from '../../lib/contracts';
import { exitCodes, QaFailure } from '../../lib/contracts';

/** Runs every executable Electron case, including the deliberate crash control. */
export const run: QaCase = async context => {
  const directory = resolve('script/qa/cases/electron');
  const cases: string[] = [];
  for (const file of (await readdir(directory)).sort()) {
    if (!file.endsWith('.ts') || file === 'journey-regression.ts') continue;
    const module: unknown = await import(pathToFileURL(resolve(directory, file)).href);
    if (typeof module === 'object' && module !== null && 'run' in module && typeof module.run === 'function') cases.push(file.slice(0, -3));
  }
  await writeFile(resolve(context.evidence, 'case-inventory.json'), JSON.stringify(cases, null, 2));
  const rows: { readonly case: string; readonly exitCode: number | null; readonly evidence: string }[] = [];
  for (const scenario of cases) {
    const evidence = resolve(context.evidence, 'cases', scenario);
    context.log(`Run enumerated case ${scenario}`);
    console.log(`CASE_START ${scenario}`);
    const gate = `while pgrep -fl '[q]a/electron.ts|[v]ite build|[e]lectron-builder' | awk '$1 != ${process.pid}' | /usr/bin/grep .; do sleep 1; done; sysctl -n vm.loadavg; "$@"; code=$?; sysctl -n vm.loadavg; exit "$code"`;
    const child = spawn('/bin/bash', ['-c', gate, 'w6-qa-gate', process.execPath, 'run', 'qa:electron', '--', '--case', scenario, '--evidence', evidence], {
      env: { ...process.env, FRETLINE_QA: '1', FRETLINE_QA_HEADLESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    child.stdout.on('data', (data: Buffer) => output.push(data.toString()));
    child.stderr.on('data', (data: Buffer) => output.push(data.toString()));
    const exitCode = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('close', done);
    });
    context.cleanup.push({ name: `QA runner ${scenario}`, pid: child.pid, exitCode, signal: child.signalCode, reaped: true });
    await writeFile(resolve(evidence, 'command.log'), output.join(''));
    rows.push({ case: scenario, exitCode, evidence });
    console.log(`CASE_END ${scenario} ${exitCode}`);
    const resultPath = resolve(evidence, 'result.json');
    const record: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
    if (scenario === 'harness-crash') {
      if (typeof record !== 'object' || record === null || !('status' in record) || record.status !== 'FAIL' ||
        !('failure' in record) || typeof record.failure !== 'object' || record.failure === null ||
        !('kind' in record.failure) || record.failure.kind !== 'crash' || exitCode !== exitCodes.crash) {
        throw new QaFailure('assertion', 'Deliberate renderer crash was not reported as a real crash');
      }
      context.expectedNegativeChildren.push('cases/harness-crash/result.json');
    } else if (typeof record !== 'object' || record === null || !('case' in record) || record.case !== scenario) {
      throw new QaFailure('assertion', `Enumerated case ${scenario} did not write its own result`);
    }
  }
  await writeFile(resolve(context.evidence, 'case-results.json'), JSON.stringify(rows, null, 2));
  await writeFile(resolve(context.evidence, 'case-results.md'),
    '| Case | Status | Evidence |\n| --- | --- | --- |\n' + rows.map(row =>
      `| ${row.case} | ${row.case === 'harness-crash' ? 'EXPECTED_FAIL (crash control)' :
        row.case === 'perf-stem-prep-cancel' ? `OPEN (exit ${row.exitCode ?? 'signal'})` : row.exitCode === 0 ? 'PASS' : 'FAIL'} | ${row.evidence}/result.json |`).join('\n') + '\n');
  context.assert(cases.length > 0 && rows.length === cases.length, 'Every discovered executable Electron case ran exactly once');
  context.assert(rows.every(row => row.case === 'harness-crash' ? row.exitCode === exitCodes.crash :
    row.case === 'perf-stem-prep-cancel' || row.exitCode === 0),
  'All product scenarios except the declared OPEN footprint case pass, and the deliberate renderer crash is detected');
};
