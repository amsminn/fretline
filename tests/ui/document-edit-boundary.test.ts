import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

it('keeps renderer score publication and history execution inside the document edit service', async () => {
  // Architecture invariant: this explicit boundary prevents independent writers
  // from bypassing transactional history and the shared edit queue.
  const allowed = {
    updateProject: ['src/renderer/state/document-edits.ts', 'src/renderer/state/documents.ts'],
    createHistory: ['src/renderer/state/document-edits.ts'],
    executeCommand: ['src/renderer/state/document-edits.ts'],
  } as const;
  const files = await readdir('src/renderer', { recursive: true });
  const violations: string[] = [];
  for (const entry of files.filter(file => /\.tsx?$/.test(file))) {
    const file = relative('.', join('src/renderer', entry));
    const source = await readFile(file, 'utf8');
    for (const [name, owners] of Object.entries(allowed)) {
      const permitted: readonly string[] = owners;
      if (new RegExp(`\\b${name}\\s*\\(`).test(source) && !permitted.includes(file)) violations.push(`${file}: ${name}`);
    }
  }
  expect(violations).toEqual([]);
});
