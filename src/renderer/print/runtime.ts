import type { ScoreDocument } from '../../domain/document';
import { t } from '../i18n';
import type { PrintPagesResult } from '../../main/print';
import type { ExportResult } from '../../preload/export-contract';
import { rangeOf, selectionStore } from '../editor/selection-state';
import type { ShellServices } from '../shell/services';
import { normalizeCommandError } from '../state/command-errors';
import { engravePrint } from './engrave';
import type { PrintSheet } from './engrave';
import { defaultImageOptions, defaultPageSetup, parseImageOptions, parsePageSetup, PrintOptionError } from './options';
import type { ImageOptions, OutputFormat, PageSetup, PrintJob, PrintRange, PrintScope } from './options';
import { buildPageSvg } from './pages';
import { musicFontDataUrl, rasterizePage } from './raster';

/** `print` sends pages to the OS print dialog; the file formats go through the export bridge. */
export type PrintTarget = OutputFormat | 'print';
export type ExportDialog = { readonly kind: 'export'; readonly format: OutputFormat; readonly intent: 'file' | 'print' };
export type PrintDialog = { readonly kind: 'pageSetup'; readonly returnTo?: ExportDialog } | ExportDialog;
export type PrintArtifact = { readonly name: string; readonly format: OutputFormat; readonly bytes: Uint8Array };
export type PrintJobReport = {
  readonly format: PrintTarget;
  readonly pageCount: number;
  readonly span: PrintSheet['span'];
  readonly fit: number;
  readonly geometry: PrintSheet['geometry'];
  readonly pages: PrintSheet['pages'];
  readonly systems: PrintSheet['systems'];
  readonly artifacts: readonly PrintArtifact[];
  readonly result: ExportResult | PrintPagesResult;
};
export type PrintState = {
  readonly setup: PageSetup;
  readonly image: ImageOptions;
  readonly dialog: PrintDialog | null;
  readonly busy: boolean;
  readonly message: { readonly tone: 'error' | 'success' | 'info'; readonly text: string } | null;
  readonly lastJob: PrintJobReport | null;
};
export type PrintJobInput = { readonly scope: PrintScope; readonly range: PrintRange; readonly image: ImageOptions };

const fileStem = (document: ScoreDocument): string => (document.metadata.title.trim() || t('print.fileStem')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
const mmLabel = (value: number): string => String(Math.round(value * 10) / 10);

/** Print state, page setup and output commands; artifacts leave through the shared export bridge only. */
export class PrintRuntime {
  private state: PrintState = { setup: defaultPageSetup, image: defaultImageOptions, dialog: null, busy: false, message: null, lastJob: null };
  private readonly listeners = new Set<() => void>();
  private mounts = 0;
  private releases: readonly (() => void)[] = [];
  private controller: AbortController | null = null;
  constructor(private readonly services: ShellServices) {}
  getSnapshot = (): PrintState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<PrintState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    this.services.registry.changed();
  }
  openDialog(dialog: PrintDialog): void { this.publish({ dialog, message: null }); }
  private returnDialog(): PrintDialog | null { return this.state.dialog?.kind === 'pageSetup' ? this.state.dialog.returnTo ?? null : null; }
  closeDialog = (): void => { this.publish({ dialog: this.returnDialog() }); };
  /** Rejects invalid paper/margins/scale before anything is laid out; the previous setup stays in force. */
  applyPageSetup(setup: PageSetup): void {
    this.publish({ setup: parsePageSetup(setup), dialog: this.returnDialog(), message: null });
  }
  hasSelectionRange(): boolean {
    const selection = selectionStore.getSnapshot().selection;
    return selection !== null && rangeOf(selection) !== null;
  }
  activeDocument(): ScoreDocument | null { return this.services.documents.getSnapshot().active?.project.score ?? null; }
  defaultScope(): PrintScope {
    const document = this.activeDocument();
    const track = document?.tracks[Math.min(this.services.workspace.getSnapshot().activeTrackIndex, (document?.tracks.length ?? 1) - 1)];
    return track ? { kind: 'part', trackIds: [track.id] } : { kind: 'score' };
  }

  async run(target: PrintTarget, input: PrintJobInput): Promise<PrintJobReport | null> {
    const active = this.services.documents.getSnapshot().active;
    if (!active || this.state.busy) return null;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ busy: true, message: null, image: input.image });
    try {
      const format: OutputFormat = target === 'print' ? 'pdf' : target;
      const job: PrintJob = { format, setup: parsePageSetup(this.state.setup), scope: input.scope, range: input.range, image: parseImageOptions(input.image) };
      const selection = selectionStore.getSnapshot().selection;
      const sheet = await engravePrint({ document: active.project.score, job, selection: selection ? rangeOf(selection) : null }, controller.signal);
      const title = active.project.score.metadata.title || t('print.untitled');
      const fontDataUrl = format === 'pdf' ? undefined : await musicFontDataUrl();
      const svgPages = sheet.pages.map((plan, index) => buildPageSvg({ geometry: sheet.geometry, sheet: sheet.sheet, plan, fit: sheet.fit,
        pageNumber: index + 1, pageCount: sheet.pages.length, title, transparent: format === 'png' && job.image.transparent, colors: sheet.colors,
        ...(fontDataUrl === undefined ? {} : { fontDataUrl }) }));
      const stem = fileStem(active.project.score);
      const page = { title, widthMm: sheet.geometry.widthMm, heightMm: sheet.geometry.heightMm, pages: svgPages };
      const artifacts = target === 'print' ? [] : await this.artifacts(target, { svgPages, stem, sheet, job, page, token: active.documentToken });
      if (controller.signal.aborted) return null;
      const result = target === 'print' ? await window.desktop.printPages(active.documentToken, page)
        : await this.deliver(target, artifacts, { stem, token: active.documentToken });
      const report: PrintJobReport = { format: target, pageCount: sheet.pages.length, span: sheet.span, fit: sheet.fit, geometry: sheet.geometry,
        pages: sheet.pages, systems: sheet.systems, artifacts, result };
      const paper = t('print.paperSummary', { pages: sheet.pages.length, size: `${mmLabel(sheet.geometry.widthMm)}×${mmLabel(sheet.geometry.heightMm)}` });
      const message = ((): PrintState['message'] => {
        switch (result.kind) {
          case 'saved': return { tone: 'success', text: t('print.saved', { fileName: result.fileName, paper }) };
          case 'printed': return { tone: 'success', text: t('print.printed', { paper }) };
          case 'cancelled': return { tone: 'info', text: target === 'print' ? t('print.printCancelled') : t('print.saveCancelled') };
          case 'failed': return { tone: 'error', text: normalizeCommandError(result.message).message };
        }
      })();
      this.publish({ lastJob: report, dialog: result.kind === 'saved' || result.kind === 'printed' ? null : this.state.dialog, message });
      return report;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      if (!(error instanceof Error)) throw error;
      this.publish({ message: { tone: 'error', text: error instanceof PrintOptionError ? error.message : t('print.failed', { message: normalizeCommandError(error.message).message }) } });
      return null;
    } finally {
      if (this.controller === controller) { this.controller = null; this.publish({ busy: false }); }
    }
  }

  private async artifacts(format: OutputFormat, input: { readonly svgPages: readonly string[]; readonly stem: string; readonly sheet: PrintSheet;
    readonly job: PrintJob; readonly page: Parameters<Window['desktop']['printPdf']>[1]; readonly token: Parameters<Window['desktop']['printPdf']>[0] }): Promise<readonly PrintArtifact[]> {
    const pageName = (index: number, extension: string): string =>
      input.svgPages.length === 1 ? `${input.stem}.${extension}` : `${input.stem}-${String(index + 1).padStart(2, '0')}.${extension}`;
    switch (format) {
      case 'pdf': {
        const rendered = await window.desktop.printPdf(input.token, input.page);
        return [{ name: `${input.stem}.pdf`, format, bytes: rendered.bytes }];
      }
      case 'svg': return input.svgPages.map((svg, index) => ({ name: pageName(index, 'svg'), format, bytes: new TextEncoder().encode(svg) }));
      case 'png': {
        const pages: PrintArtifact[] = [];
        for (const [index, svg] of input.svgPages.entries()) {
          pages.push({ name: pageName(index, 'png'), format,
            bytes: await rasterizePage({ svg, width: input.sheet.geometry.width, height: input.sheet.geometry.height, dpi: input.job.image.dpi }) });
        }
        return pages;
      }
    }
  }

  private deliver(format: OutputFormat, artifacts: readonly PrintArtifact[], input: { readonly stem: string; readonly token: Parameters<Window['desktop']['printPdf']>[0] }): Promise<ExportResult> {
    const single = artifacts.length === 1 ? artifacts[0] : undefined;
    if (single) return window.desktop.exportArtifact({ documentToken: input.token, format, suggestedName: input.stem, bytes: single.bytes });
    return window.desktop.exportArtifactSet({ documentToken: input.token, format, suggestedFolder: `${input.stem} ${format.toUpperCase()}`,
      files: artifacts.map(artifact => ({ name: artifact.name, bytes: artifact.bytes })) });
  }

  mount(): () => void {
    this.mounts++;
    if (this.mounts === 1) {
      const { registry, documents } = this.services;
      const open = (): boolean => documents.getSnapshot().active !== null && !this.state.busy;
      const handlers: Readonly<Record<string, { readonly execute: () => void; readonly enabled: () => boolean }>> = {
        'file.pageSetup': { enabled: open, execute: () => this.openDialog({ kind: 'pageSetup' }) },
        'file.print': { enabled: open, execute: () => this.openDialog({ kind: 'export', format: 'pdf', intent: 'print' }) },
        'file.export.pdf': { enabled: open, execute: () => this.openDialog({ kind: 'export', format: 'pdf', intent: 'file' }) },
        'file.export.png': { enabled: open, execute: () => this.openDialog({ kind: 'export', format: 'png', intent: 'file' }) },
        'file.export.svg': { enabled: open, execute: () => this.openDialog({ kind: 'export', format: 'svg', intent: 'file' }) },
      };
      const releases = Object.entries(handlers).map(([id, handler]) => registry.register(id, handler));
      releases.push(documents.subscribe(() => registry.changed()));
      this.releases = releases;
      if (window.desktop?.qa) Object.defineProperty(window, 'fretlinePrintObservation', { configurable: true, value: (): PrintObservation => {
        const { lastJob, ...state } = this.state;
        return { ...state, lastJob: lastJob ? { ...lastJob, artifacts: lastJob.artifacts.map(artifact => ({ name: artifact.name, format: artifact.format,
          byteLength: artifact.bytes.length, base64: btoa(Array.from(artifact.bytes, byte => String.fromCharCode(byte)).join('')) })) } : null };
      } });
    }
    return () => {
      if (--this.mounts === 0) {
        this.controller?.abort();
        for (const release of this.releases) release();
        this.releases = [];
        if (window.desktop?.qa) Reflect.deleteProperty(window, 'fretlinePrintObservation');
      }
    };
  }
}
export type PrintObservation = Omit<PrintState, 'lastJob'> & { readonly lastJob: (Omit<PrintJobReport, 'artifacts'> & {
  readonly artifacts: readonly { readonly name: string; readonly format: OutputFormat; readonly byteLength: number; readonly base64: string }[] }) | null };
declare global { interface Window { readonly fretlinePrintObservation?: () => PrintObservation } }

const runtimes = new WeakMap<ShellServices, PrintRuntime>();
export function printRuntime(services: ShellServices): PrintRuntime {
  const existing = runtimes.get(services);
  if (existing) return existing;
  const runtime = new PrintRuntime(services);
  runtimes.set(services, runtime);
  return runtime;
}
