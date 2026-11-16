import type { ScoreDocument } from '../../domain/document';
import { DomainError } from '../../domain/diagnostics';
import type { Occurrence } from '../../domain/timeline';
import { validateDocumentForRead } from '../../domain/validate';
import { buildProjection } from './map/graph';
import { mapPlaybackBeats, projectPlaybackAutomations, projectPlaybackTempo, projectPlaybackTies } from './map/playback';
import type { BarSlot } from '../../domain/bar-slot';
import type { RationalQ } from '../../domain/rational';
import type { OccurrenceId } from '../../domain/ids';
export type { PlaybackBeat } from './map/playback';
export type PlaybackBarSlot = {
  readonly barSlot: BarSlot;
  readonly occurrenceId: OccurrenceId;
  readonly trackIndex: number;
  readonly writtenStartQ: RationalQ;
  readonly playbackStartQ: RationalQ;
  readonly durationQ: RationalQ;
};

/** Caller supplies domain/timeline's occurrence list, the sole traversal authority. */
export function linearizeScore(document: ScoreDocument, occurrences: readonly Occurrence[]) {
  const diagnostics = validateDocumentForRead(document);
  if (diagnostics.length) throw new DomainError(diagnostics);
  const projection = buildProjection(document, occurrences);
  const playbackBeat = mapPlaybackBeats(document, projection, occurrences);
  const playbackBarSlots = new Map<number, PlaybackBarSlot>();
  for (const track of projection.score.tracks) for (const staff of track.staves) for (const bar of staff.bars) {
    const occurrence = occurrences[bar.index];
    if (!occurrence) throw new RangeError('Missing empty-bar occurrence');
    for (const voice of bar.voices) for (const beat of voice.beats) {
      const barSlot = projection.identity.beatSlots.get(beat.id);
      if (barSlot) playbackBarSlots.set(beat.id, { barSlot, occurrenceId: occurrence.occurrenceId,
        trackIndex: track.index, writtenStartQ: occurrence.writtenStartQ, playbackStartQ: occurrence.playbackStartQ,
        durationQ: occurrence.spanQ });
    }
  }
  projectPlaybackTempo(document, projection.score, occurrences);
  const automationDiagnostics = projectPlaybackAutomations(document, projection, occurrences);
  projectPlaybackTies(document, projection, playbackBeat);
  return { ...projection, diagnostics: [...projection.diagnostics, ...automationDiagnostics], playbackBeat, playbackBarSlots, occurrences };
}
