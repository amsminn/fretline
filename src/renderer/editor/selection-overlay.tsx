import type { ScoreDocument } from '../../domain/document';
import { compareQ } from '../../domain/rational';
import type { Selection } from '../../domain/selection';
import type { EditHit as ScoreHit, ScoreHitMap } from '../score/overlay';
import { editHits, hitId } from '../score/overlay';
import { barSlotId } from '../../domain/bar-slot';
import { describeSelection, focusTargets } from './focus';
import { t } from '../i18n';
import type { Point } from './pointer';
import { rangeOf, selectedHits } from './selection-state';
import './editor.css';

export type RangeEdges = { readonly start: ScoreHit; readonly end: ScoreHit };

export function rangeEdges(selection: Selection | null, map: ScoreHitMap | undefined): RangeEdges | undefined {
  if (!selection || !map || selection.kind !== 'timeRange') return undefined;
  const range = rangeOf(selection);
  if (!range) return undefined;
  const inside = selectedHits(selection, map);
  const start = inside.reduce<ScoreHit | undefined>((best, hit) => !best || compareQ(hit.startQ, best.startQ) < 0 ? hit : best, undefined);
  const end = inside.reduce<ScoreHit | undefined>((best, hit) => !best || compareQ(hit.endQ, best.endQ) > 0 ||
    (compareQ(hit.endQ, best.endQ) === 0 && hit.bounds.x > best.bounds.x) ? hit : best, undefined);
  return start && end ? { start, end } : undefined;
}

const handleVisualPx = 8;
const handleHitPx = 24;

export type SelectionHandlesProps = {
  readonly document: ScoreDocument;
  readonly selection: Selection | null;
  readonly map: ScoreHitMap | undefined;
  readonly offset: Point;
  readonly dragging: boolean;
};

export function SelectionHandles({ document, selection, map, offset, dragging }: SelectionHandlesProps) {
  const edges = rangeEdges(selection, map);
  const caretHit = selection && selection.kind !== 'timeRange' && map
    ? editHits(map).find(hit => hitId(hit) === (selection.anchor.barSlot ? barSlotId(selection.anchor.barSlot) : selection.anchor.eventId)) : undefined;
  const targets = focusTargets(document, selection);
  return <>
    <svg className="editor-selection-layer" data-testid="editor-selection-layer" data-dragging={dragging} aria-hidden="true">
      <g transform={`translate(${offset.x} ${offset.y})`}>
        {caretHit ? <rect className="editor-caret" data-testid="editor-caret" x={caretHit.bounds.x} y={caretHit.bounds.y}
          width={1} height={caretHit.bounds.height} /> : null}
        {edges && !dragging ? (['start', 'end'] as const).map(edge => {
          const hit = edges[edge];
          // The visible grip stays inside the half-open range so it never covers the neighbouring beat's glyph;
          // the invisible hit area keeps straddling the edge so a click on the first or last beat still selects it.
          const x = edge === 'start' ? hit.bounds.x : hit.bounds.x + hit.bounds.width;
          const inward = (width: number): number => edge === 'start' ? x : x - width;
          return <g key={edge} className="editor-handle" data-handle={edge} data-testid={`selection-handle-${edge}`}>
            <rect className="editor-handle-hit" x={x - handleHitPx / 2} y={hit.bounds.y - handleHitPx / 4}
              width={handleHitPx} height={hit.bounds.height + handleHitPx / 2} />
            <rect className="editor-handle-grip" x={inward(handleVisualPx)} y={hit.bounds.y} width={handleVisualPx} height={hit.bounds.height} rx={2} />
          </g>;
        }) : null}
      </g>
    </svg>
    <output role="status" aria-live="polite" className="sr-only" data-testid="selection-description">{describeSelection(document, selection)}</output>
    <ul role="listbox" aria-label={t('editor.selectedNotes')} className="sr-only" data-testid="note-focus-list">
      {targets.map(target => <li key={target.id} id={target.id} role="option" aria-selected={target.noteId !== undefined}>{target.label}</li>)}
    </ul>
  </>;
}
