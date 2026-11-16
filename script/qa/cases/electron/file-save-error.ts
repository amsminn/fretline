import { expect } from '@playwright/test';
import { copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { ready, rhythmInput, selectFirst } from './complex-rhythm-edit';
import { sha256 } from '../../../../src/main/projects';

export const run: QaCase = async context => {
  const destination = resolve(context.evidence, 'retained.fretline');
  await copyFile(resolve('tests/fixtures/projects/loop-eight-bars.fretline'), destination);
  const before = sha256(await readFile(destination));
  await withImportApp(context, destination, async surface => {
    const { page, application } = surface;
    await ready(surface);
    await selectFirst(surface, rhythmInput(surface));
    await page.keyboard.press('9');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    for (const code of ['EACCES', 'ENOSPC'] as const) {
      await application.evaluate((_electron, failureCode) => {
        const fs = process.getBuiltinModule('node:fs');
        const { syncBuiltinESMExports } = process.getBuiltinModule('node:module');
        const original = fs.promises.open;
        fs.promises.open = async (...args: Parameters<typeof original>) => {
          const handle = await original(...args);
          if (args[1] === 'wx' && String(args[0]).endsWith('.tmp')) {
            // Task 6's fault seam: fail the temporary package write, not the save IPC.
            fs.promises.open = original;
            syncBuiltinESMExports();
            handle.writeFile = async () => { throw Object.assign(new Error(failureCode), { code: failureCode }); };
          }
          return handle;
        };
        syncBuiltinESMExports();
      }, code);
      context.log(`Inject ${code} at task 6 temporary FileHandle.writeFile seam, then use Cmd+S`);
      await page.keyboard.press('Meta+s');
      await expect(page.getByRole('alert')).toContainText(code);
      await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
      context.assert(sha256(await readFile(destination)) === before, `${code}: original destination bytes remain intact and the editor stays dirty`);
      await page.screenshot({ path: resolve(context.evidence, `${code}.png`) });
      await page.getByRole('button', { name: '확인', exact: true }).click();
    }
    await page.keyboard.press('Meta+s');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
    context.assert(sha256(await readFile(destination)) !== before, 'A subsequent real save succeeds after faults are removed');
    context.assert(sha256(await readFile(`${destination}.previous`)) === before, 'Successful retry retains the previous complete generation');
  });
};
