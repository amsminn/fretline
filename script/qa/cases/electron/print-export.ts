import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { chooseSelect, openExportDialog, printRecords, rasterStats, runExportAndCollect, summarizePdf, waitForShellScore, writePrintFixture } from './print-support';
import { attribution } from '../../../../src/renderer/print/pages';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const compact = (text: string): string => text.replace(/[\s\u0000-\u001f]+/g, '');
const title = '아리랑 인쇄 QA';

export const run: QaCase = async context => {
  const fixture = await writePrintFixture(context.evidence, { repeats: 6, title, lyric: '' });
  const saved = resolve(context.evidence, 'saved');
  await mkdir(saved, { recursive: true });
  await withImportApp(context, fixture, async ({ application, page }) => {
    await waitForShellScore(page);
    await application.evaluate(({ dialog }, folder) => {
      dialog.showSaveDialog = async (options) => {
        const defaultPath = typeof options === 'object' && options !== null && 'defaultPath' in options && typeof options.defaultPath === 'string' ? options.defaultPath : 'export';
        return { canceled: false, filePath: `${folder}/${defaultPath.split('/').pop() ?? 'export'}` };
      };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, saved);
    context.log('Stub native save/folder pickers only; command routing, dialogs, engraving, hidden print window, IPC and atomic writes are production code');

    await openExportDialog(context, page, 'print');
    await chooseSelect(page, '출력 대상', '전체 트랙');
    const printDialog = page.getByTestId('print-export-dialog');
    await expect(printDialog.getByRole('button', { name: '인쇄…' })).toBeVisible();
    await expect(printDialog.getByRole('button', { name: 'PDF 저장' })).toBeVisible();
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      await printDialog.screenshot({ path: resolve(context.evidence, `dialog-print-${theme}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dataset['theme'] = 'dark'; });
    context.assert((await printRecords(application)).length === 0, 'No print request exists before 인쇄… is clicked');
    const printJob = await runExportAndCollect(context, page, 'print');
    context.assert(printJob.result.kind === 'printed', `Cmd+P → 인쇄… reaches the main print boundary (${JSON.stringify(printJob.result)})`);
    context.assert(printJob.artifacts.length === 0, 'Printing writes no file artifact');
    const [printRecord, ...otherRecords] = await printRecords(application);
    if (!printRecord) throw new QaFailure('assertion', 'Main recorded no OS print request');
    context.assert(otherRecords.length === 0 && printRecord.pageCount === printJob.pageCount && printRecord.pageCount >= 3,
      `Main received exactly one print request for all ${printRecord.pageCount} paginated pages`);
    context.assert(printRecord.widthMm === 210 && printRecord.heightMm === 297 && printRecord.landscape === false && printRecord.title === title,
      `Print request carries A4 portrait page size and the document title (${JSON.stringify(printRecord)})`);
    await expect(printDialog).toBeHidden();
    context.log('Print went through the production paginate → SVG → hidden print window path; only the OS dialog boundary is recorded under FRETLINE_QA');

    await openExportDialog(context, page, 'pdf');
    await chooseSelect(page, '출력 대상', '전체 트랙');
    await page.screenshot({ path: resolve(context.evidence, 'dialog-pdf.png') });
    const pdfJob = await runExportAndCollect(context, page, 'pdf');
    context.assert(pdfJob.pageCount >= 3, `PDF of the 48-bar score spans at least 3 pages (${pdfJob.pageCount})`);
    context.assert(pdfJob.result.kind === 'saved', `PDF was written through the export bridge (${JSON.stringify(pdfJob.result)})`);
    const pdfArtifact = pdfJob.artifacts[0];
    if (!pdfArtifact || pdfJob.result.kind !== 'saved') throw new QaFailure('assertion', 'PDF artifact missing');
    const pdfBytes = await readFile(resolve(saved, pdfJob.result.fileName));
    context.assert(sha256(pdfBytes) === sha256(Buffer.from(pdfArtifact.base64, 'base64')), 'Saved PDF bytes equal the rendered artifact');
    const pdf = await summarizePdf(pdfBytes);
    context.assert(pdf.pageCount === pdfJob.pageCount, `pdfjs page count ${pdf.pageCount} equals the layout plan ${pdfJob.pageCount}`);
    context.assert(pdf.pageSizesPt.every(size => Math.abs(size.width - 595.3) < 1.5 && Math.abs(size.height - 841.9) < 1.5),
      `Every PDF page is A4 portrait (${JSON.stringify(pdf.pageSizesPt[0])})`);
    context.assert(compact(pdf.text.join('')).includes(compact(title)), 'pdfjs extracts the Korean title as text');
    context.assert(pdf.text.every(text => compact(text).includes(compact(attribution))), 'Every page keeps the alphaTab attribution as text');
    context.assert(pdf.text.some(text => text.includes('Am') || text.includes('E7')), 'Chord names are present as text');
    const raster = await rasterStats(resolve(context.evidence, 'raster-pdf'), 2, [resolve(saved, pdfJob.result.fileName)]);
    const marginPx = { left: 12 / 25.4 * 72 * 2, top: 15 / 25.4 * 72 * 2 };
    for (const page of raster) {
      const area = page.width * page.height;
      context.assert(page.inkPixels > area * 0.002, `PDF page ${page.page} is not blank (${page.inkPixels} ink px)`);
      context.assert(page.inkMinX >= marginPx.left - 4 && page.inkMaxX <= page.width - marginPx.left + 4 &&
        page.inkMinY >= marginPx.top - 4 && page.inkMaxY <= page.height - 4,
        `PDF page ${page.page} ink stays inside the paper margins (x ${page.inkMinX}–${page.inkMaxX}, y ${page.inkMinY}–${page.inkMaxY})`);
    }
    context.assert(raster.length === pdfJob.pageCount, 'CoreGraphics rasterized every page');

    await openExportDialog(context, page, 'svg');
    await chooseSelect(page, '출력 대상', '전체 트랙');
    const svgJob = await runExportAndCollect(context, page, 'svg');
    context.assert(svgJob.pageCount === pdfJob.pageCount && svgJob.artifacts.length === svgJob.pageCount, 'SVG export yields one file per page with the same pagination');
    context.assert(svgJob.result.kind === 'saved', `SVG set was written (${JSON.stringify(svgJob.result)})`);
    if (svgJob.result.kind !== 'saved') throw new QaFailure('assertion', 'SVG set missing');
    const svgFolder = resolve(saved, svgJob.result.fileName);
    const svgFiles = (await readdir(svgFolder)).filter(name => name.endsWith('.svg')).sort();
    context.assert(svgFiles.length === svgJob.pageCount, `Folder holds ${svgFiles.length} SVG pages`);
    for (const [index, name] of svgFiles.entries()) {
      const text = await readFile(resolve(svgFolder, name), 'utf8');
      const well = text.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && text.trimEnd().endsWith('</svg>');
      context.assert(well && text.includes(`data-page="${index + 1}"`) && text.includes('@font-face{font-family:alphaTab') && text.includes(`${index + 1} / ${svgJob.pageCount}`) && text.includes('<text'),
        `${name} is a standalone page SVG with embedded music font, page number and text`);
    }

    await openExportDialog(context, page, 'png');
    await chooseSelect(page, '출력 대상', '전체 트랙');
    await page.screenshot({ path: resolve(context.evidence, 'dialog-png.png') });
    const pngJob = await runExportAndCollect(context, page, 'png');
    context.assert(pngJob.pageCount === pdfJob.pageCount && pngJob.result.kind === 'saved', `PNG set written with ${pngJob.pageCount} pages`);
    if (pngJob.result.kind !== 'saved') throw new QaFailure('assertion', 'PNG set missing');
    const pngFolder = resolve(saved, pngJob.result.fileName);
    const pngFiles = (await readdir(pngFolder)).filter(name => name.endsWith('.png')).sort().map(name => resolve(pngFolder, name));
    const pngStats = await rasterStats(resolve(context.evidence, 'raster-png'), 1, pngFiles);
    const expectedWidth = Math.round(pngJob.geometry.width * 150 / 96);
    const expectedHeight = Math.round(pngJob.geometry.height * 150 / 96);
    for (const stat of pngStats) {
      context.assert(stat.width === expectedWidth && stat.height === expectedHeight, `${stat.source} is ${stat.width}×${stat.height} px at 150 dpi`);
      context.assert(stat.inkPixels > stat.width * stat.height * 0.002 && stat.transparentPixels === 0, `${stat.source} has notation ink on an opaque paper`);
    }

    const drumFolder = resolve(saved, 'drums');
    await mkdir(drumFolder, { recursive: true });
    await application.evaluate(({ dialog }, folder) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${folder}/drums.png` });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, drumFolder);
    await openExportDialog(context, page, 'png');
    await chooseSelect(page, '출력 대상', '파트 (한 트랙)');
    await chooseSelect(page, '트랙', '4. 드럼');
    await page.getByRole('checkbox', { name: '투명 배경' }).click();
    const drumJob = await runExportAndCollect(context, page, 'png');
    context.assert(drumJob.result.kind === 'saved' && drumJob.artifacts.length === drumJob.pageCount, `Drum part exported as ${drumJob.pageCount} transparent PNG page(s)`);
    if (drumJob.result.kind !== 'saved') throw new QaFailure('assertion', 'Drum part missing');
    const drumPath = drumJob.artifacts.length === 1 ? resolve(drumFolder, drumJob.result.fileName) : resolve(drumFolder, drumJob.result.fileName, basename(drumJob.artifacts[0]?.name ?? ''));
    const [drumStat] = await rasterStats(resolve(context.evidence, 'raster-drums'), 1, [drumPath]);
    if (!drumStat) throw new QaFailure('assertion', 'Drum PNG not decoded');
    context.assert(drumStat.transparentPixels > drumStat.width * drumStat.height * 0.5 && drumStat.inkPixels > 0, `Transparent drum PNG keeps alpha (${drumStat.transparentPixels} transparent px) and ink`);
    await page.screenshot({ path: resolve(context.evidence, 'after-exports.png') });
  });
};
