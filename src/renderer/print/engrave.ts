import type { rendering } from '@coderline/alphatab/core';
import type { ScoreDocument } from '../../domain/document';
import type { WrittenRange } from '../../domain/selection';
import { t } from '../i18n';
import { ScoreProjector } from '../../adapters/alphatab/project';
import { renderProjection } from '../score/render';
import { pageGeometry, PrintOptionError } from './options';
import type { PageGeometry, PrintJob } from './options';
import { measureSpan, paginate } from './paginate';
import type { MeasureSpan, PagePlan, SystemBox } from './paginate';
import type { EngravedChunk, EngravedSheet } from './pages';

export type PrintSheet = {
  readonly geometry: PageGeometry;
  readonly sheet: EngravedSheet;
  readonly systems: readonly SystemBox[];
  readonly pages: readonly PagePlan[];
  readonly span: MeasureSpan;
  readonly fit: number;
  readonly colors: { readonly paper: string; readonly ink: string };
};
export type EngraveInput = {
  readonly document: ScoreDocument;
  readonly job: PrintJob;
  readonly selection: WrittenRange | null;
};

export function systemBoxes(lookup: rendering.BoundsLookup): readonly SystemBox[] {
  return lookup.staffSystems.map(system => {
    const indexes = system.bars.map(bar => bar.index);
    return { y: system.realBounds.y, height: system.realBounds.h,
      firstMeasure: Math.min(...indexes), lastMeasure: Math.max(...indexes) };
  }).sort((a, b) => a.y - b.y);
}

function printScope(input: EngraveInput): readonly ScoreDocument['tracks'][number]['id'][] {
  const { document, job } = input;
  switch (job.scope.kind) {
    case 'score': return document.tracks.filter(track => !document.layout.hiddenTracks.includes(track.id)).map(track => track.id);
    case 'part': {
      const ids = job.scope.trackIds.filter(id => document.tracks.some(track => track.id === id));
      if (ids.length === 0) throw new PrintOptionError('scope', t('print.noParts'));
      return ids;
    }
  }
}

function printSpan(input: EngraveInput): MeasureSpan {
  switch (input.job.range.kind) {
    case 'all': return { first: 0, last: input.document.measures.length - 1 };
    case 'selection':
      if (!input.selection) throw new PrintOptionError('range', t('print.noSelection'));
      return measureSpan(input.document, input.selection);
  }
}

/**
 * Engraves the requested part and measure span onto an offscreen host at the page content width, then
 * cuts the sheet into pages between systems. The visible score view and its hit map are untouched.
 */
export async function engravePrint(input: EngraveInput, signal: AbortSignal): Promise<PrintSheet> {
  const geometry = pageGeometry(input.job.setup);
  const span = printSpan(input);
  const trackIds = printScope(input);
  const projector = new ScoreProjector();
  const projection = projector.project(input.document, trackIds);
  projection.settings.display.startBar = span.first + 1;
  projection.settings.display.barCount = span.last - span.first + 1;
  const host = document.createElement('div');
  host.className = 'print-host';
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, { position: 'fixed', left: '-200vw', top: '0', width: `${geometry.contentWidth}px`, visibility: 'hidden', pointerEvents: 'none' });
  document.body.append(host);
  try {
    const style = getComputedStyle(host);
    const colors = { paper: style.getPropertyValue('--paper').trim(), ink: style.getPropertyValue('--paper-ink').trim() };
    const result = await renderProjection({ projection, width: geometry.contentWidth, trackIndexes: projection.score.tracks.map(track => track.index),
      zoom: input.job.setup.scale, manualSpacing: (input.document.layout.eventSpacing?.length ?? 0) > 0 }, host, signal);
    if (!result) throw new DOMException('Print engraving cancelled', 'AbortError');
    const serializer = new XMLSerializer();
    const chunks: EngravedChunk[] = [...host.children].flatMap(child => {
      if (!(child instanceof SVGSVGElement)) return [];
      const x = Number.parseFloat(child.style.left) || 0;
      const y = Number.parseFloat(child.style.top) || 0;
      const width = Number.parseFloat(child.getAttribute('width') ?? '') || result.width - x;
      const height = Number.parseFloat(child.getAttribute('height') ?? '') || result.height - y;
      return [{ svg: serializer.serializeToString(child), x, y, width, height }];
    });
    const sheetWidth = Math.max(result.width, ...chunks.map(chunk => chunk.x + chunk.width));
    const fit = Math.min(1, geometry.contentWidth / sheetWidth);
    const systems = systemBoxes(result.lookup);
    const forced = new Set(input.document.layout.pageBreaks.map(id => input.document.measures.findIndex(measure => measure.id === id)).filter(index => index >= 0));
    const pages = paginate(systems.map(system => ({ ...system, y: system.y * fit, height: system.height * fit })),
      { height: result.height * fit, contentHeight: geometry.contentHeight }, forced)
      .map(page => ({ ...page, top: page.top / fit, bottom: page.bottom / fit }));
    return { geometry, sheet: { chunks, width: sheetWidth, height: result.height }, systems, pages, span, fit, colors };
  } finally {
    host.remove();
  }
}
