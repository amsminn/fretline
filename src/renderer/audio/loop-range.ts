import { addQ, compareQ, subtractQ } from '../../domain/rational';
import type { RationalQ } from '../../domain/rational';
import type { Selection, WrittenRange } from '../../domain/selection';
import type { ScoreDocument } from '../../domain/document';
import { compileOccurrences } from '../../domain/timeline';
import type { CompileOptions } from '../../domain/timeline';
export { LoopClock } from './transport';

export const quarters = (q: RationalQ): number => Number(q.n) / Number(q.d);
export function clampWritten(position: RationalQ, range: WrittenRange | null): RationalQ {
  return !range ? position : compareQ(position, range.startQ) < 0 ? range.startQ :
    compareQ(position, range.endQ) >= 0 ? range.endQ : position;
}
export function rangeTraversal(document: ScoreDocument | null, loop: { readonly range: WrittenRange | null; readonly followRepeats: boolean }, selection: Selection | null): CompileOptions {
  const range = loop.range;
  if (!range) return { followRepeats: true };
  if (!loop.followRepeats || !document) return { followRepeats: false, range };
  const forward = !selection || compareQ(selection.anchor.startQ, selection.focus.startQ) <= 0;
  const startId = (forward ? selection?.anchor : selection?.focus)?.occurrenceId;
  const endId = (forward ? selection?.focus : selection?.anchor)?.occurrenceId;
  const visits = compileOccurrences(document, { followRepeats: true });
  const first = visits.find(visit => compareQ(range.startQ, visit.writtenStartQ) >= 0 &&
    compareQ(range.startQ, addQ(visit.writtenStartQ, visit.spanQ)) < 0 && (!startId || visit.occurrenceId === startId));
  const last = visits.findLast(visit => compareQ(range.endQ, visit.writtenStartQ) > 0 &&
    compareQ(range.endQ, addQ(visit.writtenStartQ, visit.spanQ)) <= 0 && (!endId || visit.occurrenceId === endId));
  if (!first || !last) throw new RangeError('Selected occurrence endpoints are unavailable');
  return { followRepeats: true, range: {
    start: { occurrenceId: first.occurrenceId, offsetQ: subtractQ(range.startQ, first.writtenStartQ) },
    end: { occurrenceId: last.occurrenceId, offsetQ: subtractQ(range.endQ, last.writtenStartQ) },
  } };
}
export function arrangementTick(document: ScoreDocument, point: RationalQ): number {
  const visit = compileOccurrences(document, { followRepeats: true }).find(visit =>
    compareQ(point, visit.writtenStartQ) >= 0 && compareQ(point, addQ(visit.writtenStartQ, visit.spanQ)) < 0);
  return visit ? quarters(addQ(visit.playbackStartQ, subtractQ(point, visit.writtenStartQ))) * 960 : 0;
}

export { MixedEngine as RangeSynth } from './mixed-engine';

