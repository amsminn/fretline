import { assertNever, DomainError } from '../diagnostics';
import type { Asset, ScoreDocument } from '../document';
import type { MeasureId } from '../ids';
import { compareQ, zeroQ } from '../rational';
import type { RationalQ } from '../rational';
import type { Selection } from '../selection';
import { validateScoped } from '../validate-scoped';
import { contentToken, freezeRoot, reject } from './core';
import type { CommandResult } from './core';

export type SyncPoint = NonNullable<ScoreDocument['backing']>['syncPoints'][number];
export type Backing = NonNullable<ScoreDocument['backing']>;
export type BackingEdit =
  | { readonly kind: 'attachBacking'; readonly asset: Asset; readonly offsetSeconds?: number; readonly syncPoints?: readonly SyncPoint[] }
  | { readonly kind: 'detachBacking' }
  | { readonly kind: 'backingOffset'; readonly offsetSeconds: number }
  | { readonly kind: 'addSyncPoint'; readonly point: SyncPoint }
  | { readonly kind: 'moveSyncPoint'; readonly index: number; readonly mediaSeconds: number }
  | { readonly kind: 'removeSyncPoint'; readonly index: number };
export type BackingCommand = { readonly expectedToken: string; readonly edit: BackingEdit };

export const offsetLimitSeconds = 86_400;

export function orderSyncPoints(doc: ScoreDocument, points: readonly SyncPoint[]): readonly SyncPoint[] {
  const order = new Map(doc.measures.map((measure, index) => [measure.id, index]));
  return [...points].sort((a, b) => (order.get(a.measureId) ?? -1) - (order.get(b.measureId) ?? -1) || a.pass - b.pass || compareQ(a.offsetQ, b.offsetQ));
}

/** Score order and media time must both strictly advance; otherwise interpolated tempo would be zero or negative. */
export function syncPointConflict(doc: ScoreDocument, points: readonly SyncPoint[]): string | null {
  const ordered = orderSyncPoints(doc, points);
  for (const [index, point] of ordered.entries()) {
    const measure = doc.measures.find(measure => measure.id === point.measureId);
    if (!measure) return '동기점이 존재하지 않는 마디를 가리킵니다.';
    if (!Number.isInteger(point.pass) || point.pass < 1) return '동기점 회차는 1 이상의 정수여야 합니다.';
    if (compareQ(point.offsetQ, zeroQ) < 0 || compareQ(point.offsetQ, measure.actualSpanQ) >= 0) return '동기점 위치가 마디 범위를 벗어납니다.';
    if (!Number.isFinite(point.mediaSeconds) || point.mediaSeconds < 0 || point.mediaSeconds > offsetLimitSeconds) return '동기점 미디어 시간이 범위를 벗어납니다.';
    const previous = ordered[index - 1];
    if (!previous) continue;
    const samePlace = previous.measureId === point.measureId && previous.pass === point.pass && compareQ(previous.offsetQ, point.offsetQ) === 0;
    if (samePlace) return '같은 악보 위치에 동기점이 두 개입니다.';
    if (point.mediaSeconds <= previous.mediaSeconds) return '동기점이 교차합니다: 뒤 마디의 미디어 시간이 앞 마디보다 빠르거나 같습니다.';
  }
  return null;
}

const requireBacking = (doc: ScoreDocument): Backing => doc.backing ?? reject('backing', '반주 오디오가 없습니다.');
const withPoints = (doc: ScoreDocument, backing: Backing, syncPoints: readonly SyncPoint[]): ScoreDocument => {
  const conflict = syncPointConflict(doc, syncPoints);
  if (conflict) reject('backing/syncPoints', conflict);
  return { ...doc, backing: { ...backing, syncPoints: orderSyncPoints(doc, syncPoints) } };
};
const checkOffset = (offsetSeconds: number): number => {
  if (!Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > offsetLimitSeconds) reject('backing/offsetSeconds', '반주 오프셋은 ±86400초 이내의 유한한 값이어야 합니다.');
  return offsetSeconds;
};
const unreferencedAssets = (doc: ScoreDocument, keep: readonly Asset[]): readonly Asset[] => {
  const previous = doc.backing?.assetId;
  return doc.assets.filter(asset => asset.id !== previous || keep.some(kept => kept.id === asset.id));
};

function execute(doc: ScoreDocument, edit: BackingEdit): ScoreDocument {
  switch (edit.kind) {
    case 'attachBacking': {
      if (!Number.isSafeInteger(edit.asset.byteLength) || edit.asset.byteLength <= 0) reject('backing/asset', '반주 자산 크기가 올바르지 않습니다.');
      const assets = [...unreferencedAssets(doc, []).filter(asset => asset.id !== edit.asset.id), edit.asset];
      const backing: Backing = { assetId: edit.asset.id, offsetSeconds: checkOffset(edit.offsetSeconds ?? 0), syncPoints: [] };
      return withPoints({ ...doc, assets, backing }, backing, edit.syncPoints ?? []);
    }
    case 'detachBacking': {
      requireBacking(doc);
      const rest: ScoreDocument & { backing?: Backing } = { ...doc, assets: unreferencedAssets(doc, []) };
      delete rest.backing;
      return rest;
    }
    case 'backingOffset': return { ...doc, backing: { ...requireBacking(doc), offsetSeconds: checkOffset(edit.offsetSeconds) } };
    case 'addSyncPoint': { const backing = requireBacking(doc); return withPoints(doc, backing, [...backing.syncPoints, edit.point]); }
    case 'moveSyncPoint': {
      const backing = requireBacking(doc);
      const point = backing.syncPoints[edit.index] ?? reject('backing/syncPoints', '동기점이 존재하지 않습니다.');
      return withPoints(doc, backing, backing.syncPoints.map((other, index) => index === edit.index ? { ...point, mediaSeconds: edit.mediaSeconds } : other));
    }
    case 'removeSyncPoint': {
      const backing = requireBacking(doc);
      if (!backing.syncPoints[edit.index]) reject('backing/syncPoints', '동기점이 존재하지 않습니다.');
      return withPoints(doc, backing, backing.syncPoints.filter((_point, index) => index !== edit.index));
    }
    default: return assertNever(edit);
  }
}

export function applyBackingCommand(doc: ScoreDocument, command: BackingCommand, selection: Selection): CommandResult {
  if (command.expectedToken !== contentToken(doc)) {
    return { kind: 'rejected', diagnostics: [{ code: 'REFERENCE', path: 'expectedToken', message: 'Document changed since the command was built' }] };
  }
  try {
    freezeRoot(doc);
    const nextDoc = execute(doc, command.edit);
    const diagnostics = validateScoped(doc, nextDoc);
    if (diagnostics.length) return { kind: 'rejected', diagnostics };
    return { kind: 'applied', nextDoc: freezeRoot(nextDoc), nextSelection: freezeRoot(selection), diagnostics: [] };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { kind: 'rejected', diagnostics: error.diagnostics };
  }
}

/** Media time of a score position under the current anchors: linear interpolation between neighbours, tempo extrapolation outside. */
export function measureMediaSeconds(input: {
  readonly anchors: readonly { readonly scoreSeconds: number; readonly mediaSeconds: number }[];
  readonly offsetSeconds: number;
  readonly scoreSeconds: number;
}): number {
  const anchors = [...input.anchors].sort((a, b) => a.scoreSeconds - b.scoreSeconds);
  const first = anchors[0]; const last = anchors.at(-1);
  if (!first || !last) return input.scoreSeconds + input.offsetSeconds;
  if (input.scoreSeconds <= first.scoreSeconds) return first.mediaSeconds + (input.scoreSeconds - first.scoreSeconds);
  if (input.scoreSeconds >= last.scoreSeconds) return last.mediaSeconds + (input.scoreSeconds - last.scoreSeconds);
  for (let index = 0; index + 1 < anchors.length; index++) {
    const from = anchors[index]; const to = anchors[index + 1];
    if (!from || !to || input.scoreSeconds > to.scoreSeconds) continue;
    const ratio = (input.scoreSeconds - from.scoreSeconds) / (to.scoreSeconds - from.scoreSeconds);
    return from.mediaSeconds + ratio * (to.mediaSeconds - from.mediaSeconds);
  }
  return last.mediaSeconds;
}

export const syncPointAt = (measureId: MeasureId, pass: number, offsetQ: RationalQ, mediaSeconds: number): SyncPoint => ({ measureId, pass, offsetQ, mediaSeconds });
