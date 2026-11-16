import { expect } from '@playwright/test';
import { copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { sha256 } from '../../artifacts';
import { readProjectFile } from '../../../../src/main/projects';
import { hashDocument } from '../../../../src/domain/content-hash';
import { readEditing } from './editing-support';
import { chooseThroughOpen } from './import-support';
import { clickBeat, commitStep, contentHash, hitsOf, ready, shot, withJourney } from './journey-support';

export const run: QaCase = context => withJourney(context, async surface => {
  const { page, application } = surface;
  const destination = resolve(context.evidence, 'recovery.fretline');
  await copyFile(resolve('tests/fixtures/projects/seven-four.fretline'), destination);
  const originalBytes = sha256(await readFile(destination));
  await chooseThroughOpen(context, surface, destination);
  await ready(page);
  const first = (await hitsOf(page))[0];
  context.assert(first !== undefined, 'Production open renders the partial-tuplet fixture');
  if (!first) return;
  await clickBeat(page, first.eventId);
  const before = await readEditing(page);
  const beforeHash = await contentHash(page);
  context.log('Stage partial tuplet rejection: src/renderer/state/document-edits.ts; src/domain/clipboard.ts');
  await page.keyboard.press('Meta+c');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect.poll(async () => (await readEditing(page)).rejection?.some(d => /tuplet/i.test(d.message))).toBe(true);
  context.assert(await contentHash(page) === beforeHash && (await readEditing(page)).past === before.past &&
    (await readEditing(page)).future === before.future, 'Partial tuplet rejection shows a visible message and preserves content and both history stacks');
  await shot(context, page, 'partial-tuplet-rejected');
  // Dismiss the rejection through the score, then make a valid change in the same document.
  await clickBeat(page, first.eventId);
  const editedHash = await commitStep(page, () => page.keyboard.press('9'));
  await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'true');
  await shot(context, page, 'edited-before-save');
  context.log('Stage EACCES: src/main/projects/atomic-write.ts (temporary FileHandle.writeFile fault seam)');
  await application.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs');
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module');
    const original = fs.promises.open;
    fs.promises.open = async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (args[1] === 'wx' && String(args[0]).endsWith('.tmp')) {
        fs.promises.open = original;
        syncBuiltinESMExports();
        handle.writeFile = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
      }
      return handle;
    };
    syncBuiltinESMExports();
  });
  await page.keyboard.press('Meta+s');
  await expect(page.getByRole('alert')).toContainText('EACCES');
  await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'true');
  context.assert(await contentHash(page) === editedHash && (await readEditing(page)).past === before.past + 1 &&
    sha256(await readFile(destination)) === originalBytes, 'Failed atomic save preserves edited document, history, dirty dot, and original destination bytes');
  await shot(context, page, 'save-eacces');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await page.keyboard.press('Meta+s');
  await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'false');
  const saved = await readProjectFile(destination);
  context.assert(saved.kind === 'editable' && (await hashDocument(saved.parts.project.score)).sha256 === editedHash,
    'Subsequent production Save succeeds with exactly the retained edited document');
  context.assert(sha256(await readFile(`${destination}.previous`)) === originalBytes, 'Successful retry retains the previous complete generation');
  await shot(context, page, 'save-recovered');
});
