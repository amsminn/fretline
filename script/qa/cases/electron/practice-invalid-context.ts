import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { NativeInput } from '../../lib/native';
import { withImportApp } from './import-support';
import { sha256 } from '../../artifacts';
import { practiceInput } from './practice-support';

export async function practiceInvalidContext(context: QaContext, native?: NativeInput): Promise<void> {
  const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
  context.versions['practiceFixtureSha256'] = sha256(await readFile(fixture));
  await withImportApp(context, fixture, async surface => {
    const input = await practiceInput(context, surface, native);
    const { page } = input;
    const before = await page.evaluate(() => window.fretlineEditingObservation?.());
    context.assert(before !== undefined, 'Production editing observation is available for independent note/history comparison');
    await input.open();
    for (const value of ['0', 'NaN', '301']) {
      await input.fill('상대 속도', value); await input.apply();
      await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
      await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', '100');
      context.assert(true, `Invalid relative speed ${value} is rejected without changing practice state`);
    }
    await input.fill('상대 속도', '50');
    await input.click(page.getByRole('checkbox', { name: '속도 훈련', exact: true }));
    await input.fill('훈련 시작', '70'); await input.fill('훈련 끝', '50'); await input.apply();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('시작');
    context.assert(true, 'Reversed trainer bounds are rejected atomically');
    await input.fill('훈련 시작', '50'); await input.fill('훈련 끝', '70'); await input.fill('훈련 반복 횟수', '0'); await input.apply();
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await input.fill('훈련 반복 횟수', '2'); await input.fill('훈련 증가', '0'); await input.apply();
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    context.assert(true, 'Zero loop count and zero increment are rejected');
    await input.click(page.getByRole('textbox', { name: '상대 속도', exact: true }));
    for (const key of ['=', '-', 'b', 'Space', 'Meta+a', 'x']) await input.key(key);
    const after = await page.evaluate(() => window.fretlineEditingObservation?.());
    context.assert(JSON.stringify(after) === JSON.stringify(before), 'Focused practice text never changes notes, selection, history, or content token');
    context.assert(await page.getByTestId('document-tab').getAttribute('data-dirty') === 'false', 'Invalid input and score shortcuts leave dirty state clean');
    await input.shot('invalid-context.png');
    await input.key('Escape');
    await input.key('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await input.open(); await input.fixed();
    await input.fill('고정 BPM', '401'); await input.apply();
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await input.fill('고정 BPM', '10.5'); await input.apply();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', '10.5');
    context.assert(true, 'Fixed BPM rejects 401 and accepts decimal 10.5');
    context.assert(await page.getByTestId('document-tab').getAttribute('data-dirty') === 'false',
      'Changing fixed tempo while playing leaves the score clean');
    await input.click(page.locator('[data-command="sound.stop"]').first());
    await writeFile(resolve(context.evidence, 'context-observations.json'), JSON.stringify({ before, after }, null, 2));
  });
}
export const run: QaCase = context => practiceInvalidContext(context);
