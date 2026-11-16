import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QaCase } from '../../lib/contracts';
import { runProcess } from '../../lib/process';
import { fixtureDocument, fixtureId } from '../../../../tests/domain/fixtures';
import { readProjectFile, saveProjectFile, projectHash, sha256 } from '../../../../src/main/projects';
import type { PackageParts } from '../../../../src/domain/project';

export const run: QaCase = async context => {
  const bundled = join(context.evidence, 'storage.mjs');
  const build = await runProcess(context, [process.execPath, 'build', 'src/main/projects.ts', '--target=node', `--outfile=${bundled}`]);
  context.assert(build.exitCode === 0, 'Production storage code bundles for Electron Node fault subprocess');
  const version = await runProcess(context, ['node', '--version']);
  context.versions['faultNode'] = version.stdout.trim();
  const child = join(context.evidence, 'fault-child.mjs');
  await writeFile(child, `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const [stage, destination, input] = process.argv.slice(2);
function crash() { fs.writeSync(1, 'FAULT ' + stage + '\\\\n'); process.kill(process.pid, 'SIGKILL'); }
const originalOpen = fs.promises.open;
fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (args[1] === 'wx' && String(args[0]).endsWith('.tmp')) {
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...values) => { await write(...values); if (stage === 'after-write') crash(); };
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { await sync(); if (stage === 'after-fsync') crash(); };
  }
  return handle;
};
const originalRename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  if (to === destination && stage === 'before-replace') crash();
  await originalRename(from, to);
  if (to === destination && stage === 'after-replace') crash();
};
syncBuiltinESMExports();
const { saveProjectFile } = await import(${JSON.stringify(pathToFileURL(resolve(bundled)).href)});
await saveProjectFile(destination, JSON.parse(fs.readFileSync(input, 'utf8')), 2);
throw new Error('Fault injection did not execute');
`);
  const original: PackageParts = { project: { schemaVersion: 1, projectId: fixtureId('project', 'interrupted'),
    score: fixtureDocument('pickup-6-8'), assets: [], source: null, preservation: [] }, blobs: [] };
  const next: PackageParts = { ...original, project: { ...original.project, score: { ...original.project.score,
    metadata: { ...original.project.score.metadata, title: 'Complete replacement' } } } };
  const input = join(context.evidence, 'replacement.json');
  await writeFile(input, JSON.stringify(next));
  const outcomes: Record<string, unknown> = {};
  for (const stage of ['after-write', 'after-fsync', 'before-replace', 'after-replace']) {
    const directory = await mkdtemp(join(context.evidence, `${stage}-`));
    const path = join(directory, 'score.fretline');
    await saveProjectFile(path, original, 1);
    const result = await runProcess(context, ['node', child, stage, path, input]);
    context.assert(result.signal === 'SIGKILL' && result.stdout.includes(`FAULT ${stage}`), `${stage}: child reached fault point and was killed`);
    const reopened = await readProjectFile(path);
    context.assert(reopened.kind === 'editable', `${stage}: destination is a complete checksummed archive`);
    if (reopened.kind !== 'editable') return;
    const expected = stage === 'after-replace' ? projectHash(next.project) : projectHash(original.project);
    context.assert(reopened.receipt.contentHash === expected, `${stage}: only the expected whole old or new state survives`);
    if (stage === 'before-replace' || stage === 'after-replace') {
      const previous = await readProjectFile(`${path}.previous`);
      context.assert(previous.kind === 'editable' && previous.receipt.contentHash === projectHash(original.project), `${stage}: previous complete generation survives`);
    }
    outcomes[stage] = { path, result, receipt: reopened.receipt, archiveSha256: sha256(await readFile(path)) };
  }
  await writeFile(join(context.evidence, 'fault-outcomes.json'), JSON.stringify(outcomes, null, 2));
};
