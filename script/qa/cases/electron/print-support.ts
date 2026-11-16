import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { fixtureDocument, fixtureId } from '../../../../tests/domain/fixtures';
import type { Measure, ScoreDocument, ScoreEvent, Track, VoiceBar } from '../../../../src/domain/document';
import type { Chord, Lyric } from '../../../../src/domain/notation';
import type { Id } from '../../../../src/domain/ids';
import { saveProjectFile } from '../../../../src/main/projects';
import type { PrintObservation } from '../../../../src/renderer/print/runtime';
import { runFromPalette } from './tools-support';

export type PrintFixtureOptions = { readonly repeats: number; readonly title: string; readonly lyric: string };
const syllables = ['아', '리', '랑', '고', '개', '를', '넘', '어'] as const;
const drumHits = [{ midi: 36, articulation: 'kick' }, { midi: 42, articulation: 'hihat' }, { midi: 38, articulation: 'snare' }, { midi: 42, articulation: 'hihat' }] as const;

function repeatedBar(bar: VoiceBar, repeat: number, measureId: Id<'measure'>): VoiceBar {
  switch (bar.kind) {
    case 'inactive': return { kind: 'inactive', measureId };
    case 'active': return { kind: 'active', measureId, events: bar.events.map((event): ScoreEvent => {
      const eventId = repeat === 0 ? event.id : fixtureId('event', `print:${repeat}:${event.id}`);
      switch (event.kind) {
        case 'noteGroup': return { ...event, id: eventId, notes: event.notes.map(note => ({ ...note, id: repeat === 0 ? note.id : fixtureId('note', `print:${repeat}:${note.id}`) })) };
        case 'rest': case 'spacer': return { ...event, id: eventId };
      }
    }) };
  }
}

/** Korean title, chords, lyrics and a drum track over `repeats` copies of the eight-bar loop fixture. */
export function printFixtureDocument(options: PrintFixtureOptions): ScoreDocument {
  const base = fixtureDocument('loop-eight-bars');
  const measures: Measure[] = [];
  const measureIds: Id<'measure'>[][] = [];
  for (let repeat = 0; repeat < options.repeats; repeat++) {
    const ids = base.measures.map(measure => repeat === 0 ? measure.id : fixtureId('measure', `print:${repeat}:${measure.id}`));
    measureIds.push(ids);
    base.measures.forEach((measure, index) => {
      const measureId = ids[index];
      if (!measureId) throw new RangeError('measure id');
      measures.push({ ...measure, id: measureId, ...(index === 0 ? { section: { name: `${repeat + 1}절`, letter: String.fromCharCode(65 + repeat) } } : {}) });
    });
  }
  const tracks: Track[] = base.tracks.map(track => ({ ...track, staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => ({
    ...voice, bars: measureIds.flatMap((ids, repeat) => voice.bars.map((bar, index) => {
      const measureId = ids[index];
      if (!measureId) throw new RangeError('measure id');
      return repeatedBar(bar, repeat, measureId);
    })) })) })) }));
  const drumId = fixtureId('track', 'print:drums');
  const drumBars: VoiceBar[] = measures.map((measure, index) => ({ kind: 'active', measureId: measure.id, events: drumHits.map((hit, beat): ScoreEvent => ({
    kind: 'noteGroup', id: fixtureId('event', `print:drum:${index}:${beat}`), duration: { base: 4, dots: 0, tupletIds: [] },
    notes: [{ kind: 'percussion', id: fixtureId('note', `print:drum:${index}:${beat}`), midi: hit.midi, articulation: hit.articulation, techniques: [] }] })) }));
  tracks.push({ id: drumId, name: '드럼', instrument: { kind: 'percussion', program: 0, bank: 128 },
    staves: [{ id: fixtureId('staff', 'print:drums'), clef: 'percussion', tuning: [], capo: 0, notationMode: 'drum', voices: [
      { id: fixtureId('voice', 'print:drums:1'), number: 1, bars: drumBars },
      ...([2, 3, 4] as const).map(number => ({ id: fixtureId('voice', `print:drums:${number}`), number, bars: measures.map(m => ({ kind: 'inactive' as const, measureId: m.id })) })),
    ] }] });
  const lead = tracks[0]?.staves[0]?.voices[0];
  if (!lead) throw new RangeError('lead voice');
  const lyrics: Lyric[] = [];
  const chords: Chord[] = [];
  let syllable = 0;
  for (const bar of lead.bars) {
    if (bar.kind !== 'active') continue;
    bar.events.forEach((event, beat) => {
      if (event.kind !== 'noteGroup') return;
      const text = beat === 0 && options.lyric ? options.lyric : syllables[syllable++ % syllables.length] ?? '아';
      lyrics.push({ id: fixtureId('lyric', `print:${event.id}`), eventId: event.id, verse: 1, text, syllabic: 'single', extend: false });
      if (beat === 0) chords.push({ id: fixtureId('chord', `print:${event.id}`), eventId: event.id, name: ['Am', 'G', 'F', 'E7'][chords.length % 4] ?? 'Am', root: 9, intervals: [0, 3, 7] });
    });
  }
  return { ...base, id: fixtureId('score', `print:${options.title}`), measures, tracks, lyrics, chords,
    metadata: { ...base.metadata, title: options.title, subtitle: '인쇄 QA 악보', artist: '프렛라인', words: '전래 민요', music: '전래 민요', copyright: 'QA fixture' } };
}

export async function writePrintFixture(directory: string, options: PrintFixtureOptions): Promise<string> {
  const path = resolve(directory, `${options.title}.fretline`);
  const score = printFixtureDocument(options);
  await saveProjectFile(path, { project: { schemaVersion: 1, projectId: fixtureId('project', `print:${options.title}`), score, assets: [], source: null, preservation: [] }, blobs: [] }, 1);
  return path;
}

export async function waitForShellScore(page: Page): Promise<void> {
  await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(page.getByTestId('score-engine').locator('svg').first()).toBeVisible();
}

export const formatQueries = { print: ['인쇄', 'file.print'], pdf: ['PDF 내보내기', 'file.export.pdf'], png: ['PNG 이미지 내보내기', 'file.export.png'], svg: ['SVG 이미지 내보내기', 'file.export.svg'] } as const;
export type PrintFormat = keyof typeof formatQueries;

/** `print` opens through Cmd+P (the native accelerator); file formats go through the palette entry of their export command. */
export async function openExportDialog(context: QaContext, page: Page, format: PrintFormat): Promise<void> {
  const [query, commandId] = formatQueries[format];
  if (format === 'print') { await page.keyboard.press('Meta+p'); context.log('Opened print dialog with Cmd+P'); }
  else await runFromPalette(context, page, query, commandId);
  const dialog = page.getByTestId('print-export-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-format', format === 'print' ? 'pdf' : format);
  await expect(dialog).toHaveAttribute('data-intent', format === 'print' ? 'print' : 'file');
}

export type QaPrintRecord = { readonly title: string; readonly pageCount: number; readonly widthMm: number; readonly heightMm: number; readonly landscape: boolean };
/** The main process records each OS print request under FRETLINE_QA instead of presenting the dialog. */
export async function printRecords(application: ElectronApplication): Promise<readonly QaPrintRecord[]> {
  const raw = await application.evaluate(() => process.env['FRETLINE_QA_PRINT_REQUESTS'] ?? '[]');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new QaFailure('assertion', 'Print record is not an array');
  return parsed.map((entry: unknown): QaPrintRecord => {
    if (typeof entry !== 'object' || entry === null) throw new QaFailure('assertion', 'Invalid print record');
    const number = (key: string): number => { const value = Reflect.get(entry, key); if (typeof value !== 'number') throw new QaFailure('assertion', `Print record lacks ${key}`); return value; };
    const title = Reflect.get(entry, 'title');
    const landscape = Reflect.get(entry, 'landscape');
    if (typeof title !== 'string' || typeof landscape !== 'boolean') throw new QaFailure('assertion', 'Print record lacks title/landscape');
    return { title, landscape, pageCount: number('pageCount'), widthMm: number('widthMm'), heightMm: number('heightMm') };
  });
}

export async function chooseSelect(page: Page, label: string, optionText: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: optionText }).click();
}

export const observation = (page: Page): Promise<PrintObservation> => page.evaluate(() => {
  const read = window.fretlinePrintObservation;
  if (!read) throw new TypeError('Print observation is unavailable');
  return read();
});

export async function runExportAndCollect(context: QaContext, page: Page, format: PrintFormat): Promise<NonNullable<PrintObservation['lastJob']>> {
  const before = (await observation(page)).lastJob;
  await page.locator(`[data-testid="print-run"][data-action="${format}"]`).click();
  await expect.poll(async () => {
    const current = await observation(page);
    return !current.busy && current.lastJob !== before && current.lastJob !== null ? current.lastJob.format : current.message?.tone === 'error' ? `error:${current.message.text}` : null;
  }, { timeout: 120_000 }).toBe(format);
  const job = (await observation(page)).lastJob;
  if (!job) throw new QaFailure('assertion', 'No print job recorded');
  const directory = resolve(context.evidence, `artifacts-${format}`);
  await mkdir(directory, { recursive: true });
  for (const artifact of job.artifacts) await writeFile(resolve(directory, artifact.name), Buffer.from(artifact.base64, 'base64'));
  await writeFile(resolve(directory, 'job.json'), JSON.stringify({ ...job, artifacts: job.artifacts.map(artifact => ({ name: artifact.name, format: artifact.format, byteLength: artifact.byteLength })) }, null, 2));
  context.log(`${format}: ${job.pageCount} pages, measures ${job.span.first + 1}–${job.span.last + 1}, fit ${job.fit}, result ${JSON.stringify(job.result)}`);
  return job;
}

export type InkStats = {
  readonly source: string; readonly page: number; readonly width: number; readonly height: number; readonly inkPixels: number;
  readonly transparentPixels: number; readonly inkMinX: number; readonly inkMinY: number; readonly inkMaxX: number; readonly inkMaxY: number; readonly png: string | null;
};
/** Apple CoreGraphics decodes the files; nothing from the exporter is reused. */
export function rasterStats(outDirectory: string, scale: number, files: readonly string[]): Promise<readonly InkStats[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('swift', [resolve('script/qa/cases/electron/print-raster.swift'), outDirectory, String(scale), ...files], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { reject(new QaFailure('infrastructure', `print-raster.swift exited ${code}: ${errors}`)); return; }
      const parsed: unknown = JSON.parse(output);
      if (!Array.isArray(parsed)) { reject(new QaFailure('infrastructure', 'print-raster.swift returned no array')); return; }
      resolvePromise(parsed.map((entry: unknown): InkStats => {
        if (typeof entry !== 'object' || entry === null) throw new QaFailure('infrastructure', 'Invalid raster entry');
        const get = (key: string): number => { const value = Reflect.get(entry, key); if (typeof value !== 'number') throw new QaFailure('infrastructure', `Raster entry lacks ${key}`); return value; };
        const source = Reflect.get(entry, 'source');
        const png = Reflect.get(entry, 'png');
        return { source: typeof source === 'string' ? source : '', page: get('page'), width: get('width'), height: get('height'), inkPixels: get('inkPixels'),
          transparentPixels: get('transparentPixels'), inkMinX: get('inkMinX'), inkMinY: get('inkMinY'), inkMaxX: get('inkMaxX'), inkMaxY: get('inkMaxY'), png: typeof png === 'string' ? png : null };
      }));
    });
  });
}

export type PdfSummary = { readonly pageCount: number; readonly text: readonly string[]; readonly title: string | undefined; readonly pageSizesPt: readonly { readonly width: number; readonly height: number }[] };
/** pdfjs-dist (an independent PDF reader) parses structure and text. */
export async function summarizePdf(bytes: Uint8Array): Promise<PdfSummary> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const document = await task.promise;
  const text: string[] = [];
  const pageSizesPt: { width: number; height: number }[] = [];
  for (let index = 1; index <= document.numPages; index++) {
    const page = await document.getPage(index);
    const viewport = page.getViewport({ scale: 1 });
    pageSizesPt.push({ width: viewport.width, height: viewport.height });
    const content = await page.getTextContent();
    text.push(content.items.map(item => ('str' in item ? item.str : '')).join(''));
  }
  const metadata = await document.getMetadata();
  const info: unknown = metadata.info;
  const title = typeof info === 'object' && info !== null && 'Title' in info && typeof info.Title === 'string' ? info.Title : undefined;
  const pageCount = document.numPages;
  await task.destroy();
  return { pageCount, text, title, pageSizesPt };
}
