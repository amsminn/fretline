import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import metadata from '../../../package.json';
import { writeResult } from '../artifacts';
import { QaFailure, exitCodes, failureStatus } from './contracts';
import type { QaCase, QaContext } from './contracts';
import { closeElectronApplications } from './electron';

function isCase(value: unknown): value is { readonly run: QaCase } {
  return typeof value === 'object' && value !== null && 'run' in value && typeof value.run === 'function';
}
export async function main(runner: 'domain' | 'electron' | 'native'): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter(value => value !== '--'), strict: true,
    options: { case: { type: 'string' }, evidence: { type: 'string' }, app: { type: 'string' } },
  });
  if (!values.evidence) throw new QaFailure('infrastructure', '--evidence is required');
  const evidence = resolve(values.evidence);
  await mkdir(evidence, { recursive: true });
  const context: QaContext = {
    evidence, app: values.app, actions: [], assertions: [], cleanup: [], expectedNegativeChildren: [],
    versions: { ...Object.fromEntries(Object.entries(process.versions).filter((pair): pair is [string, string] => typeof pair[1] === 'string')),
      alphatab: metadata.dependencies['@coderline/alphatab'], playwright: metadata.devDependencies['@playwright/test'],
      electronPackage: metadata.devDependencies.electron, typescript: metadata.devDependencies.typescript },
    log(message) { this.actions.push(`${new Date().toISOString()} ${message}`); },
    assert(condition, name) {
      this.assertions.push({ name, passed: condition });
      this.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
      if (!condition) throw new QaFailure('assertion', name);
    },
  };
  let failure: QaFailure | undefined;
  const scenario = values.case ?? '';
  process.env['FRETLINE_QA_PARENT_PID'] = String(process.pid);
  let interruption: Promise<void> | undefined;
  const interrupt = (signal: NodeJS.Signals): void => {
    interruption ??= (async () => {
      const interrupted = new QaFailure('infrastructure', `runner interrupted by ${signal}`);
      context.log(`${interrupted.kind}: ${interrupted.message}`);
      try {
        await closeElectronApplications();
      } finally {
        await writeResult(context, scenario, interrupted,
          { runner, headless: runner === 'electron' && process.env['FRETLINE_QA_HEADLESS'] !== '0' });
        process.exit(2);
      }
    })();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.on(signal, interrupt);
  try {
    const directory = resolve('script/qa/cases', runner);
    const files = await readdir(directory);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(scenario) || !files.includes(`${scenario}.ts`)) {
      throw new QaFailure('unknownCase', `Unknown ${runner} case: ${scenario}`);
    }
    const module: unknown = await import(pathToFileURL(resolve(directory, `${scenario}.ts`)).href);
    if (!isCase(module)) throw new QaFailure('infrastructure', `Case ${scenario} must export run(context)`);
    await module.run(context);
    context.assert(context.assertions.length > 0, 'Case executed assertions');
    context.assert(context.cleanup.every(receipt => receipt.reaped), 'All started children reaped');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const expectation = error.name === 'AssertionError' || error.name === 'ExpectError' ||
      error.name === 'JestAssertionError' ||
      ('matcherResult' in error && error.matcherResult !== null && typeof error.matcherResult === 'object');
    failure = error instanceof QaFailure ? error
      : new QaFailure(expectation ? 'assertion' : 'infrastructure', error.stack ?? error.message);
    if (!(error instanceof QaFailure) && expectation) {
      context.assertions.push({ name: error.message, passed: false });
      context.log(`FAIL ${error.message}`);
    }
    context.log(`${failure.kind}: ${failure.message}`);
  }
  if (interruption) {
    await interruption;
    return;
  }
  await writeResult(context, scenario, failure,
    { runner, headless: runner === 'electron' && process.env['FRETLINE_QA_HEADLESS'] !== '0' });
  for (const signal of signals) process.off(signal, interrupt);
  console.log(`${failureStatus(failure)} ${runner}/${scenario}`);
  process.exitCode = failure ? exitCodes[failure.kind] : 0;
}
