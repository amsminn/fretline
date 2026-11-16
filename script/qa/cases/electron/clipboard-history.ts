import { expect } from '@playwright/test';
import { commandDefinitions } from '../../../../src/renderer/commands/catalog';
import type { QaCase } from '../../lib/contracts';
import { atQuarter, withCoverageScore } from './coverage-support';
import { readEditing, waitForFret } from './editing-support';
import { contentHash, ready } from './journey-support';

export const run: QaCase = context => withCoverageScore(context, async ({ page }) => {
  const source = await atQuarter(page, 0);
  await page.keyboard.press('9'); await waitForFret(page, source, 9);
  // Paste consumes silence by contract; prepare two real rest destinations through R.
  for (const quarter of [1, 2]) {
    const id = await atQuarter(page, quarter);
    await page.keyboard.press('r');
    await expect.poll(async () => (await readEditing(page)).events[id]?.kind).toBe('rest');
  }
  const hash = await contentHash(page);
  await atQuarter(page, 0);
  await page.keyboard.press('Meta+c');
  await expect.poll(async () => (await readEditing(page)).hasClipboard).toBe(true);
  context.assert(await contentHash(page) === hash, 'Cmd+C fills the musical clipboard without changing the score');
  await atQuarter(page, 1);
  const depth = (await readEditing(page)).past;
  await page.keyboard.press('Meta+v');
  await expect.poll(async () => (await readEditing(page)).past).toBe(depth + 1);
  const target = await atQuarter(page, 1);
  context.assert((await readEditing(page)).events[target]?.notes.some(([, fret]) => fret === 9) === true,
    'Cmd+V creates the copied fret at the destination with fresh event identity');
  const pasted = await contentHash(page);
  await page.keyboard.press('Meta+z');
  await expect.poll(() => contentHash(page)).toBe(hash);
  await page.keyboard.press('Shift+Meta+z');
  await expect.poll(() => contentHash(page)).toBe(pasted);
  await atQuarter(page, 1); await page.keyboard.press('Meta+x');
  await expect.poll(async () => (await readEditing(page)).events[target]?.kind).toBe('rest');
  await page.keyboard.press('Meta+z'); await expect.poll(() => contentHash(page)).toBe(pasted);
  await atQuarter(page, 2); await page.keyboard.press('Shift+Meta+v');
  await expect(page.getByRole('dialog')).toContainText('특수 붙여넣기');
  await page.screenshot({ path: `${context.evidence}/special-paste.png` });
  await page.getByRole('button', { name: '적용', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await ready(page);
  const specialTarget = await atQuarter(page, 2);
  context.assert(await contentHash(page) !== pasted &&
    (await readEditing(page)).events[specialTarget]?.notes.some(([, fret]) => fret === 9) === true,
    'Cmd+V, Cmd+X, undo, redo and confirmed special paste change and restore actual score content');
  for (const [id, key] of [['edit.copy', 'Ctrl+c'], ['edit.cut', 'Ctrl+x'], ['edit.paste', 'Ctrl+v'],
    ['edit.undo', 'Ctrl+z'], ['edit.redo', 'Ctrl+y'], ['edit.specialPaste', 'Ctrl+Shift+v']] as const) {
    context.assert(commandDefinitions.find(command => command.id === id)?.keys.windows.includes(key) === true,
      `Windows keymap DATA check: ${id} binds ${key}; no Windows runtime execution is claimed`);
  }
});
