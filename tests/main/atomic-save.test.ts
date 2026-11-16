import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { atomicReplace } from '../../src/main/atomic-save';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }));
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'atomic-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it('replaces complete bytes and keeps the previous complete generation', async () => {
  const path = join(root, 'score.fretline');
  await fs.writeFile(path, 'old');
  await atomicReplace(path, Buffer.from('new'), async bytes => { expect(bytes.toString()).toBe('new'); });
  expect(await fs.readFile(path, 'utf8')).toBe('new');
  expect(await fs.readFile(`${path}.previous`, 'utf8')).toBe('old');
});
it('preserves the destination and refuses acknowledgement on disk full', async () => {
  const path = join(root, 'score.fretline');
  await fs.writeFile(path, 'old');
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx') vi.spyOn(handle, 'writeFile').mockRejectedValue(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
    return handle;
  });
  await expect(atomicReplace(path, Buffer.from('new'), async () => {})).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(await fs.readFile(path, 'utf8')).toBe('old');
  expect(await fs.readdir(root)).toEqual(['score.fretline']);
});
it('rejects invalid temporary contents without replacing the destination', async () => {
  const path = join(root, 'score.fretline');
  await fs.writeFile(path, 'old');
  await expect(atomicReplace(path, Buffer.from('bad'), async () => { throw new TypeError('invalid'); })).rejects.toThrow('invalid');
  expect(await fs.readFile(path, 'utf8')).toBe('old');
});
it('serializes overlapping writes to the same destination', async () => {
  const path = join(root, 'score.fretline');
  await Promise.all(['a', 'b', 'c'].map(value => atomicReplace(path, Buffer.from(value), async () => {})));
  expect(await fs.readFile(path, 'utf8')).toBe('c');
  expect(await fs.readFile(`${path}.previous`, 'utf8')).toBe('b');
});
it('captures bytes before asynchronous destination resolution', async () => {
  const path = join(root, 'snapshot.fretline');
  const bytes = Buffer.from('captured');
  const saving = atomicReplace(path, bytes, async () => {});
  bytes.fill(0);
  await saving;
  expect(await fs.readFile(path, 'utf8')).toBe('captured');
});
