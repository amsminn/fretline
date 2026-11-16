import type { EventId, TupletId } from '../../domain/ids';
import { newId } from '../../domain/ids';
import { addQ, compareQ, durationQ, multiplyQ, rationalQ, zeroQ } from '../../domain/rational';
import type { RationalQ } from '../../domain/rational';
import type { Relations } from './notes';
import { child, children, InterchangeError, number, text } from './xml';
import type { XmlElement } from './xml';

export const noteTypes = new Map([
  ['whole', 1], ['half', 2], ['quarter', 4], ['eighth', 8], ['16th', 16],
  ['32nd', 32], ['64th', 64], ['128th', 128], ['256th', 256], ['512th', 512], ['1024th', 1024],
]);
/** Mutable groups exist only while the imported lane is being assembled. */
export type ImportedTuplet = {
  readonly id: TupletId; readonly actual: number; readonly normal: number; readonly unit: number;
  readonly parentId?: TupletId; readonly events: EventId[]; readonly target: RationalQ; span: RationalQ;
};
export function tupletMembership(node: XmlElement, value: {
  readonly id: EventId; readonly lane: string; readonly span: RationalQ; readonly base: number;
  readonly ratio: { readonly actual: number; readonly normal: number } | undefined;
}, relations: Relations): readonly TupletId[] {
  if (child(node, 'chord')) return [];
  const { id, lane, span, base, ratio } = value;
  const notations = child(node, 'notations');
  const marks = notations ? children(notations, 'tuplet') : [];
  const starts = marks.filter(m => m.attributes['type'] === 'start');
  const stack = relations.openTuplets.get(lane) ?? [];
  const begin = (mark: XmlElement | undefined): void => {
    const actualNode = mark ? child(mark, 'tuplet-actual') : undefined;
    const normalNode = mark ? child(mark, 'tuplet-normal') : undefined;
    const ancestors = stack.map(t => ({ actual: t.actual, normal: t.normal }));
    const factor = ancestors.reduce((q, r) => multiplyQ(q, rationalQ(BigInt(r.normal), BigInt(r.actual))), rationalQ(1n));
    if (!ratio) throw new InterchangeError('STRUCTURE', 'Tuplet requires time-modification');
    const local = multiplyQ(rationalQ(BigInt(ratio.normal), BigInt(ratio.actual)), rationalQ(BigInt(factor.d), BigInt(factor.n)));
    const actual = actualNode ? number(text(actualNode, 'tuplet-number'), { min: 1, max: 1024, integer: true }) : Number(local.d);
    const normal = normalNode ? number(text(normalNode, 'tuplet-number'), { min: 1, max: 1024, integer: true }) : Number(local.n);
    const modification = child(node, 'time-modification');
    const unitName = normalNode ? text(normalNode, 'tuplet-type') : modification ? text(modification, 'normal-type') : '';
    const unit = noteTypes.get(unitName) ?? base;
    const parent = stack.at(-1);
    stack.push({ id: newId('tuplet'), actual, normal, unit, events: [], span: zeroQ,
      target: durationQ({ base: unit, dots: 0 }, [...ancestors, { actual: 1, normal }]),
      ...(parent ? { parentId: parent.id } : {}) });
  };
  for (const mark of starts) begin(mark);
  if (ratio && !stack.length) begin(undefined);
  if (!stack.length) return [];
  if (!ratio || compareQ(durationQ({ base, dots: children(node, 'dot').length }, stack), span) !== 0) {
    throw new InterchangeError('STRUCTURE', 'Nested tuplet ratios disagree with duration');
  }
  const ids = stack.map(t => t.id);
  for (const group of stack) {
    group.events.push(id); group.span = addQ(group.span, span);
    if (compareQ(group.span, group.target) > 0) throw new InterchangeError('STRUCTURE', 'Tuplet exceeds authored span');
  }
  const finish = (): void => {
    const group = stack.pop();
    if (!group || compareQ(group.span, group.target) !== 0) throw new InterchangeError('STRUCTURE', 'Incomplete tuplet group');
    relations.tuplets.push({ id: group.id, actual: group.actual, normal: group.normal, unit: group.unit,
      eventIds: group.events, ...(group.parentId ? { parentId: group.parentId } : {}) });
  };
  const stops = marks.filter(m => m.attributes['type'] === 'stop');
  for (const stop of stops) { void stop; finish(); }
  while (stack.length && compareQ(stack.at(-1)?.span ?? zeroQ, stack.at(-1)?.target ?? zeroQ) === 0) finish();
  if (stack.length) relations.openTuplets.set(lane, stack); else relations.openTuplets.delete(lane);
  return ids;
}
