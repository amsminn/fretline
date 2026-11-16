import { expect } from '@playwright/test';
import type { ElectronSurface } from '../../lib/electron';
import type { QaContext } from '../../lib/contracts';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

export async function interchangeCommand(surface: ElectronSurface, id: string): Promise<void> {
  await surface.page.keyboard.press('Meta+e');
  const palette = surface.page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill(id);
  await palette.locator(`[data-command="${id}"]`).click();
}
export async function importInterchange(surface: ElectronSurface, path: string, format: 'musicxml' | 'midi'): Promise<void> {
  await surface.application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, resolve(path));
  await interchangeCommand(surface, `file.import.${format}`);
}
export async function confirmInterchange(surface: ElectronSurface): Promise<void> {
  await surface.page.getByRole('button', { name: '편집 가능한 사본으로 변환', exact: true }).click();
  await expect(surface.page.getByTestId('compatibility-badge')).toContainText('편집 사본');
  await expect(surface.page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
  await expect(surface.page.getByTestId('score-engine').locator('svg').first()).toBeVisible();
}
export async function exportInterchange(surface: ElectronSurface, input: {
  readonly format: 'musicxml' | 'midi'; readonly path: string; readonly compressed?: boolean;
}): Promise<Buffer> {
  await surface.application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, resolve(input.path));
  await interchangeCommand(surface, `file.export.${input.format}`);
  const dialog = surface.page.getByTestId('interchange-export-dialog');
  await expect(dialog).toBeVisible();
  if (input.compressed) await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '손실 확인 후 내보내기' }).click();
  await expect(dialog).toBeHidden();
  return readFile(input.path);
}
export async function midiFixture(context: QaContext): Promise<string> {
  const bytes = Buffer.from((await readFile('tests/fixtures/midi/study-smf0.hex', 'utf8')).replace(/\s/g, ''), 'hex');
  const path = resolve(context.evidence, 'source.mid');
  await writeFile(path, bytes);
  return path;
}
export async function scoreSnapshot(surface: ElectronSurface): Promise<string> {
  return surface.page.evaluate(() => JSON.stringify(window.fretlineArrangementObservation?.()?.score));
}
