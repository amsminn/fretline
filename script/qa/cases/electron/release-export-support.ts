import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import { chooseExport, decodeGp, expectedNotes, openExport, xmlField } from './export-gp-atex';
import { openAudio, readWave } from './export-mixed-wav';
import { scoreOf, savePicker } from './journey-support';

const nodes = (value: unknown, path: string): readonly unknown[] => {
  const found = xmlField(value, path);
  return Array.isArray(found) ? found : found === undefined ? [] : [found];
};
function property(value: unknown, name: string, child = name): unknown {
  const found = nodes(value, 'Properties.Property').find(item => xmlField(item, '@name') === name);
  return found ? xmlField(found, child) : null;
}
/** Uses the existing ZIP/XML reader, without reimporting through the exporter library. */
export async function releaseGp(context: QaContext, surface: ImportSurface, name: string): Promise<string> {
  const { page } = surface;
  const score = await scoreOf(page);
  const destination = resolve(context.evidence, name);
  await openExport(surface, 'gp');
  const losses = await page.getByTestId('export-preflight').locator('[data-feature]').evaluateAll(items =>
    items.map(item => ({ feature: item.getAttribute('data-feature'), impact: item.getAttribute('data-impact') })));
  context.assert(losses.every(loss => loss.impact !== 'blocked'), 'GP export preflight has no blocked features');
  await chooseExport(surface, destination);
  const acknowledgement = page.getByRole('checkbox', { name: '변환 손실 확인' });
  if (await acknowledgement.count()) await acknowledgement.check();
  await page.getByRole('button', { name: '내보내기…', exact: true }).click();
  await expect(page.getByTestId('export-dialog')).toBeHidden();
  const gpif = decodeGp(await readFile(destination));
  const actual = nodes(gpif, 'Notes.Note').map(note => ({
    string: Number(property(note, 'String')), fret: Number(property(note, 'Fret')),
    midi: Number(property(note, 'Midi', 'Number')),
  }));
  expect(actual).toEqual(expectedNotes(score));
  expect(nodes(gpif, 'Tracks.Track').map(track => xmlField(track, 'Name'))).toEqual(score.tracks.map(track => track.name));
  expect(nodes(gpif, 'MasterBars.MasterBar').map(bar => xmlField(bar, 'Time')))
    .toEqual(score.measures.map(measure => `${measure.meter.beats}/${measure.meter.unit}`));
  const expectedMuted = score.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice =>
    voice.bars.flatMap(bar => bar.kind === 'active' ? bar.events.flatMap(event => event.kind === 'noteGroup'
      ? event.notes.map(note => note.techniques.some(technique => technique.kind === 'palmMute')) : []) : []))));
  const actualMuted = nodes(gpif, 'Notes.Note').map(note =>
    nodes(note, 'Properties.Property').some(item => xmlField(item, '@name') === 'PalmMuted'));
  expect(actualMuted).toEqual(expectedMuted);
  expect(nodes(gpif, 'Rhythms.Rhythm').map(rhythm => xmlField(rhythm, 'NoteValue'))).toEqual(['Quarter']);
  context.assert(xmlField(gpif, 'Score.Title') === score.metadata.title,
    'Independent GPIF ZIP/XML decoder verifies title, tracks, every string/fret/pitch and meter');
  await writeFile(resolve(context.evidence, `${name}.decoded.json`), JSON.stringify({ losses, gpif, actual }, null, 2));
  return destination;
}
export async function releaseWav(context: QaContext, surface: ImportSurface): Promise<void> {
  const { page } = surface;
  await openAudio(surface);
  await page.getByRole('checkbox', { name: '선택 구간만', exact: true }).check();
  await page.getByRole('checkbox', { name: '반주 포함 (혼합)', exact: true }).check();
  const destination = resolve(context.evidence, 'release-mixed.wav');
  await savePicker(surface, destination);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'saved', { timeout: 120_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('audio-export-dialog')).toBeHidden();
  const wave = await readWave(destination);
  context.assert(wave.frames === 7 * 24_000 && wave.power(0) > 0.001 && wave.power(1) > 0.001,
    'Independent RIFF decoder verifies exactly 3.5 seconds of non-silent stereo mixed output for [5,12)');
  await writeFile(resolve(context.evidence, 'release-wav-analysis.json'),
    JSON.stringify({ frames: wave.frames, leftRms: wave.power(0), rightRms: wave.power(1) }, null, 2));
}
