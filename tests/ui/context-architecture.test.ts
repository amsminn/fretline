import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

// Architecture invariant: production callers must never override live context with editing.
const allowlist = new Set(['commands/context-store.ts', 'commands/registry.ts']);
async function sources(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : Promise.resolve(/\.[cm]?[jt]sx?$/.test(path) ? [path] : []);
  }))).flat();
}

it('prevents renderer command callers from bypassing the shared context store', async () => {
  const root = 'src/renderer';
  const violations: string[] = [];
  for (const path of await sources(root)) {
    if (allowlist.has(relative(root, path))) continue;
    const text = await readFile(path, 'utf8');
    if (/\bcontext\s*:\s*['"]editing['"]|\.execute\s*\([^;]*?,\s*['"]editing['"]\s*\)/s.test(text)) violations.push(path);
  }
  expect(violations).toEqual([]);
});
