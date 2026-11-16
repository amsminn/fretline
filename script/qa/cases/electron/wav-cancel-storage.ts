import { expect } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { exportFixture, openAudio, readWave, savePicker } from './export-mixed-wav';

export const run: QaCase = async context => {
  const fixture = await exportFixture(context);
  await withImportApp(context, fixture, async surface => {
    const { page, application } = surface;
    await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
    await openAudio(surface);
    await savePicker(surface, null);
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'cancelled');
    const output = resolve(context.evidence, 'retained.wav');
    await writeFile(output, 'prior complete export');
    await savePicker(surface, output);
    await application.evaluate(() => {
      const fs = process.getBuiltinModule('node:fs');
      const { syncBuiltinESMExports } = process.getBuiltinModule('node:module');
      const original = fs.promises.open;
      fs.promises.open = async (...args: Parameters<typeof original>) => {
        const handle = await original(...args);
        if (args[1] === 'wx' && String(args[0]).endsWith('.tmp')) {
          fs.promises.open = original; syncBuiltinESMExports();
          let written = false;
          handle.write = new Proxy(handle.write, { apply(write, receiver, values) {
            if (written) return Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
            written = true; return Reflect.apply(write, receiver, values);
          } });
        }
        return handle;
      };
      syncBuiltinESMExports();
    });
    context.log('Inject ENOSPC after the header at the real temporary FileHandle.write seam; no IPC or render result is stubbed.');
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'failed', { timeout: 120000 });
    const diskFull = page.getByTestId('audio-export-result');
    await expect(diskFull).toContainText('디스크 공간이 부족합니다 (ENOSPC)');
    const diskFullText = (await diskFull.textContent()) ?? '';
    context.assert(!/ENOSPC:/.test(diskFullText) && !/Error invoking|StorageError|DESTINATION:/.test(diskFullText) && /[\uAC00-\uD7A3]/.test(diskFullText),
      `Disk-full reason is Korean with only the parenthesized code (${JSON.stringify(diskFullText)})`);
    context.assert(await readFile(output, 'utf8') === 'prior complete export', 'Disk full preserves the previous complete destination');
    context.assert((await readdir(context.evidence)).every(name => !name.endsWith('.tmp')), 'Disk full removes every partial stream');
    await page.screenshot({ path: resolve(context.evidence, 'disk-full.png') });
    const cancelled = resolve(context.evidence, 'cancelled.wav');
    await savePicker(surface, cancelled);
    await page.getByRole('checkbox', { name: '반주 포함 (혼합)', exact: true }).check();
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByRole('progressbar')).toBeVisible();
    // Wait for a real partial file so cancellation exercises active stream and audio cleanup.
    await expect.poll(async () => (await readdir(context.evidence)).some(name => name.startsWith('.cancelled.wav.'))).toBe(true);
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'cancelled', { timeout: 120000 });
    const names = await readdir(context.evidence);
    context.assert(!names.includes('cancelled.wav') && names.every(name => !name.endsWith('.tmp')),
      'Cancellation never publishes a destination and removes the partial stream');
    await page.screenshot({ path: resolve(context.evidence, 'cancelled.png') });
    const retry = resolve(context.evidence, 'retry.wav');
    await savePicker(surface, retry);
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'saved', { timeout: 120000 });
    context.assert((await readWave(retry)).frames === 768000, 'A fresh mixed export succeeds after cancellation with no stale audio or file capability');
    context.assert((await readdir(context.evidence)).every(name => !name.endsWith('.tmp')), 'Successful retry leaves no generated cache or partial files');
    await page.screenshot({ path: resolve(context.evidence, 'retry-saved.png') });
  });
};
