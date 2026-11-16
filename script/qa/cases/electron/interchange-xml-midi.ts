import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { withElectron } from '../../lib/electron';
import type { QaCase } from '../../lib/contracts';
import { inspectMusicXml } from '../../../../tests/fixtures/musicxml/inspect';
import { inspectMidi } from '../../../../tests/fixtures/midi/independent';
import { confirmInterchange, exportInterchange, importInterchange, midiFixture } from './interchange-support';

export const run: QaCase = async context => {
  await withElectron(context, async surface => {
    const { page, application } = surface;
    context.log('Only native open/save dialog boundaries are stubbed. Import worker, compatibility approval, command registry and disk export are production paths.');
    await importInterchange(surface, 'tests/fixtures/musicxml/voices-ties.musicxml', 'musicxml');
    await expect(page.getByRole('dialog')).toContainText('MusicXML 4.0');
    await page.screenshot({ path: resolve(context.evidence, 'xml-import-report.png') });
    await confirmInterchange(surface);
    const native = await application.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      return ['file.import.musicxml', 'file.import.midi', 'file.export.musicxml', 'file.export.midi'].map(id =>
        ({ id, enabled: menu?.getMenuItemById(id)?.enabled ?? false }));
    });
    context.assert(native.every(item => item.enabled), 'All interchange commands are registered in the native File menu');
    const xmlBytes = await exportInterchange(surface, { format: 'musicxml', path: resolve(context.evidence, 'export.musicxml') });
    const xml = await inspectMusicXml(xmlBytes);
    context.assert(xml[0]?.notes[0]?.string === '1' && xml[0]?.notes[0]?.fret === '0' && xml[0]?.notes[2]?.ties[0] === 'stop', 'Independent XSD and XML decoder preserve technical fields and ties');
    context.assert(JSON.stringify(xml.map(m => m.tempo)) === '[[120],[90]]', 'Independent XML decoder preserves tempo map');
    const mxlBytes = await exportInterchange(surface, { format: 'musicxml', compressed: true, path: resolve(context.evidence, 'export.mxl') });
    const mxlXml = unzipSync(mxlBytes)['score.musicxml'];
    if (!mxlXml) throw new TypeError('MXL score entry missing');
    context.assert(JSON.stringify(await inspectMusicXml(mxlXml)) === JSON.stringify(xml), 'Independent ZIP and XSD decoding gives identical MXL semantics');
    const midiBytes = await exportInterchange(surface, { format: 'midi', path: resolve(context.evidence, 'export.mid') });
    const midi = inspectMidi(midiBytes);
    context.assert(midi.format === 1 &&
      JSON.stringify(midi.tracks[1]?.notes.filter(n => n.pitch === 64).map(n => [n.pitch, n.start, n.duration])) === '[[64,0,2],[64,8,2]]',
      'Independent SMF parser verifies SMF1 and two-quarter sustained ties');
    context.assert(midi.tracks[1]?.programs[0] === 24, 'Independent SMF parser verifies the guitar preset');
    await writeFile(resolve(context.evidence, 'independent-semantics.json'), JSON.stringify({ xml, midi }, null, 2));
    await importInterchange(surface, await midiFixture(context), 'midi');
    const preview = page.getByTestId('midi-import-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByRole('button', { name: '배치 확정' })).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    context.assert(true, 'The quantization preview is the only open modal; no compatibility report sits underneath it');
    await expect(preview.getByText('양자화 단위', { exact: true })).toBeVisible();
    await preview.getByRole('combobox', { name: '양자화 단위' }).click();
    await page.getByRole('option', { name: '8분 셋잇단' }).click();
    await preview.getByRole('combobox', { name: '현 배치' }).click();
    await page.getByRole('option', { name: '표준 기타 (EADGBE)' }).click();
    await expect(preview.getByRole('button', { name: '배치 확정' })).toBeEnabled();
    await expect(preview).toContainText('1 / 3');
    await page.screenshot({ path: resolve(context.evidence, 'midi-triplet-preview-dark.png') });
    await preview.getByRole('button', { name: '배치 확정' }).click();
    await expect(preview).toBeHidden();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toContainText('가져오기 호환성 보고서');
    context.assert(true, 'Confirming the placement opens the compatibility report as the next single modal');
    await page.screenshot({ path: resolve(context.evidence, 'midi-report-after-confirm.png') });
    await confirmInterchange(surface);
    const quantized = inspectMidi(await exportInterchange(surface, { format: 'midi', path: resolve(context.evidence, 'quantized.mid') }));
    context.assert(JSON.stringify(quantized.tracks[1]?.notes.map(n => [n.pitch, n.start, n.duration])) === '[[64,0,1],[67,1,1]]',
      'Confirmed triplet preview becomes exported pitches and exact durations');
    await page.screenshot({ path: resolve(context.evidence, 'score-dark-1440.png') });
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.evaluate(() => { document.documentElement.dataset['theme'] = 'light'; });
    await page.screenshot({ path: resolve(context.evidence, 'score-light-1024.png') });
    context.assert(await page.getByTestId('score-engine').locator('svg').count() > 0, 'Imported score is rendered in the real shell');
  });
};
