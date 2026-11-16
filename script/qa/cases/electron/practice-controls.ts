import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { NativeInput } from '../../lib/native';
import { withImportApp } from './import-support';
import { sha256 } from '../../artifacts';
import { waitAudio } from './playback-support';
import { inspectPracticeAudio, practiceInput } from './practice-support';

export async function practiceControls(context: QaContext, native?: NativeInput): Promise<void> {
  const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
  context.versions['practiceFixtureSha256'] = sha256(await readFile(fixture));
  await withImportApp(context, fixture, async surface => {
    const input = await practiceInput(context, surface, native);
    const { page } = input;
    await input.drag(5, 10); await input.assertRange(5, 11);
    await input.open();
    await input.fill('상대 속도', '50');
    await input.click(page.getByRole('checkbox', { name: '속도 훈련', exact: true }));
    await input.fill('훈련 시작', '50'); await input.fill('훈련 끝', '70');
    await input.fill('훈련 증가', '10'); await input.fill('훈련 반복 횟수', '2');
    for (const name of ['소리 메트로놈', '시각 메트로놈', '카운트인']) await input.click(page.getByRole('checkbox', { name, exact: true }));
    await input.shot('practice-settings-dark-1440.png');
    await input.apply(); await expect(page.getByRole('dialog')).toBeHidden();
    await input.key('F9');
    await input.key('Space');
    await expect(page.getByTestId('practice-status')).toHaveAttribute('data-counting', 'true');
    await input.shot('count-in.png');
    await page.waitForFunction(() => (window.fretlinePracticeObservation?.().state.beat ?? 0) > 0);
    context.assert(true, 'Visual beat indicator advances from the shared audio clock');
    await page.waitForFunction(() => (window.fretlinePracticeObservation?.().state.completed ?? 0) >= 4, undefined, { timeout: 40_000 });
    await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', '70');
    await input.shot('trainer-70.png');
    await input.key('=');
    await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', '75');
    await waitAudio(page, 0.8);
    await input.key('-');
    await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', '70');
    await waitAudio(page, 0.8);
    context.assert(true, 'During playback +/- changes relative speed by exactly 5%');
    await input.open(); await input.fixed();
    await input.click(page.getByRole('checkbox', { name: '속도 훈련', exact: true }));
    await input.fill('고정 BPM', '123.45'); await input.apply();
    await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', '123.45');
    await input.key('='); await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', '128.45');
    await input.key('-'); await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', '123.45');
    await waitAudio(page, 6.4);
    context.assert(true, 'Fixed decimal BPM supports live +/-5 BPM without changing the document');
    await input.click(page.locator('[data-command="sound.stop"]').first()); await waitAudio(page, 0.4);
    await input.save();
    const observed = await page.evaluate(() => window.fretlinePracticeObservation?.());
    await writeFile(resolve(context.evidence, 'practice-events.json'), JSON.stringify(observed, null, 2));
    await inspectPracticeAudio(context, observed?.events ?? []);
    context.assert(await page.getByTestId('document-tab').getAttribute('data-dirty') === 'false',
      'Practice controls leave the document clean');
    for (const [width, height, theme] of [[1440, 900, 'light'], [1024, 700, 'light'], [1024, 700, 'dark']] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      await input.open(); await input.shot(`practice-settings-${theme}-${width}.png`); await input.key('Escape');
    }
  });
}
export const run: QaCase = context => practiceControls(context);
