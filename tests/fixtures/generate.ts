import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { generateFixture } from './domain/generate';
import { generateWav } from './audio/generate';

const root = new URL('./', import.meta.url);
const commit = '9f1aa10460df1b326123d28a2222f7b20d081e61';
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const paths: { readonly id: string; readonly path: string; readonly expected: string; readonly source: object }[] = [];
for (const name of ['loop-eight-bars', 'seven-four', 'pickup-6-8', 'alternate-endings', 'ds-al-coda', 'unison-strings', 'perf']) {
  const path = `domain/${name}.json`;
  await writeFile(new URL(path, root), `${JSON.stringify(generateFixture(name), null, 2)}\n`);
  paths.push({ id: name, path, expected: `domain/${name}.expected.json`, source: { license: 'CC0-1.0', generator: 'domain/generate.ts' } });
}
for (const kind of ['impulse', 'distinct-frequency', 'backing-quarter'] as const) {
  const path = `audio/${kind}.wav`;
  await writeFile(new URL(path, root), generateWav(kind));
  paths.push({ id: kind, path, expected: `audio/${kind}.expected.json`, source: { license: 'CC0-1.0', generator: 'audio/generate.ts' } });
}
const validZip = zipSync({ 'score.json': strToU8('{}') });
const archives = {
  truncated: validZip.slice(0, -12),
  traversal: zipSync({ '../escape.txt': strToU8('rejected input') }),
  duplicate: zipSync({ 'score.json': strToU8('{}'), './score.json': strToU8('{}') }),
};
for (const [name, bytes] of Object.entries(archives)) {
  const path = `archives/${name}.zip`;
  await writeFile(new URL(path, root), bytes);
  paths.push({ id: name, path, expected: `archives/${name}.expected.json`, source: { license: 'CC0-1.0', generator: 'generate.ts' } });
}
for (const version of [3, 4, 5, 6, 7, 8]) {
  const ext = version === 6 ? 'gpx' : version >= 7 ? 'gp' : `gp${version}`;
  paths.push({ id: `gp${version}`, path: `gp/gp${version}.${ext}`, expected: `gp/gp${version}.expected.json`,
    source: { repository: 'CoderLine/alphaTab', commit, license: 'MPL-2.0', licenseFile: 'gp/LICENSE.MPL-2.0',
      path: `packages/alphatab/test-data/guitarpro${version}/${version === 8 ? 'beat-tempo-change' : 'score-info'}.${ext}` } });
  if (version < 8) {
    paths.push({ id: `gp${version}-notes`, path: `gp/gp${version}-notes.${ext}`, expected: `gp/gp${version}-notes.expected.json`,
      source: { repository: 'CoderLine/alphaTab', commit, license: 'MPL-2.0', licenseFile: 'gp/LICENSE.MPL-2.0',
        path: `packages/alphatab/test-data/guitarpro${version}/notes.${ext}` } });
  }
}
const fixtures = await Promise.all(paths.map(async entry => ({
  ...entry,
  sha256: hash(await readFile(new URL(entry.path, root))),
  expectedSha256: hash(await readFile(new URL(entry.expected, root))),
})));
await writeFile(new URL('manifest.json', root), `${JSON.stringify({ schemaVersion: 1, fixtures }, null, 2)}\n`);
console.log(`Generated ${fixtures.length} fixtures at ${fileURLToPath(root)}; authored expected JSON untouched`);
