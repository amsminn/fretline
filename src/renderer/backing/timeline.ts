import type { ScoreDocument } from '../../domain/document';
import type { MeasureId } from '../../domain/ids';
import type { RationalQ } from '../../domain/rational';
import { addQ, compareQ, rationalQ, subtractQ } from '../../domain/rational';
import type { SyncPoint } from '../../domain/commands/sync-points';
import { buildPlayback, LoopClock } from '../audio/transport';
import { t } from '../i18n';

export type GridMeasure = {
  readonly id: MeasureId;
  readonly index: number;
  readonly mediaStart: number;
  readonly mediaEnd: number;
  readonly beats: readonly number[];
};
export type BackingGrid = {
  readonly measures: readonly GridMeasure[];
  readonly mediaOf: (measureId: MeasureId, offsetQ: RationalQ) => number | null;
  readonly positionAt: (writtenQ: RationalQ) => { readonly measureId: MeasureId; readonly offsetQ: RationalQ } | null;
};

/** Written-order grid (one pass per measure) in media seconds under the given document's anchors. */
export function backingGrid(score: ScoreDocument): BackingGrid {
  const build = buildPlayback(score, { followRepeats: false });
  const clock = new LoopClock(build, 1);
  const division = build.file.division;
  const mediaAt = (tick: number): number => clock.seconds(tick) + build.mediaOffset;
  const measures: GridMeasure[] = build.generator.tickLookup.masterBars.flatMap((bar, index) => {
    const visit = build.projection.occurrences[index];
    const measure = score.measures.find(candidate => candidate.id === visit?.measureId);
    if (!visit || !measure) return [];
    const unit = division * 4 / bar.masterBar.timeSignatureDenominator;
    const beats: number[] = [];
    for (let tick = bar.start + unit; tick < bar.end; tick += unit) beats.push(mediaAt(tick));
    return [{ id: measure.id, index: score.measures.indexOf(measure), mediaStart: mediaAt(bar.start), mediaEnd: mediaAt(bar.end), beats }];
  });
  const starts = new Map(measures.map(entry => [entry.id, build.generator.tickLookup.masterBars[measures.indexOf(entry)]?.start ?? 0]));
  return {
    measures,
    mediaOf: (measureId, offsetQ) => {
      const start = starts.get(measureId);
      return start === undefined ? null : mediaAt(start + Number(offsetQ.n) / Number(offsetQ.d) * division);
    },
    positionAt: writtenQ => {
      let cursor = rationalQ(0n);
      for (const measure of score.measures) {
        const end = addQ(cursor, measure.actualSpanQ);
        if (compareQ(writtenQ, cursor) >= 0 && compareQ(writtenQ, end) < 0) return { measureId: measure.id, offsetQ: subtractQ(writtenQ, cursor) };
        cursor = end;
      }
      return null;
    },
  };
}

export const describeSyncPoint = (score: ScoreDocument, point: SyncPoint): string => {
  const index = score.measures.findIndex(measure => measure.id === point.measureId);
  const offset = Number(point.offsetQ.n) / Number(point.offsetQ.d);
  return t('backing.syncPoint', { bar: index + 1, pass: point.pass > 1 ? t('backing.syncPoint.pass', { pass: point.pass }) : '', offset: offset > 0 ? t('backing.syncPoint.offset', { offset: offset.toFixed(2) }) : '', seconds: point.mediaSeconds.toFixed(2) });
};
