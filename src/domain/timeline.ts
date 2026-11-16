import { assertNever, DomainError } from './diagnostics';
import type { ScoreDocument } from './document';
import { id } from './ids';
import type { MeasureId, OccurrenceId } from './ids';
import { addQ, compareQ, isCanonicalQ, subtractQ, zeroQ } from './rational';
import type { RationalQ } from './rational';
import type { WrittenRange } from './selection';
import { validateDocumentForRead } from './validate';
import { isValidatedRoot } from './validated-root';

export type Occurrence = {
  readonly occurrenceId: OccurrenceId;
  readonly measureId: MeasureId;
  /** Sounding visit ordinal for this measure, including jumps and nested repeats. */
  readonly pass: number;
  readonly writtenStartQ: RationalQ;
  readonly playbackStartQ: RationalQ;
  readonly spanQ: RationalQ;
  readonly measureOffsetQ: RationalQ;
};
export type OccurrenceRange = {
  readonly start: { readonly occurrenceId: OccurrenceId; readonly offsetQ: RationalQ };
  readonly end: { readonly occurrenceId: OccurrenceId; readonly offsetQ: RationalQ };
};
export type CompileOptions =
  | { readonly followRepeats: false; readonly range?: WrittenRange }
  | { readonly followRepeats: true; readonly range?: OccurrenceRange };
type RepeatBlock = { readonly start: number; readonly end: number; readonly total: number };
const traversals = new WeakMap<ScoreDocument, Map<boolean, readonly Occurrence[]>>();

export function compileOccurrences(doc: ScoreDocument, options: CompileOptions): readonly Occurrence[] {
  const diagnostics = validateDocumentForRead(doc);
  if (diagnostics.length) throw new DomainError(diagnostics);
  const cached = isValidatedRoot(doc) ? traversals.get(doc) : undefined;
  let occurrences = cached?.get(options.followRepeats);
  if (!occurrences) {
    occurrences = compileTraversal(doc, options.followRepeats);
    if (isValidatedRoot(doc)) {
      const modes = cached ?? new Map<boolean, readonly Occurrence[]>();
      modes.set(options.followRepeats, occurrences);
      traversals.set(doc, modes);
    }
  }
  const reject = (message: string): never => { throw new DomainError([{ code: 'RANGE', path: 'range', message }]); };
  let range: OccurrenceRange | undefined;
  switch (options.followRepeats) {
    case true: range = options.range; break;
    case false: {
      const written = options.range;
      if (!written) break;
      const last = occurrences.at(-1);
      const totalQ = last ? addQ(last.writtenStartQ, last.spanQ) : zeroQ;
      if (!isCanonicalQ(written.startQ) || !isCanonicalQ(written.endQ) ||
        compareQ(written.startQ, zeroQ) < 0 || compareQ(written.startQ, written.endQ) >= 0 ||
        compareQ(written.endQ, totalQ) > 0) return reject('Written range is outside score or empty');
      const first = occurrences.find(visit => compareQ(addQ(visit.writtenStartQ, visit.spanQ), written.startQ) > 0);
      const end = occurrences.findLast(visit => compareQ(visit.writtenStartQ, written.endQ) < 0);
      if (!first || !end) return reject('Written range is outside score or empty');
      range = { start: { occurrenceId: first.occurrenceId, offsetQ: subtractQ(written.startQ, first.writtenStartQ) },
        end: { occurrenceId: end.occurrenceId, offsetQ: subtractQ(written.endQ, end.writtenStartQ) } };
      break;
    }
    default: return assertNever(options);
  }
  if (!range) return occurrences;
  const { start, end } = range;
  const first = occurrences.findIndex(o => o.occurrenceId === start.occurrenceId);
  const last = occurrences.findIndex(o => o.occurrenceId === end.occurrenceId);
  const firstOccurrence = occurrences[first];
  const lastOccurrence = occurrences[last];
  if (!firstOccurrence || !lastOccurrence || first > last ||
    !isCanonicalQ(start.offsetQ) || !isCanonicalQ(end.offsetQ) ||
    compareQ(start.offsetQ, zeroQ) < 0 || compareQ(end.offsetQ, zeroQ) < 0 ||
    compareQ(start.offsetQ, firstOccurrence.spanQ) >= 0 || compareQ(end.offsetQ, lastOccurrence.spanQ) > 0 ||
    (first === last && compareQ(start.offsetQ, end.offsetQ) >= 0)) return reject('Occurrence range is invalid or stale');
  let playbackStartQ = zeroQ;
  return occurrences.slice(first, last + 1).flatMap((occurrence, i, selected) => {
    const offset = i === 0 ? start.offsetQ : zeroQ;
    const limit = i === selected.length - 1 ? end.offsetQ : occurrence.spanQ;
    const spanQ = subtractQ(limit, offset);
    if (compareQ(spanQ, zeroQ) <= 0) return [];
    const clipped = { ...occurrence, writtenStartQ: addQ(occurrence.writtenStartQ, offset),
      measureOffsetQ: addQ(occurrence.measureOffsetQ, offset), playbackStartQ, spanQ };
    playbackStartQ = addQ(playbackStartQ, spanQ);
    return [clipped];
  });
}

/** One bounded arrangement per traversal mode; selecting a passage only slices this result. */
function compileTraversal(doc: ScoreDocument, followRepeats: boolean): readonly Occurrence[] {
  const starts: RationalQ[] = [];
  let totalQ = zeroQ;
  for (const measure of doc.measures) { starts.push(totalQ); totalQ = addQ(totalQ, measure.actualSpanQ); }
  const blocks = new Map<number, RepeatBlock>();
  const open: number[] = [];
  if (followRepeats) {
    for (const [i, measure] of doc.measures.entries()) {
      if (measure.repeats.start) open.push(i);
      if (measure.repeats.totalPlays !== undefined) {
        const start = open.pop() ?? 0;
        if (blocks.has(start)) throw new DomainError([{ code: 'REPEAT', path: measure.id, message: 'Overlapping implicit repeat blocks' }]);
        blocks.set(start, { start, end: i, total: measure.repeats.totalPlays });
      }
    }
    if (open.length) throw new DomainError([{ code: 'REPEAT', path: 'measures', message: 'Repeat start has no closing repeat' }]);
  }
  // Frames are local traversal state; authored document is never changed.
  const stack: { readonly block: RepeatBlock; pass: number }[] = [];
  const taken = new Set<string>();
  const passes = new Map<MeasureId, number>();
  const occurrences: Occurrence[] = [];
  let playbackQ = zeroQ;
  let cursor = 0;
  let visits = 0;
  let endingPass = 1;
  let completedEndingPass: number | undefined;
  let returning = false;
  let armed: 'end' | 'fine' | 'coda' | undefined;
  while (cursor < doc.measures.length) {
    if (++visits > 10000) throw new DomainError([{ code: 'TRAVERSAL_LIMIT', path: 'measures', message: 'Arrangement exceeds 10000 measure visits' }]);
    const measure = doc.measures[cursor];
    const writtenQ = starts[cursor];
    if (!measure || !writtenQ) throw new DomainError([{ code: 'REFERENCE', path: 'measures', message: 'Traversal target is outside score' }]);
    if (followRepeats) {
      const block = blocks.get(cursor);
      if (block && stack.at(-1)?.block !== block) stack.push({ block, pass: returning ? block.total : 1 });
    }
    const frame = stack.at(-1);
    if (measure.endings.length === 0) completedEndingPass = undefined;
    endingPass = completedEndingPass ?? frame?.pass ?? 1;
    const included = !followRepeats || measure.endings.length === 0 || measure.endings.includes(endingPass);
    if (included) {
      const measureEndQ = addQ(writtenQ, measure.actualSpanQ);
      const startQ = writtenQ;
      const endQ = measureEndQ;
      if (compareQ(startQ, endQ) < 0) {
        const pass = (passes.get(measure.id) ?? 0) + 1;
        passes.set(measure.id, pass);
        const spanQ = subtractQ(endQ, startQ);
        // Snapshot-local UUID: stable across compilations of the same traversal.
        const occurrenceId = id('occurrence', `${doc.id.slice(0, 24)}${visits.toString(16).padStart(12, '0')}`);
        occurrences.push({ occurrenceId, measureId: measure.id, pass, writtenStartQ: startQ,
          playbackStartQ: playbackQ, spanQ, measureOffsetQ: subtractQ(startQ, writtenQ) });
        playbackQ = addQ(playbackQ, spanQ);
      }
    }
    if (followRepeats && frame?.block.end === cursor) {
      if (!returning && frame.pass < frame.block.total) { frame.pass++; cursor = frame.block.start; continue; }
      endingPass = frame.pass;
      completedEndingPass = frame.pass;
      stack.pop();
    }
    let destination: number | undefined;
    let finish = false;
    if (followRepeats && included) for (const jump of measure.jumps) {
      const key = `${measure.id}:${jump.kind}`;
      switch (jump.kind) {
        case 'segno':
        case 'coda': break;
        case 'fine': finish = armed === 'fine'; break;
        case 'dc':
        case 'ds':
          if (!taken.has(key)) {
            taken.add(key);
            armed = jump.until;
            returning = true;
            stack.length = 0;
            endingPass = 1;
            completedEndingPass = undefined;
            destination = jump.kind === 'dc' ? 0 : doc.measures.findIndex(m => m.id === jump.target);
          }
          break;
        case 'toCoda':
          if (armed === 'coda' && !taken.has(key)) {
            taken.add(key);
            armed = 'end';
            destination = doc.measures.findIndex(m => m.id === jump.target);
          }
          break;
        default: assertNever(jump);
      }
    }
    if (finish) break;
    if (destination !== undefined) {
      stack.length = 0;
      completedEndingPass = undefined;
      const target = destination;
      const enclosing = [...blocks.values()].filter(block => block.start < target && target <= block.end);
      for (const block of enclosing.sort((a, b) => a.start - b.start)) stack.push({ block, pass: block.total });
    }
    cursor = destination ?? cursor + 1;
  }
  return occurrences;
}
