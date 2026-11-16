import type { TrackId } from '../../domain/ids';
import { t } from '../i18n';

/** Paper presets in millimetres (portrait). `custom` carries explicit dimensions. */
export const paperPresets = {
  A4: { widthMm: 210, heightMm: 297 },
  A3: { widthMm: 297, heightMm: 420 },
  A5: { widthMm: 148, heightMm: 210 },
  B5: { widthMm: 176, heightMm: 250 },
  Letter: { widthMm: 215.9, heightMm: 279.4 },
  Legal: { widthMm: 215.9, heightMm: 355.6 },
} as const;
export type PaperName = keyof typeof paperPresets;
export const paperNames = Object.keys(paperPresets) as readonly PaperName[];
export type Paper = { readonly name: PaperName } | { readonly name: 'custom'; readonly widthMm: number; readonly heightMm: number };
export type Orientation = 'portrait' | 'landscape';
export type MarginsMm = { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
/** User-facing page setup; every field is validated by `parsePageSetup` before layout. */
export type PageSetup = {
  readonly paper: Paper;
  readonly orientation: Orientation;
  readonly marginsMm: MarginsMm;
  /** Engraving scale relative to the stylesheet (0.5–2.0); independent of the on-screen zoom. */
  readonly scale: number;
};
export type PrintScope = { readonly kind: 'part'; readonly trackIds: readonly TrackId[] } | { readonly kind: 'score' };
export type PrintRange = { readonly kind: 'all' } | { readonly kind: 'selection' };
export type ImageOptions = { readonly dpi: number; readonly transparent: boolean };
export type OutputFormat = 'pdf' | 'png' | 'svg';
export type PrintJob = {
  readonly format: OutputFormat;
  readonly setup: PageSetup;
  readonly scope: PrintScope;
  readonly range: PrintRange;
  readonly image: ImageOptions;
};

export const defaultPageSetup: PageSetup = {
  paper: { name: 'A4' }, orientation: 'portrait', marginsMm: { top: 15, right: 12, bottom: 15, left: 12 }, scale: 1,
};
export const defaultImageOptions: ImageOptions = { dpi: 150, transparent: false };
export const scaleLimits = { min: 0.5, max: 2 } as const;
export const dpiLimits = { min: 72, max: 600 } as const;
export const paperLimitsMm = { min: 50, max: 1200 } as const;
/** Narrower content than this cannot hold one bar of tablature at scale 0.5. */
export const minimumContentMm = { width: 60, height: 40 } as const;
export const cssPxPerMm = 96 / 25.4;

export class PrintOptionError extends RangeError {
  constructor(readonly field: 'paper' | 'margins' | 'scale' | 'dpi' | 'range' | 'scope', message: string) {
    super(message);
    this.name = 'PrintOptionError';
  }
}

const finite = (value: number, field: PrintOptionError['field'], label: string): number => {
  if (!Number.isFinite(value)) throw new PrintOptionError(field, t('print.notNumber', { label }));
  return value;
};

/** Paper dimensions in mm after orientation. */
export function paperSizeMm(setup: Pick<PageSetup, 'paper' | 'orientation'>): { readonly widthMm: number; readonly heightMm: number } {
  const base = setup.paper.name === 'custom' ? { widthMm: setup.paper.widthMm, heightMm: setup.paper.heightMm } : paperPresets[setup.paper.name];
  const portrait = { widthMm: Math.min(base.widthMm, base.heightMm), heightMm: Math.max(base.widthMm, base.heightMm) };
  return setup.orientation === 'portrait' ? portrait : { widthMm: portrait.heightMm, heightMm: portrait.widthMm };
}

/** Validates a page setup; throws `PrintOptionError` with a user-facing localized message. */
export function parsePageSetup(setup: PageSetup): PageSetup {
  if (setup.paper.name === 'custom') {
    for (const [label, value] of [[t('print.paperWidth'), setup.paper.widthMm], [t('print.paperHeight'), setup.paper.heightMm]] as const) {
      if (finite(value, 'paper', label) < paperLimitsMm.min || value > paperLimitsMm.max) {
        throw new PrintOptionError('paper', t('print.paperRange', { label, min: paperLimitsMm.min, max: paperLimitsMm.max }));
      }
    }
  }
  const { widthMm, heightMm } = paperSizeMm(setup);
  const margins = setup.marginsMm;
  for (const [label, value] of [[t('print.top'), margins.top], [t('print.right'), margins.right], [t('print.bottom'), margins.bottom], [t('print.left'), margins.left]] as const) {
    if (finite(value, 'margins', t('print.margin', { side: label })) < 0) throw new PrintOptionError('margins', t('print.marginNegative', { side: label }));
  }
  if (finite(setup.scale, 'scale', t('print.scale')) < scaleLimits.min || setup.scale > scaleLimits.max) {
    throw new PrintOptionError('scale', t('print.scaleRange', { min: scaleLimits.min * 100, max: scaleLimits.max * 100 }));
  }
  const contentWidth = widthMm - margins.left - margins.right;
  const contentHeight = heightMm - margins.top - margins.bottom;
  if (contentWidth < minimumContentMm.width || contentHeight < minimumContentMm.height) {
    throw new PrintOptionError('margins', t('print.contentTooSmall', { width: minimumContentMm.width, height: minimumContentMm.height }));
  }
  return setup;
}

export function parseImageOptions(options: ImageOptions): ImageOptions {
  if (!Number.isInteger(options.dpi) || options.dpi < dpiLimits.min || options.dpi > dpiLimits.max) {
    throw new PrintOptionError('dpi', t('print.dpiRange', { min: dpiLimits.min, max: dpiLimits.max }));
  }
  return options;
}

export type PageGeometry = {
  readonly widthMm: number;
  readonly heightMm: number;
  /** CSS px at 96 dpi; the engraver lays systems out to `contentWidth`. */
  readonly width: number;
  readonly height: number;
  readonly contentX: number;
  readonly contentY: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
};
export function pageGeometry(setup: PageSetup): PageGeometry {
  const parsed = parsePageSetup(setup);
  const { widthMm, heightMm } = paperSizeMm(parsed);
  const px = (mm: number): number => Math.round(mm * cssPxPerMm * 100) / 100;
  const contentX = px(parsed.marginsMm.left);
  const contentY = px(parsed.marginsMm.top);
  return { widthMm, heightMm, width: px(widthMm), height: px(heightMm), contentX, contentY,
    contentWidth: px(widthMm) - contentX - px(parsed.marginsMm.right), contentHeight: px(heightMm) - contentY - px(parsed.marginsMm.bottom) };
}
