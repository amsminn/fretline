import type { ScoreDocument } from '../../domain/document';
import type { Selection } from '../../domain/selection';
import type { EditingSnapshot } from './editing';

export type EditingObservation = EditingSnapshot & {
  readonly revision: number; readonly past: number; readonly future: number; readonly selection: Selection | null;
  readonly events: Readonly<Record<string, { readonly kind: string; readonly duration: string; readonly notes: readonly (readonly [number, number])[] }>>;
};
declare global { interface Window { readonly fretlineEditingObservation?: () => EditingObservation } }

type Source = {
  readonly snapshot: EditingSnapshot; readonly selection: Selection | null;
  readonly active: { readonly revision: number; readonly score: ScoreDocument } | null;
};
/** Read-only QA view (FRETLINE_QA only): every written beat's kind, duration and (string, fret) pairs plus history depth. */
export function observeEditing({ snapshot, selection, active }: Source): EditingObservation {
  const events: Record<string, EditingObservation['events'][string]> = {};
  for (const track of active?.score.tracks ?? []) for (const staff of track.staves) for (const voice of staff.voices) for (const bar of voice.bars) {
    if (bar.kind !== 'active') continue;
    for (const event of bar.events) {
      events[event.id] = { kind: event.kind, duration: event.duration === 'fullMeasure' ? 'full' : `${event.duration.base}${'.'.repeat(event.duration.dots)}`,
        notes: event.kind === 'noteGroup' ? event.notes.flatMap(note => note.kind === 'fretted' ? [[note.string, note.fret] as const] : []) : [] };
    }
  }
  return { ...snapshot, revision: active?.revision ?? 0, selection, events };
}
