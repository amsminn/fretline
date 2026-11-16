import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../lib/process';
import type { QaCase } from '../../lib/contracts';

const violations = [
  { file: 'src/renderer/ui/Button.tsx', line: 1, insert: "const rawHex = '#3b82f6';", rule: 'raw color literal' },
  { file: 'src/renderer/specimen/Specimen.tsx', line: 1, insert: "export const arbitrary = 'bg-[#121212] text-[oklch(0.5_0.1_250)]';", rule: 'arbitrary Tailwind color' },
  { file: 'src/renderer/specimen/Specimen.tsx', line: 2, insert: "export const palette = 'bg-slate-900 text-blue-500';", rule: 'Tailwind palette color' },
  { file: 'src/renderer/main.tsx', line: 1, insert: "import { Dialog } from 'radix-ui';", rule: 'radix-ui import outside' },
] as const;

export const run: QaCase = async context => {
  const clean = await runProcess(context, ['bun', 'script/qa/token-lint.ts']);
  await writeFile(resolve(context.evidence, 'lint-clean.log'), clean.stdout + clean.stderr);
  context.assert(clean.exitCode === 0, 'lint:tokens passes on the real tree');

  const copy = await mkdtemp(join(tmpdir(), 'fretline-token-lint-'));
  try {
    await mkdir(join(copy, 'src'), { recursive: true });
    await cp(resolve('src'), join(copy, 'src'), { recursive: true });
    for (const violation of violations) {
      const path = join(copy, violation.file);
      const lines = (await readFile(path, 'utf8')).split('\n');
      lines.splice(violation.line - 1, 0, violation.insert);
      await writeFile(path, lines.join('\n'));
    }
    const dirty = await runProcess(context, ['bun', 'script/qa/token-lint.ts', '--root', copy]);
    await writeFile(resolve(context.evidence, 'lint-dirty.log'), dirty.stdout + dirty.stderr);
    context.assert(dirty.exitCode === 1, 'lint:tokens fails on the mutated copy with exit 1');
    for (const violation of violations) {
      const expected = `${violation.file}:${violation.line}: ${violation.rule}`;
      context.assert(dirty.stderr.includes(expected), `Reports ${expected}`);
    }
    const lineReports = dirty.stderr.split('\n').filter(line => /^src\/.+:\d+: /.test(line));
    context.assert(lineReports.length === violations.length + 1, `Reports exactly the injected findings (${lineReports.length} lines; the arbitrary line also trips the raw-color rule)`);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
};
