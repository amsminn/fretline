import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import { deliverOpenFile } from './import-support';
import { importInterchange, midiFixture } from './interchange-support';
import { captureThemes, clickMenuItem, stubSaveDialog, waitForEditableScore, withSessionApp } from './session-support';

const hangul = /[\u3131-\uD7A3]/;
/** Excluded from the Hangul scan: only content authored by the user or the fixture (score engraving, document tab titles, track names). */
const excluded = ['[data-testid="score-engine"]', '[data-testid="document-tab"]', '[data-testid="track-name"]', '[data-tuning-track]', '[data-testid="lcd-track"]'];

const hangulFindings = (page: Page): Promise<readonly string[]> => page.evaluate(({ pattern, skip }) => {
  const regex = new RegExp(pattern);
  const findings: string[] = [];
  for (const element of document.body.querySelectorAll<HTMLElement>('*')) {
    if (element.closest(skip)) continue;
    for (const attribute of ['aria-label', 'title', 'placeholder', 'aria-description']) {
      const value = element.getAttribute(attribute);
      if (value && regex.test(value)) findings.push(`${attribute}=${value}`);
    }
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent && regex.test(node.textContent)) findings.push(`text:${node.textContent.trim()}`);
    }
  }
  return findings;
}, { pattern: hangul.source, skip: excluded.join(', ') });

async function expectEnglish(context: QaContext, page: Page, stop: string): Promise<void> {
  const findings = await hangulFindings(page);
  context.assert(findings.length === 0, `${stop}: no Hangul in rendered text, aria-labels, titles or placeholders${findings.length ? ` (${findings.slice(0, 5).join(' | ')})` : ''}`);
}

const menuLabels = (application: ElectronApplication): Promise<readonly string[]> => application.evaluate(({ Menu }) => {
  const labels: string[] = [];
  const walk = (items: readonly Electron.MenuItem[]): void => { for (const item of items) { if (item.label) labels.push(item.label); if (item.submenu) walk(item.submenu.items); } };
  walk(Menu.getApplicationMenu()?.items ?? []);
  return labels;
});

async function chooseLanguage(page: Page, option: string): Promise<void> {
  await page.keyboard.press('Meta+,');
  await expect(page.getByTestId('preferences-dialog')).toBeVisible();
  await page.getByTestId('language-select').click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

const dialogCommands = [
  'bar.tempo', 'bar.meter', 'bar.key', 'track.tuning', 'section.chord', 'section.lyrics', 'section.edit', 'bar.repeatOpen', 'bar.directions',
  'section.text', 'section.automation', 'track.add', 'track.instrument', 'track.transpose', 'edit.specialPaste', 'view.stylesheet', 'view.scoreSettings',
  'note.tuplet', 'bar.rebar', 'tools.chord', 'tools.scale', 'practice.relativeSpeed', 'file.pageSetup', 'file.export.pdf', 'file.export.png', 'file.export.svg', 'file.print', 'file.export.wav',
  'file.export.musicxml', 'file.recovery',
] as const;

export const run: QaCase = async context => {
  const userData = resolve(context.evidence, 'userData');
  await rm(userData, { recursive: true, force: true });
  await mkdir(userData, { recursive: true });
  const corrupt = resolve(context.evidence, 'corrupt.gp');
  await writeFile(corrupt, new Uint8Array([0, 1, 2, 3]));

  await withSessionApp(context, userData, async ({ application, page }) => {
    await expect(page.getByTestId('home')).toBeVisible();
    await expect(page.getByRole('heading', { name: '새 악보' })).toBeVisible();
    await chooseLanguage(page, 'English');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('preferences-dialog')).toContainText('Preferences');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preferences-dialog')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'New score' })).toBeVisible();
    await expectEnglish(context, page, 'Home after switching to English');
    const menuBefore = await menuLabels(application);
    context.assert(menuBefore.includes('File') && menuBefore.includes('Loop') && !menuBefore.some(label => hangul.test(label)),
      `Native menu was rebuilt in English on the preference write (${menuBefore.length} items, e.g. ${menuBefore.slice(1, 6).join(', ')})`);
    await page.screenshot({ path: resolve(context.evidence, 'home-english.png') });

    await deliverOpenFile(context, { application, page }, resolve('tests/fixtures/projects/loop-eight-bars.fretline'));
    await waitForEditableScore(page);
    await expect(page.getByRole('toolbar', { name: 'Toolbar' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Transport' })).toBeVisible();
    await expect(page.locator('[data-area="palette"] h2')).toHaveText('Editing Palette');
    await expect(page.getByRole('tablist', { name: 'Inspector' })).toBeVisible();
    await expect(page.getByTestId('global-view')).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Master volume' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom In' })).toBeVisible();
    await expectEnglish(context, page, 'Shell with fixture: toolbar, LCD, palette, inspector, mixer');
    await captureThemes(page, 'shell-english', context.evidence);

    await page.keyboard.press('Meta+e');
    const search = page.getByRole('combobox', { name: 'Search commands' });
    await expect(search).toBeFocused();
    await search.fill('loop');
    const results = page.getByTestId('command-palette-results').getByRole('option');
    await expect(results.first()).toHaveAttribute('data-command', 'sound.loop');
    await expect(results.first()).toContainText('Loop');
    await expectEnglish(context, page, 'Command palette');
    await page.screenshot({ path: resolve(context.evidence, 'command-palette-english.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toBeHidden();

    let walked = 0;
    for (const id of dialogCommands) {
      const enabled = await application.evaluate(({ Menu }, item) => Menu.getApplicationMenu()?.getMenuItemById(item)?.enabled ?? false, id);
      if (!enabled) { context.log(`${id}: menu item not enabled in this state, skipped`); continue; }
      await clickMenuItem(application, id);
      const dialog = page.getByRole('dialog').last();
      await expect(dialog).toBeVisible();
      walked++;
      await expectEnglish(context, page, `Dialog ${id}`);
      const later = dialog.getByRole('button', { name: 'Later', exact: true });
      if (await later.count()) await later.click(); else await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    context.assert(walked >= 20, `Walked ${walked} catalog dialogs through the native menu`);

    for (const section of ['guide', 'shortcuts', 'compatibility'] as const) {
      await clickMenuItem(application, `help.${section}`);
      await expect(page.getByTestId('help-dialog')).toHaveAttribute('data-section', section);
      await expectEnglish(context, page, `Help ${section}`);
      if (section === 'shortcuts') await expect(page.locator('[data-help-shortcut="sound.loop"] td').first()).toContainText('Loop');
      await page.screenshot({ path: resolve(context.evidence, `help-${section}-english.png`) });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('help-dialog')).toBeHidden();
    }

    await clickMenuItem(application, 'file.export.gp');
    await expect(page.getByTestId('export-dialog')).toBeVisible();
    await expect(page.getByTestId('export-dialog')).toContainText('Export GP file (.gp)');
    await expect(page.getByTestId('export-preflight')).toBeVisible();
    await expect(page.getByTestId('export-preflight').locator('[data-feature]').first()).toBeVisible();
    await expectEnglish(context, page, 'Export preflight including adapter loss rows');
    await page.screenshot({ path: resolve(context.evidence, 'export-preflight-english.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('export-dialog')).toBeHidden();

    await deliverOpenFile(context, { application, page }, resolve('tests/fixtures/gp/gp8.gp'));
    const report = page.getByRole('dialog');
    await expect(report).toBeVisible();
    await expect(report).toContainText('Import Compatibility Report');
    await expect(report.getByRole('button', { name: 'Convert to editable copy', exact: true })).toBeVisible();
    await expect(report.locator('[data-feature]').first()).toBeVisible();
    await expectEnglish(context, page, 'Import report including adapter feature rows');
    await page.screenshot({ path: resolve(context.evidence, 'import-report-english.png') });
    await report.getByRole('button', { name: 'Open read-only', exact: true }).click();
    await expect(report).toBeHidden();
    await expect(page.getByTestId('compatibility-badge')).toContainText('Compatibility:');

    await clickMenuItem(application, 'tools.tuner');
    await expect(page.getByTestId('tuner')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Tuner' })).toBeVisible();
    await expectEnglish(context, page, 'Tuner tool');
    await clickMenuItem(application, 'tools.instrument');
    await expect(page.getByTestId('fretboard')).toBeVisible();
    await expectEnglish(context, page, 'Instrument View: fretboard');
    await page.getByRole('radio', { name: 'Keyboard' }).click();
    await expect(page.getByTestId('piano')).toBeVisible();
    await expectEnglish(context, page, 'Instrument View: keyboard');
    await page.screenshot({ path: resolve(context.evidence, 'tools-english.png') });
    await page.getByRole('button', { name: 'Close Instrument View' }).click();
    await page.getByRole('button', { name: 'Close Tuner' }).click();
    await expect(page.getByTestId('tuner')).toHaveCount(0);

    await importInterchange({ application, page }, await midiFixture(context), 'midi');
    const midiPreview = page.getByTestId('midi-import-preview');
    await expect(midiPreview).toBeVisible();
    await expect(midiPreview).toContainText('MIDI Quantization Preview');
    await expect(midiPreview.locator('tbody tr').first()).toBeVisible();
    await expectEnglish(context, page, 'MIDI import preview');
    await page.screenshot({ path: resolve(context.evidence, 'midi-preview-english.png') });
    await midiPreview.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(midiPreview).toBeHidden();

    await deliverOpenFile(context, { application, page }, corrupt);
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
    await expect(alert).toContainText('FORMAT');
    await expectEnglish(context, page, 'Error banner after a corrupt file, including the adapter diagnostic text');
    await page.screenshot({ path: resolve(context.evidence, 'error-english.png') });
    await page.getByRole('button', { name: 'OK', exact: true }).click();

    await page.getByTestId('document-tab').first().click();
    await waitForEditableScore(page);
    await clickMenuItem(application, 'track.add');
    const addTrack = page.getByRole('dialog');
    await expect(addTrack).toContainText('Add Track');
    await addTrack.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(addTrack).toBeHidden();
    await expect(page.getByTestId('document-tab').first()).toHaveAttribute('data-dirty', 'true');
    await stubSaveDialog({ application, page }, resolve(context.evidence, 'missing-folder', 'nested', 'save.fretline'));
    await page.keyboard.press('Meta+Shift+s');
    const saveError = page.getByTestId('document-error');
    await expect(saveError).toBeVisible();
    await expect(saveError).toHaveAttribute('data-error-code', 'ENOENT');
    await expectEnglish(context, page, 'Failed-save error banner (ENOENT) in English');
    await page.screenshot({ path: resolve(context.evidence, 'save-error-english.png') });
    await page.getByRole('button', { name: 'OK', exact: true }).click();

    await clickMenuItem(application, 'file.quit');
    const savePrompt = page.getByTestId('save-changes-dialog');
    await expect(savePrompt).toBeVisible();
    await expect(savePrompt).toContainText('Save changes?');
    await expectEnglish(context, page, 'Save-changes prompt on quit');
    await page.screenshot({ path: resolve(context.evidence, 'save-changes-english.png') });
    await savePrompt.getByRole('button', { name: "Don't Save", exact: true }).click();
  });

  const settings = JSON.parse(await readFile(resolve(userData, 'settings.json'), 'utf8')) as { readonly language?: string };
  context.assert(settings.language === 'en', 'settings.json persisted language=en');

  await withSessionApp(context, userData, async ({ application, page }) => {
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'New score' })).toBeVisible();
    const menu = await menuLabels(application);
    context.assert(menu.includes('File') && !menu.some(label => hangul.test(label)), 'English persisted across relaunch: html lang, Home and the native menu are English');
    await page.screenshot({ path: resolve(context.evidence, 'relaunch-english.png') });
    await chooseLanguage(page, 'Korean');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.getByTestId('preferences-dialog')).toContainText('설정');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '새 악보' })).toBeVisible();
    await expect.poll(() => menuLabels(application)).toContain('파일');
    context.assert(true, 'Switching back to 한국어 restores the Korean Home heading and native menu');
    await page.screenshot({ path: resolve(context.evidence, 'back-to-korean.png') });
  });
};
