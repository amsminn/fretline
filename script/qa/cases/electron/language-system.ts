import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import { systemLanguages } from '../../lib/electron';
import { withSessionApp } from './session-support';

const menuLabels = (application: ElectronApplication): Promise<string[]> => application.evaluate(({ Menu }) =>
  (Menu.getApplicationMenu()?.items ?? []).map(item => item.label));

async function expectLanguage(context: QaContext, application: ElectronApplication, page: Page, language: 'ko' | 'en', when: string): Promise<void> {
  const heading = { ko: '새 악보', en: 'New score' }[language];
  const menu = { ko: '파일', en: 'File' }[language];
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect.poll(() => menuLabels(application)).toContain(menu);
  context.assert(true, `${when}: the window and the native menu are in ${language === 'ko' ? 'Korean' : 'English'}`);
}
async function chooseLanguage(page: Page, option: string): Promise<void> {
  await page.keyboard.press('Meta+,');
  await expect(page.getByTestId('preferences-dialog')).toBeVisible();
  await page.getByTestId('language-select').click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('preferences-dialog')).toBeHidden();
}
const stored = async (userData: string): Promise<{ readonly version?: number; readonly language?: string }> =>
  JSON.parse(await readFile(resolve(userData, 'settings.json'), 'utf8')) as { readonly version?: number; readonly language?: string };

/** With no choice stored the app shows English unless macOS lists Korean first; a chosen language wins over the system. */
export const run: QaCase = async context => {
  const root = await mkdtemp(join(tmpdir(), 'fretline-qa-language-'));
  try {
    const fresh = async (name: string): Promise<string> => { const path = join(root, name); await mkdir(path); return path; };

    await withSessionApp(context, await fresh('korean-first'), async ({ application, page }) => {
      await expectLanguage(context, application, page, 'ko', 'First launch, macOS lists Korean then English');
      await page.screenshot({ path: resolve(context.evidence, 'system-korean.png') });
    }, systemLanguages('ko-KR', 'en-US'));

    const english = await fresh('english-first');
    await withSessionApp(context, english, async ({ application, page }) => {
      await expectLanguage(context, application, page, 'en', 'First launch, macOS lists English then Korean');
      await page.screenshot({ path: resolve(context.evidence, 'system-english.png') });
      await page.keyboard.press('Meta+,');
      await expect(page.getByTestId('language-select')).toContainText('Match system');
      await page.keyboard.press('Escape');
      await chooseLanguage(page, 'Korean');
      await expectLanguage(context, application, page, 'ko', 'After choosing Korean on an English system');
    }, systemLanguages('en-KR', 'ko-KR'));
    context.assert((await stored(english)).language === 'ko', 'The chosen language is stored as ko');
    await withSessionApp(context, english, async ({ application, page }) => {
      await expectLanguage(context, application, page, 'ko', 'Relaunch on the English system with Korean chosen');
      await chooseLanguage(page, '시스템 언어 따름');
      await expectLanguage(context, application, page, 'en', 'After choosing to match the system again');
    }, systemLanguages('en-KR', 'ko-KR'));
    context.assert((await stored(english)).language === 'system', 'Matching the system is stored as system');

    await withSessionApp(context, await fresh('other'), async ({ application, page }) => {
      await expectLanguage(context, application, page, 'en', 'First launch, macOS lists Japanese only');
    }, systemLanguages('ja-JP'));

    const upgraded = await fresh('upgraded');
    await writeFile(resolve(upgraded, 'settings.json'), JSON.stringify({ version: 1, theme: 'dark', language: 'ko',
      panels: { palette: { visible: true, size: 220 }, inspector: { visible: true, size: 260 }, globalView: { visible: true, size: 190 } },
      window: null, restoreWindow: true, recent: [] }));
    await withSessionApp(context, upgraded, async ({ application, page }) => {
      await expectLanguage(context, application, page, 'en', 'Settings written by the previous version (Korean by default) on an English system');
      await chooseLanguage(page, 'Korean');
      await expectLanguage(context, application, page, 'ko', 'After choosing Korean in the upgraded settings');
    }, systemLanguages('en-US'));
    const after = await stored(upgraded);
    context.assert(after.version === 2 && after.language === 'ko', `The upgraded settings are stored as version 2 with the chosen language (${JSON.stringify(after)})`);
  } finally { await rm(root, { recursive: true, force: true }); }
};
