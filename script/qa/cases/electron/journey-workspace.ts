import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import { inspectArchive } from './recovery-support';
import { createFromTemplate, noteCount } from './session-support';
import { openHelpFromMenu } from './help-support';
import { clickEmptyBar, commitStep, contentHash, savePicker, shot } from './journey-support';
import { hashDocument } from '../../../../src/domain/content-hash';

export async function journeyHome(context: QaContext, surface: ImportSurface): Promise<void> {
  const { page } = surface;
  context.log('Stage Home: guitar template -> empty-bar note entry -> atomic save');
  await expect(page.getByTestId('home')).toBeVisible();
  await shot(context, page, 'home-start');
  await createFromTemplate(page, 'guitar');
  context.assert(await noteCount(page) === 0, 'Home guitar template starts with empty bars');
  for (const [bar, fret] of [[0, '3'], [1, '5']] as const) {
    await clickEmptyBar(page, bar);
    await commitStep(page, () => page.keyboard.press(fret));
  }
  context.assert(await noteCount(page) === 2, 'Pointer entry into two empty bars creates two note groups');
  const authored = await contentHash(page);
  await shot(context, page, 'home-authored');
  const path = resolve(context.evidence, 'Home-guitar.fretline');
  await savePicker(surface, path);
  await page.keyboard.press('Meta+Shift+s');
  await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'false');
  const archive = await inspectArchive(path);
  context.assert((await hashDocument(archive.score)).sha256 === authored,
    'Independent ZIP decoding verifies the saved Home-authored score hash');
  await shot(context, page, 'home-saved');
  await page.keyboard.press('Meta+w');
  await expect(page.getByTestId('document-tab')).toHaveCount(0);
  await expect(page.getByTestId('home')).toBeVisible();
}

export async function journeyHelp(context: QaContext, surface: ImportSurface): Promise<void> {
  const { page, application } = surface;
  context.log('Stage Help: shortcut discovery -> registry command -> visible loop state');
  const before = await page.evaluate(() => window.fretlineLoopObservation?.().enabled);
  const hash = await contentHash(page);
  await openHelpFromMenu(application, page, 'shortcuts');
  const dialog = page.getByTestId('help-dialog');
  await dialog.getByRole('textbox', { name: '단축키 검색' }).fill('구간 반복');
  const row = dialog.locator('[data-help-shortcut="sound.loop"]');
  await expect(row).toBeVisible();
  await expect(row.locator('td').last()).toHaveText('F9');
  await shot(context, page, 'help-final-shortcut');
  await row.locator('[data-help-command="sound.loop"]').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().enabled)).toBe(!before);
  context.assert((await page.evaluate(() => window.fretlineHelpObservation?.().executed.at(-1))) === 'sound.loop' &&
    await contentHash(page) === hash, 'Help shortcut executes the real loop command without changing saved score content');
  await shot(context, page, 'help-final-executed');
}
