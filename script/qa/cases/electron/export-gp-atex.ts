import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { importer, Settings } from '@coderline/alphatab/core';
import type { ScoreDocument } from '../../../../src/domain/document';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import { withImportApp, deliverOpenFile, inspectReport } from './import-support';
import { ready, rhythmInput, selectFirst } from './complex-rhythm-edit';

export async function openExport(surface: ImportSurface, target: 'gp' | 'alphatex' | 'original'): Promise<void> {
  // Exercise the actual native File menu, whose availability is published by the renderer registry.
  await expect.poll(() => surface.application.evaluate(({ Menu }, target) =>
    Menu.getApplicationMenu()?.getMenuItemById(`file.export.${target}`)?.enabled, target)).toBe(true);
  await surface.application.evaluate(({ Menu }, target) => {
    const menu = Menu.getApplicationMenu();
    const command = menu?.getMenuItemById(`file.export.${target}`);
    if (!command || !menu) throw new TypeError('Export command missing from native File menu');
    command.click();
  }, target);
  await expect(surface.page.getByTestId('export-dialog')).toBeVisible();
  await expect(surface.page.getByTestId('export-preflight')).toBeVisible();
}
export async function chooseExport(surface: ImportSurface, path: string | null): Promise<void> {
  await surface.application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async options => {
      process.env['FRETLINE_EXPORT_PICKER_OPTIONS'] = JSON.stringify(options);
      process.env['FRETLINE_EXPORT_PICKER_COUNT'] = String(Number(process.env['FRETLINE_EXPORT_PICKER_COUNT'] ?? '0') + 1);
      return { canceled: path === null, filePath: path ?? '' };
    };
  }, path);
}
export function xmlField(value: unknown, path: string): unknown {
  let current = value;
  const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;
  for (const key of path.split('.')) {
    if (!record(current)) throw new TypeError(`Missing GPIF XML object ${path}`);
    current = current[key];
  }
  return current;
}
function xmlNodes(value: unknown, path: string): readonly unknown[] {
  const found = xmlField(value, path);
  return Array.isArray(found) ? found : found === undefined ? [] : [found];
}
function xmlProperty(value: unknown, name: string, child = name): unknown {
  const item = xmlNodes(value, 'Properties.Property').find(item => xmlField(item, '@name') === name);
  return item ? xmlField(item, child) : null;
}
export function decodeGp(bytes: Uint8Array): unknown {
  const xml = unzipSync(bytes)['Content/score.gpif'];
  if (!xml) throw new TypeError('Output .gp has no Content/score.gpif');
  const text = new TextDecoder().decode(xml);
  expect(XMLValidator.validate(text)).toBe(true);
  const parsed: unknown = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false }).parse(text);
  return xmlField(parsed, 'GPIF');
}
export async function scoreObservation(surface: ImportSurface): Promise<ScoreDocument> {
  const score = await surface.page.evaluate(() => window.fretlineArrangementObservation?.()?.score);
  if (!score) throw new TypeError('Missing read-only score observation');
  return score;
}
export function expectedNotes(document: ScoreDocument) {
  return document.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice =>
    voice.bars.flatMap(bar => bar.kind === 'active' ? bar.events.flatMap(event => event.kind === 'noteGroup'
      ? event.notes.flatMap(note => note.kind === 'fretted' ? [{ string: staff.tuning.length - note.string,
        fret: note.fret, midi: (staff.tuning[note.string - 1] ?? 0) + note.fret + staff.capo }] : []) : []) : []))));
}
async function captureDialog(context: QaContext, surface: ImportSurface, name: string): Promise<void> {
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    await surface.page.setViewportSize({ width, height });
    for (const theme of ['dark', 'light']) {
      await surface.page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      const dialog = surface.page.getByTestId('export-dialog');
      await expect(dialog).toBeInViewport();
      await dialog.screenshot({ path: resolve(context.evidence, `${name}-${theme}-${width}.png`) });
      const geometry = await dialog.evaluate(node => {
        const body = node.querySelector('[data-testid="export-preflight"]');
        const bounds = node.getBoundingClientRect();
        const button = [...node.querySelectorAll('button')].find(button => button.textContent?.includes('내보내기'));
        const footer = button?.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, viewport: innerHeight,
          horizontalOverflow: node.scrollWidth > node.clientWidth, footerVisible: footer !== undefined && footer.bottom <= innerHeight,
          scroller: body ? getComputedStyle(body).overflowY : null };
      });
      context.assert(!geometry.horizontalOverflow && geometry.height <= geometry.viewport && geometry.footerVisible && geometry.scroller === 'auto',
        `${name} ${theme} ${width}: dialog fits, footer stays visible, preflight owns scrolling`);
    }
  }
}
export const run: QaCase = async context => {
  const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
  const fixtureHash = createHash('sha256').update(await readFile(fixture)).digest('hex');
  await withImportApp(context, fixture, async surface => {
    const { page } = surface;
    await ready(surface);
    await selectFirst(surface, rhythmInput(surface));
    await page.keyboard.press('9');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    const source = await scoreObservation(surface);
    const observed = JSON.stringify(source);
    await openExport(surface, 'gp');
    await expect(page.getByTestId('export-preflight').locator('[data-feature="gp.container.version"]')).toContainText('8.1.3');
    await captureDialog(context, surface, 'gp-preflight');
    await chooseExport(surface, resolve(context.evidence, 'edited.gp'));
    await page.getByRole('checkbox', { name: '변환 손실 확인' }).check();
    await page.getByRole('button', { name: '내보내기…', exact: true }).click();
    await expect(page.getByTestId('export-dialog')).toBeHidden();
    const xml = decodeGp(await readFile(resolve(context.evidence, 'edited.gp')));
    expect(xmlField(xml, 'Score.Title')).toBe(source.metadata.title);
    expect(xmlNodes(xml, 'Tracks.Track').map(track => xmlField(track, 'Name'))).toEqual(source.tracks.map(track => track.name));
    expect(xmlNodes(xml, 'Tracks.Track').flatMap(track => xmlNodes(track, 'Staves.Staff').map(staff =>
      xmlProperty(staff, 'Tuning', 'Pitches')))).toEqual(source.tracks.flatMap(track =>
      track.staves.map(staff => [...staff.tuning].reverse().join(' '))));
    const decodedNotes = xmlNodes(xml, 'Notes.Note').map(note => ({
      string: Number(xmlProperty(note, 'String')), fret: Number(xmlProperty(note, 'Fret')), midi: Number(xmlProperty(note, 'Midi', 'Number')),
    }));
    expect(decodedNotes).toEqual(expectedNotes(source));
    expect(xmlNodes(xml, 'MasterBars.MasterBar').map(bar => xmlField(bar, 'Time'))).toEqual(Array(8).fill('4/4'));
    expect(xmlNodes(xml, 'Rhythms.Rhythm').map(rhythm => xmlField(rhythm, 'NoteValue'))).toEqual(['Quarter']);
    context.assert(true, 'UI GP export passes independent ZIP/XML metadata, track, tuning, note/string/fret/MIDI, meter and rhythm decoding');
    await writeFile(resolve(context.evidence, 'independent-gpif.json'), JSON.stringify(xml, null, 2));
    await openExport(surface, 'alphatex');
    await captureDialog(context, surface, 'alphatex-preflight');
    await chooseExport(surface, resolve(context.evidence, 'edited.atex'));
    await page.getByRole('checkbox', { name: '변환 손실 확인' }).check();
    await page.getByRole('button', { name: '내보내기…', exact: true }).click();
    await expect(page.getByTestId('export-dialog')).toBeHidden();
    const texBytes = await readFile(resolve(context.evidence, 'edited.atex'));
    const reader = new importer.AlphaTexImporter();
    reader.initFromString(texBytes.toString('utf8'), new Settings());
    const parsed = reader.readScore();
    expect(parsed.title).toBe(source.metadata.title);
    const parsedNotes = parsed.tracks.flatMap(track => track.staves).flatMap(staff => staff.bars)
      .flatMap(bar => bar.voices).flatMap(voice => voice.beats).flatMap(beat => beat.notes).map(note => note.realValue);
    expect(parsedNotes).toEqual(expectedNotes(source).map(note => note.midi));
    context.assert(true, 'UI alphaTex output is parsed as music and contains every edited attack in track/bar order');
    expect(JSON.stringify(await scoreObservation(surface))).toBe(observed);
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    context.assert(true, 'GP/alphaTex export preserves current document, dirty state and the native Save destination');
    const originalPath = resolve('tests/fixtures/gp/gp7.gp');
    const originalBytes = await readFile(originalPath);
    await deliverOpenFile(context, surface, originalPath);
    await inspectReport(context, surface, 'gp7.gp');
    await page.getByRole('button', { name: '편집 가능한 사본으로 변환', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await ready(surface);
    await openExport(surface, 'original');
    await expect(page.getByTestId('export-dialog')).toContainText('SHA-256');
    await captureDialog(context, surface, 'original');
    await chooseExport(surface, resolve(context.evidence, 'original.gp'));
    await page.getByRole('button', { name: '내보내기…', exact: true }).click();
    await expect(page.getByTestId('export-dialog')).toBeHidden();
    expect(await readFile(resolve(context.evidence, 'original.gp'))).toEqual(originalBytes);
    expect(await readFile(originalPath)).toEqual(originalBytes);
    decodeGp(await readFile(resolve(context.evidence, 'original.gp')));
    context.assert(true, 'Separate original extraction is byte-exact and its GPIF independently decodes; imported source stays unchanged');
    await writeFile(resolve(context.evidence, 'output-hashes.json'), JSON.stringify({
      projectFixture: fixtureHash, gp: createHash('sha256').update(await readFile(resolve(context.evidence, 'edited.gp'))).digest('hex'),
      alphatex: createHash('sha256').update(texBytes).digest('hex'), original: createHash('sha256').update(originalBytes).digest('hex'),
    }, null, 2));
  });
  expect(createHash('sha256').update(await readFile(fixture)).digest('hex')).toBe(fixtureHash);
};
