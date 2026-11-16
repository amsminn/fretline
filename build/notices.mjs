import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Builder hook: collect the actual installed dependency closure, never a hand-maintained license list. */
export default async function notices() {
  const destination = join(root, 'build/notices');
  await mkdir(destination, { recursive: true });
  const seen = new Set();
  const index = [];
  async function collect(directory, includeDependencies = true) {
    const canonical = await realpath(directory);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const manifest = JSON.parse(await readFile(join(canonical, 'package.json'), 'utf8'));
    const name = `${manifest.name.replaceAll('/', '__')}-${manifest.version}`;
    const output = join(destination, name);
    await mkdir(output, { recursive: true });
    const licenses = (await readdir(canonical)).filter(file => /^(licen[sc]e|copying|notice|copyright)([.-]|$)/i.test(file));
    for (const file of licenses) await copyFile(join(canonical, file), join(output, file));
    if (manifest.name === 'signalsmith-stretch') {
      await copyFile(join(root, 'build/Signalsmith-LICENSE.txt'), join(output, 'LICENSE.txt'));
      licenses.push('LICENSE.txt');
    }
    if (manifest.name === '@nodable/entities') {
      await copyFile(join(root, 'build/Nodable-LICENSE.txt'), join(output, 'LICENSE.txt'));
      licenses.push('LICENSE.txt');
    }
    if (manifest.name === 'react-remove-scroll-bar') {
      await copyFile(join(root, 'build/ReactRemoveScrollBar-LICENSE.txt'), join(output, 'LICENSE.txt'));
      licenses.push('LICENSE.txt');
    }
    if (licenses.length === 0) throw new Error(`Missing redistribution license: ${name}`);
    index.push({ name: manifest.name, version: manifest.version, license: manifest.license,
      source: manifest.repository ?? manifest.homepage ?? `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`,
      files: licenses.map(file => `${name}/${file}`) });
    if (!includeDependencies) return;
    const require = createRequire(join(canonical, 'package.json'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      let found = false;
      for (const search of require.resolve.paths(dependency) ?? []) {
        const directory = join(search, dependency);
        try {
          const candidate = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
          if (candidate.name === dependency) {
            await collect(directory);
            found = true;
            break;
          }
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        }
      }
      if (!found) throw new Error(`Cannot locate dependency ${dependency}`);
    }
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies)) await collect(join(root, 'node_modules', dependency));
  // These build tools emit runtime code/CSS even though their Node implementations do not ship.
  for (const dependency of ['tailwindcss', 'vite']) await collect(join(root, 'node_modules', dependency), false);
  for (const [source, target] of [
    ['@coderline/alphatab/dist/font/Bravura-OFL.txt', 'Bravura-OFL.txt'],
    ['@coderline/alphatab/dist/soundfont/LICENSE', 'Sonivox-NOTICE.txt'],
    ['electron/dist/LICENSE', 'Electron-LICENSE.txt'],
    ['electron/dist/LICENSES.chromium.html', 'Chromium-LICENSES.html'],
  ]) await copyFile(join(root, 'node_modules', source), join(destination, target));
  // The full Apache text accompanies the Sonivox copyright/notice.
  await copyFile(join(root, 'build/Apache-2.0.txt'), join(destination, 'Apache-2.0.txt'));
  await copyFile(join(root, 'build/TinySoundFont-SFZero-LICENSE.txt'), join(destination, 'TinySoundFont-SFZero-LICENSE.txt'));
  await writeFile(join(destination, 'index.json'), JSON.stringify(index.sort((a, b) => a.name.localeCompare(b.name)), null, 2));
}
