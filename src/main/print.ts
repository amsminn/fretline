import { BrowserWindow, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageError } from '../domain/project';
import { describeFailure } from './export-stream';
import { t } from '../renderer/i18n';

export type PrintPdfRequest = {
  readonly title: string;
  readonly widthMm: number;
  readonly heightMm: number;
  /** One self-contained `<svg>` document per page, in order. */
  readonly pages: readonly string[];
};
export type PrintPdfResult = { readonly kind: 'rendered'; readonly bytes: Uint8Array; readonly pageCount: number };
export type PrintPagesResult = { readonly kind: 'printed'; readonly pageCount: number } | { readonly kind: 'cancelled' } | { readonly kind: 'failed'; readonly message: string };
/** What a QA run records instead of presenting the OS print dialog (`FRETLINE_QA_PRINT_REQUESTS`, JSON array). */
export type QaPrintRecord = { readonly title: string; readonly pageCount: number; readonly widthMm: number; readonly heightMm: number; readonly landscape: boolean };

export const printLimits = { maxPages: 500, maxBytesPerPage: 16 * 1024 ** 2, maxTotalBytes: 256 * 1024 ** 2 } as const;
export const qaPrintRequestsVariable = 'FRETLINE_QA_PRINT_REQUESTS';
const printScheme = 'fretline-print';
const jobs = new Map<string, { readonly html: string }>();
const directory = dirname(fileURLToPath(import.meta.url));
let fontBytes: Promise<Buffer> | undefined;
const musicFontDataUrl = async (): Promise<string> => `data:font/woff2;base64,${(await (fontBytes ??= readFile(join(directory, '../renderer/font/Bravura.woff2')))).toString('base64')}`;
const escapeHtml = (text: string): string => text.replace(/[<>&"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[character] ?? character);

export function parsePrintPdfRequest(input: unknown): PrintPdfRequest {
  if (typeof input !== 'object' || input === null || !('title' in input) || !('widthMm' in input) || !('heightMm' in input) || !('pages' in input)) {
    throw new StorageError('SCHEMA', t('main.print.invalidRequest'));
  }
  const { title, widthMm, heightMm, pages } = input;
  if (typeof title !== 'string' || title.length > 512) throw new StorageError('SCHEMA', t('main.print.invalidTitle'));
  const paperMm = (size: unknown): number => {
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 50 || size > 1200) throw new StorageError('SCHEMA', t('main.print.invalidPaper'));
    return size;
  };
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > printLimits.maxPages) throw new StorageError('LIMIT', t('main.print.pageCount', { max: printLimits.maxPages }));
  let total = 0;
  const svgPages = pages.map((page: unknown): string => {
    if (typeof page !== 'string' || !page.startsWith('<svg') || page.length > printLimits.maxBytesPerPage) throw new StorageError('SCHEMA', t('main.print.invalidSvg'));
    if (/<script|<foreignObject|\shref=(["'])(?!#|data:)/i.test(page)) throw new StorageError('SCHEMA', t('main.print.disallowedSvg'));
    total += page.length;
    return page;
  });
  if (total > printLimits.maxTotalBytes) throw new StorageError('LIMIT', t('main.print.tooLarge'));
  return { title, widthMm: paperMm(widthMm), heightMm: paperMm(heightMm), pages: svgPages };
}

export function printDocumentHtml(request: PrintPdfRequest, fontUrl: string): string {
  const size = `${request.widthMm}mm ${request.heightMm}mm`;
  const pages = request.pages.map((svg, index) =>
    `<section class="page"${index === request.pages.length - 1 ? '' : ' style="break-after:page"'}>${svg}</section>`).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(request.title)}</title><style>`
    + `@font-face{font-family:alphaTab;src:url("${fontUrl}") format("woff2");font-display:block}`
    + `@page{size:${size};margin:0}html,body{margin:0;padding:0}`
    + `.page{width:${request.widthMm}mm;height:${request.heightMm}mm;overflow:hidden;position:relative}`
    + `.page>svg{display:block;width:${request.widthMm}mm;height:${request.heightMm}mm}`
    + `</style></head><body>${pages}</body></html>`;
}

function installProtocol(partition: string): void {
  const printSession = session.fromPartition(partition);
  if (printSession.protocol.isProtocolHandled(printScheme)) return;
  printSession.protocol.handle(printScheme, async request => {
    const url = new URL(request.url);
    const job = jobs.get(url.hostname);
    if (!job) return new Response(null, { status: 404 });
    if (url.pathname !== '/') return new Response(null, { status: 404 });
    return new Response(job.html, { headers: { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:" } });
  });
}

type PrintWindowOptions = { readonly parent?: BrowserWindow; readonly width: number; readonly height: number };
/** Loads the paginated pages into an isolated hidden window with the music font ready; the caller decides what to do with it. */
async function withPrintWindow<T>(request: PrintPdfRequest, options: PrintWindowOptions, operation: (window: BrowserWindow) => Promise<T>): Promise<T> {
  const jobId = randomUUID();
  const partition = `${printScheme}-${jobId}`;
  installProtocol(partition);
  jobs.set(jobId, { html: printDocumentHtml(request, await musicFontDataUrl()) });
  const window = new BrowserWindow({
    show: false, width: options.width, height: options.height, title: t('main.print.windowTitle', { title: request.title }),
    ...(options.parent ? { parent: options.parent, modal: true } : {}),
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
  });
  try {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    await window.loadURL(`${printScheme}://${jobId}/`);
    const fontReady: unknown = await window.webContents.executeJavaScript('document.fonts.load("12px alphaTab").then(() => document.fonts.ready).then(() => document.fonts.check("12px alphaTab"))', true);
    if (fontReady !== true) throw new StorageError('ARCHIVE', t('main.print.fontFailed'));
    return await operation(window);
  } finally {
    jobs.delete(jobId);
    if (!window.isDestroyed()) window.destroy();
  }
}

/** Renders page SVGs to PDF bytes in a hidden, isolated window; nothing is written to disk here. */
export function renderPdf(request: PrintPdfRequest): Promise<PrintPdfResult> {
  return withPrintWindow(request, { width: 800, height: 600 }, async window => {
    const bytes = await window.webContents.printToPDF({
      pageSize: { width: request.widthMm / 25.4, height: request.heightMm / 25.4 },
      margins: { top: 0, right: 0, bottom: 0, left: 0 }, printBackground: true, preferCSSPageSize: true,
    });
    return { kind: 'rendered', bytes: new Uint8Array(bytes), pageCount: request.pages.length };
  });
}

const qaRun = (): boolean => process.env['FRETLINE_QA'] === '1';
function recordQaPrint(record: QaPrintRecord): void {
  const previous: unknown = JSON.parse(process.env[qaPrintRequestsVariable] ?? '[]');
  process.env[qaPrintRequestsVariable] = JSON.stringify([...(Array.isArray(previous) ? previous : []), record]);
}
const microns = (mm: number): number => Math.round(mm * 1000);

/**
 * Prints the same paginated pages through the OS print dialog (never silent). The pages are shown in a modal
 * child of the active window while the dialog is open, because macOS attaches the print panel to that window.
 * Under FRETLINE_QA the dialog boundary is replaced by a record of the request; everything before it is production code.
 */
export function printPages(request: PrintPdfRequest, parent: BrowserWindow | undefined): Promise<PrintPagesResult> {
  const landscape = request.widthMm > request.heightMm;
  const portrait = { widthMm: Math.min(request.widthMm, request.heightMm), heightMm: Math.max(request.widthMm, request.heightMm) };
  const preview = { width: Math.min(900, Math.round(request.widthMm * 2.6) + 40), height: Math.min(900, Math.round(request.heightMm * 2.6) + 40) };
  return withPrintWindow(request, { ...preview, ...(qaRun() || !parent ? {} : { parent }) }, window => new Promise<PrintPagesResult>(resolve => {
    if (qaRun()) {
      recordQaPrint({ title: request.title, pageCount: request.pages.length, widthMm: request.widthMm, heightMm: request.heightMm, landscape });
      resolve({ kind: 'printed', pageCount: request.pages.length });
      return;
    }
    window.show();
    window.webContents.print({
      silent: false, printBackground: true, landscape, margins: { marginType: 'none' },
      pageSize: { width: microns(portrait.widthMm), height: microns(portrait.heightMm) },
    }, (success, failureReason) => {
      if (success) resolve({ kind: 'printed', pageCount: request.pages.length });
      else if (/cancel/i.test(failureReason)) resolve({ kind: 'cancelled' });
      else resolve({ kind: 'failed', message: describeFailure(new Error(failureReason)) });
    });
  }));
}

export type PrintHandlerBinder = (channel: string, count: number, operation: (event: IpcMainInvokeEvent, args: readonly unknown[]) => unknown) => void;
export function registerPrintHandlers(handle: PrintHandlerBinder, assertDocument: (event: IpcMainInvokeEvent, token: unknown) => void): void {
  handle('print-pdf', 2, (event, args) => {
    assertDocument(event, args[0]);
    return renderPdf(parsePrintPdfRequest(args[1]));
  });
  handle('print-pages', 2, async (event, args): Promise<PrintPagesResult> => {
    try {
      assertDocument(event, args[0]);
      return await printPages(parsePrintPdfRequest(args[1]), BrowserWindow.fromWebContents(event.sender) ?? undefined);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { kind: 'failed', message: describeFailure(error) };
    }
  });
}
