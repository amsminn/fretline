import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

export type Finding = { readonly file: string; readonly line: number; readonly rule: Rule; readonly excerpt: string };
export type Rule = 'raw-color' | 'arbitrary-tailwind-color' | 'tailwind-palette-color' | 'radix-outside-ui';

const sourceExtensions = ['.ts', '.tsx', '.css', '.html'];
const allowedColorFile = 'src/renderer/styles/tokens.css';
const uiDirectory = 'src/renderer/ui';
const rawColor = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/;
const arbitraryColor = /\b(?:bg|text|border|fill|stroke|ring|outline|shadow|accent|caret|decoration|divide|from|via|to)-\[(?:#|rgb|hsl|oklch|oklab|color\()/;
const paletteColor = /\b(?:bg|text|border|fill|stroke|ring|outline|accent|caret|decoration|divide|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-\d{2,3})?(?:\/\d+)?\b/;
const radixImport = /from\s+['"](?:radix-ui|@radix-ui\/)|import\(\s*['"](?:radix-ui|@radix-ui\/)/;

const normalized = (path: string): string => path.split(sep).join('/');

async function collect(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (sourceExtensions.some(extension => entry.name.endsWith(extension))) files.push(path);
  }
  return files;
}

export function lintSource(file: string, source: string): readonly Finding[] {
  const findings: Finding[] = [];
  const isTokenFile = file === allowedColorFile;
  const isUi = file.startsWith(`${uiDirectory}/`);
  source.split('\n').forEach((text, index) => {
    const line = index + 1;
    const excerpt = text.trim();
    if (!isTokenFile && rawColor.test(text)) findings.push({ file, line, rule: 'raw-color', excerpt });
    if (arbitraryColor.test(text)) findings.push({ file, line, rule: 'arbitrary-tailwind-color', excerpt });
    if (!isTokenFile && paletteColor.test(text)) findings.push({ file, line, rule: 'tailwind-palette-color', excerpt });
    if (!isUi && radixImport.test(text)) findings.push({ file, line, rule: 'radix-outside-ui', excerpt });
  });
  return findings;
}

export async function lintTree(root: string): Promise<readonly Finding[]> {
  const sourceRoot = resolve(root, 'src');
  const files = await collect(sourceRoot);
  const findings: Finding[] = [];
  for (const path of files) {
    const file = normalized(relative(root, path));
    findings.push(...lintSource(file, await readFile(path, 'utf8')));
  }
  return findings;
}

const messages: Readonly<Record<Rule, string>> = {
  'raw-color': `raw color literal outside ${allowedColorFile}`,
  'arbitrary-tailwind-color': 'arbitrary Tailwind color value; use a semantic token utility',
  'tailwind-palette-color': 'Tailwind palette color; use a semantic token utility',
  'radix-outside-ui': `radix-ui import outside ${uiDirectory}/`,
};

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter(value => value !== '--'), strict: true, options: { root: { type: 'string' } } });
  const root = resolve(values.root ?? '.');
  const findings = await lintTree(root);
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${messages[finding.rule]}\n    ${finding.excerpt}`);
  console.log(findings.length === 0 ? `lint:tokens OK (${normalized(relative(process.cwd(), root) || '.')})` : `lint:tokens FAILED with ${findings.length} finding(s)`);
  process.exitCode = findings.length === 0 ? 0 : 1;
}
