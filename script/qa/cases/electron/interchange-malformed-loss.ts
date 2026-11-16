import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { withElectron } from '../../lib/electron';
import type { QaCase } from '../../lib/contracts';
import { confirmInterchange, importInterchange, midiFixture, scoreSnapshot } from './interchange-support';

export const run: QaCase = async context => {
  await withElectron(context, async surface => {
    const { page } = surface;
    context.log('Only native open picker boundary is stubbed; every failure goes through the production worker and real dialogs.');
    const original = await readFile('tests/fixtures/musicxml/voices-ties.musicxml');
    await importInterchange(surface, 'tests/fixtures/musicxml/voices-ties.musicxml', 'musicxml');
    await confirmInterchange(surface);
    const before = await scoreSnapshot(surface);
    const hash = await page.getByTestId('compatibility-badge').getAttribute('data-source-hash');
    const invalid = [
      { name: 'divisions.musicxml', bytes: Buffer.from(original.toString().replace('<divisions>12</divisions>', '<divisions>0</divisions>')) },
      { name: 'doctype.musicxml', bytes: Buffer.from(original.toString().replace('<score-partwise', '<!DOCTYPE score-partwise [<!ENTITY x SYSTEM "file:///etc/passwd">]><score-partwise')) },
      { name: 'traversal.mxl', bytes: zipSync({ '../score.musicxml': original }) },
    ];
    for (const item of invalid) {
      const path = resolve(context.evidence, item.name);
      await writeFile(path, item.bytes);
      await importInterchange(surface, path, 'musicxml');
      const alert = page.getByRole('alert');
      await expect(alert).toBeVisible();
      context.assert(await scoreSnapshot(surface) === before, `${item.name}: failed parse keeps current document byte-for-byte`);
      await page.screenshot({ path: resolve(context.evidence, `${item.name}.png`) });
      await alert.getByRole('button', { name: '확인' }).click();
    }
    const unsupported = resolve(context.evidence, 'unsupported.musicxml');
    await writeFile(unsupported, original.toString().replace('<notations>', '<notations><slur type="start" number="1"/>'));
    await importInterchange(surface, unsupported, 'musicxml');
    const slurRow = page.getByRole('dialog').locator('[data-feature="slur"][data-status="unsupported"]');
    await expect(slurRow).toHaveCount(1);
    await expect(slurRow).toContainText('슬러');
    await page.getByRole('button', { name: '취소', exact: true }).click();
    context.assert(await scoreSnapshot(surface) === before, 'Cancelling unsupported field report preserves current document');
    await importInterchange(surface, await midiFixture(context), 'midi');
    const preview = page.getByTestId('midi-import-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByRole('button', { name: '배치 확정' })).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await preview.getByRole('combobox', { name: '양자화 단위' }).click();
    await page.getByRole('option', { name: '8분 셋잇단' }).click();
    await preview.getByRole('button', { name: '취소', exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    context.assert(await scoreSnapshot(surface) === before, 'Cancelling quantization preserves current score and source');
    context.assert(await page.getByTestId('compatibility-badge').getAttribute('data-source-hash') === hash, 'Original provenance hash remains unchanged');
    context.assert((await readFile('tests/fixtures/musicxml/voices-ties.musicxml')).equals(original), 'Source file on disk is unchanged');
    await page.screenshot({ path: resolve(context.evidence, 'original-preserved.png') });
  });
};
