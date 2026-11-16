import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFile } from '../../src/main/open';

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {} }));
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
it.each(['musicxml', 'xml', 'mxl', 'mid', 'midi'])('opens selected .%s as exact source bytes without granting a document', async extension => {
  const directory = await mkdtemp(join(tmpdir(), 'interchange-open-')); directories.push(directory);
  const path = join(directory, `study.${extension}`);
  const bytes = await readFile('tests/fixtures/musicxml/voices-ties.musicxml');
  await writeFile(path, bytes);
  const result = await openFile(path, () => { throw new TypeError('Source must pass through import worker first'); });
  expect(result).toEqual({ kind: 'source', name: `study.${extension}`, bytes: new Uint8Array(bytes) });
});
