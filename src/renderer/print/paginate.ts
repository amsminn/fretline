import type { ScoreDocument } from '../../domain/document';
import { addQ, compareQ, zeroQ } from '../../domain/rational';
import type { WrittenRange } from '../../domain/selection';
import { t } from '../i18n';
import { PrintOptionError } from './options';

export type SystemBox = {
  readonly y: number;
  readonly height: number;
  /** Zero-based document measure indexes covered by the system. */
  readonly firstMeasure: number;
  readonly lastMeasure: number;
};
export type PagePlan = {
  readonly systems: readonly number[];
  /** Vertical slice of the engraved sheet shown on this page, in engraved px. */
  readonly top: number;
  readonly bottom: number;
};
export type MeasureSpan = { readonly first: number; readonly last: number };

/** Inclusive measure indexes whose written time overlaps the half-open selection range. */
export function measureSpan(doc: ScoreDocument, range: WrittenRange): MeasureSpan {
  let first = -1;
  let last = -1;
  let startQ = zeroQ;
  doc.measures.forEach((measure, index) => {
    const endQ = addQ(startQ, measure.actualSpanQ);
    if (compareQ(endQ, range.startQ) > 0 && compareQ(startQ, range.endQ) < 0) {
      if (first < 0) first = index;
      last = index;
    }
    startQ = endQ;
  });
  if (first < 0) throw new PrintOptionError('range', t('print.noBarsInRange'));
  return { first, last };
}

/**
 * Pages cut just below a system (inside the white gap, before anything engraved above the next system
 * such as chord names or tempo marks), so a system never straddles a page. A `forcedBreaks` entry
 * (document page break before a system's first measure) always starts a page.
 */
const cutPadding = 8;
export function paginate(systems: readonly SystemBox[], sheet: { readonly height: number; readonly contentHeight: number },
  forcedBreaks: ReadonlySet<number> = new Set()): readonly PagePlan[] {
  if (systems.length === 0) return [{ systems: [], top: 0, bottom: Math.min(sheet.height, sheet.contentHeight) }];
  const cutAfter = (index: number): number => {
    const current = systems[index];
    const next = systems[index + 1];
    if (!current) throw new RangeError('System index out of range');
    const bottom = current.y + current.height;
    if (!next) return Math.max(sheet.height, bottom);
    const gap = next.y - bottom;
    return gap <= 0 ? (bottom + next.y) / 2 : bottom + Math.min(cutPadding, gap / 4);
  };
  const pages: PagePlan[] = [];
  let page: number[] = [];
  let top = 0;
  systems.forEach((system, index) => {
    const bottom = cutAfter(index);
    const breakBefore = page.length > 0 && forcedBreaks.has(system.firstMeasure);
    if (page.length > 0 && (breakBefore || bottom - top > sheet.contentHeight)) {
      pages.push({ systems: page, top, bottom: cutAfter(index - 1) });
      page = [];
      top = cutAfter(index - 1);
    }
    if (bottom - top > sheet.contentHeight) {
      throw new PrintOptionError('paper', t('print.systemTooTall', { bar: system.firstMeasure + 1 }));
    }
    page.push(index);
  });
  pages.push({ systems: page, top, bottom: cutAfter(systems.length - 1) });
  return pages;
}
