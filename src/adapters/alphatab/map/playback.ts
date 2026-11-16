import { panToController } from '../../pan';
import { model } from '@coderline/alphatab/core';
import type { Automation, ScoreDocument } from '../../../domain/document';
import { assertNever } from '../../../domain/diagnostics';
import { indexDocument } from '../../../domain/event-time';
import type { EventId, MeasureId, OccurrenceId } from '../../../domain/ids';
import { addQ, compareQ, subtractQ, zeroQ } from '../../../domain/rational';
import type { RationalQ } from '../../../domain/rational';
import type { Occurrence } from '../../../domain/timeline';
import type { ScoreProjection } from './graph';
import { numberQ, ticksQ } from './time';
import { engineLimit } from './context';
import type { MappingContext, ProjectionDiagnostic } from './context';

export type PlaybackBeat = {
  readonly occurrenceId: OccurrenceId;
  readonly eventId: EventId;
  readonly measureId: MeasureId;
  readonly writtenStartQ: RationalQ;
  readonly playbackStartQ: RationalQ;
  readonly durationQ: RationalQ;
};

export function mapPlaybackBeats(document: ScoreDocument, projection: ScoreProjection,
  occurrences: readonly Occurrence[]): ReadonlyMap<number, PlaybackBeat> {
  const index = indexDocument(document);
  const playbackBeat = new Map<number, PlaybackBeat>();
  for (const track of projection.score.tracks) for (const staff of track.staves) for (const bar of staff.bars) {
    const occurrence = occurrences[bar.index];
    if (!occurrence) throw new RangeError('Missing projected occurrence');
    for (const voice of bar.voices) for (const beat of voice.beats) {
      const eventId = projection.identity.eventIds.get(beat.id);
      if (!eventId) continue; // Engine-only empty beat for an inactive lane.
      const location = index.events.get(eventId);
      if (!location) throw new RangeError(`Missing event ${eventId}`);
      const start = compareQ(location.startQ, occurrence.writtenStartQ) < 0 ? occurrence.writtenStartQ : location.startQ;
      const limit = addQ(occurrence.writtenStartQ, occurrence.spanQ);
      const end = compareQ(location.endQ, limit) > 0 ? limit : location.endQ;
      playbackBeat.set(beat.id, { occurrenceId: occurrence.occurrenceId, eventId, measureId: occurrence.measureId,
        writtenStartQ: start, playbackStartQ: addQ(occurrence.playbackStartQ, subtractQ(start, occurrence.writtenStartQ)),
        durationQ: subtractQ(end, start) });
    }
  }
  return playbackBeat;
}

/** Reset tempo at every visited measure so repeat/jump entry cannot inherit the wrong ending's tempo. */
export function projectPlaybackTempo(document: ScoreDocument, score: model.Score,
  occurrences: readonly Occurrence[]): void {
  let carried = 120;
  const tempoAtMeasure = new Map<MeasureId, number>();
  for (const measure of document.measures) {
    tempoAtMeasure.set(measure.id, carried);
    for (const tempo of [...measure.tempoEvents].sort((a, b) => compareQ(a.offsetQ, b.offsetQ))) carried = tempo.bpm;
  }
  for (const [i, occurrence] of occurrences.entries()) {
    const measure = document.measures.find(measure => measure.id === occurrence.measureId);
    const master = score.masterBars[i];
    if (!measure || !master) throw new RangeError('Missing playback tempo measure');
    let entryTempo = tempoAtMeasure.get(measure.id) ?? 120;
    const tempos = [...measure.tempoEvents].sort((a, b) => compareQ(a.offsetQ, b.offsetQ));
    for (const tempo of tempos) if (compareQ(tempo.offsetQ, occurrence.measureOffsetQ) <= 0) entryTempo = tempo.bpm;
    master.tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, entryTempo, 2)];
    for (const tempo of tempos) {
      const offset = subtractQ(tempo.offsetQ, occurrence.measureOffsetQ);
      if (compareQ(offset, zeroQ) > 0 && compareQ(offset, occurrence.spanQ) < 0) {
        master.tempoAutomations.push(model.Automation.buildTempoAutomation(tempo.transition === 'linear',
          ticksQ(offset) / master.calculateDuration(false), tempo.bpm, 2));
      }
    }
  }
}

/** Only join actual adjacent visits, never across a skipped ending or back to a repeated bar. */
export function projectPlaybackTies(document: ScoreDocument, projection: ScoreProjection,
  playbackBeat: ReadonlyMap<number, PlaybackBeat>): void {
  const targetIds = new Map(document.ties.map(tie => [tie.from, tie.to]));
  const eventIndex = indexDocument(document);
  for (const track of projection.score.tracks) for (const staff of track.staves) for (const bar of staff.bars) {
    for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
      const sourceId = projection.identity.noteIds.get(note.id);
      const targetId = sourceId ? targetIds.get(sourceId) : undefined;
      const sourcePosition = playbackBeat.get(beat.id);
      if (!targetId || !sourcePosition) continue;
      const targetBeat = beat.nextBeat;
      const targetPosition = targetBeat ? playbackBeat.get(targetBeat.id) : undefined;
      const target = targetBeat?.notes.find(candidate => projection.identity.noteIds.get(candidate.id) === targetId);
      const authoredTarget = eventIndex.notes.get(targetId);
      if (target && targetPosition && authoredTarget &&
        compareQ(addQ(sourcePosition.writtenStartQ, sourcePosition.durationQ), targetPosition.writtenStartQ) === 0 &&
        compareQ(targetPosition.writtenStartQ, authoredTarget.location.startQ) === 0) {
        note.tieDestination = target;
        target.tieOrigin = note;
        target.isTieDestination = true;
      }
    }
  }
}

export function projectPlaybackAutomations(document: ScoreDocument, projection: ScoreProjection,
  occurrences: readonly Occurrence[]): readonly ProjectionDiagnostic[] {
  const context: MappingContext = { document, identity: projection.identity, diagnostics: [] };
  const measureIndexes = new Map(document.measures.map((measure, i) => [measure.id, i]));
  for (const [trackIndex, sourceTrack] of document.tracks.entries()) {
    const track = projection.score.tracks[trackIndex];
    if (!track) throw new RangeError('Missing playback track');
    const authored = document.automations.filter(source => source.trackId === sourceTrack.id).sort((a, b) =>
      (measureIndexes.get(a.measureId) ?? 0) - (measureIndexes.get(b.measureId) ?? 0) || compareQ(a.offsetQ, b.offsetQ));
    for (const [barIndex, occurrence] of occurrences.entries()) {
      const bar = track.staves[0]?.bars[barIndex];
      if (!bar) throw new RangeError('Missing playback automation bar');
      const entry = new Map<Automation['kind'], Automation>();
      const currentIndex = measureIndexes.get(occurrence.measureId) ?? 0;
      for (const source of authored) {
        const index = measureIndexes.get(source.measureId) ?? 0;
        if (index < currentIndex || (index === currentIndex && compareQ(source.offsetQ, occurrence.measureOffsetQ) <= 0)) {
          entry.set(source.kind, source);
        }
      }
      const inside = authored.filter(source => source.measureId === occurrence.measureId &&
        compareQ(source.offsetQ, occurrence.measureOffsetQ) > 0 &&
        compareQ(source.offsetQ, addQ(occurrence.measureOffsetQ, occurrence.spanQ)) < 0);
      for (const source of [...entry.values(), ...inside]) {
        const offset = entry.get(source.kind) === source ? zeroQ : subtractQ(source.offsetQ, occurrence.measureOffsetQ);
        const automation = new model.Automation();
        automation.value = source.value;
        automation.ratioPosition = ticksQ(offset) / bar.masterBar.calculateDuration(false);
        switch (source.kind) {
          case 'volume':
            automation.type = model.AutomationType.Volume;
            automation.value = Math.round(Math.min(1, source.value) * 127) / 8;
            if (source.value > 1) engineLimit(context, source.id, 'MIDI volume ends at unity; above-unity gain belongs to the app audio mixer.');
            break;
          case 'pan': automation.type = model.AutomationType.Balance; automation.value = panToController(source.value) / 8; break;
          case 'program': automation.type = model.AutomationType.Instrument; break;
          case 'sustain': {
            const pedal = new model.SustainPedalMarker();
            pedal.bar = bar;
            pedal.ratioPosition = automation.ratioPosition;
            pedal.pedalType = source.value >= 0.5 ? model.SustainPedalMarkerType.Down : model.SustainPedalMarkerType.Up;
            bar.sustainPedals.push(pedal);
            engineLimit(context, source.id, 'Sustain pedal notation is projected; alphaTab 1.9 MIDI generation does not emit pedal controllers.');
            continue;
          }
          case 'expression':
          case 'pitchBend':
            engineLimit(context, source.id, `alphaTab AutomationType has no ${source.kind} controller.`);
            continue;
          default: assertNever(source.kind);
        }
        const beat = bar.voices.flatMap(voice => voice.beats).find(beat =>
          beat.displayStart <= numberQ(offset) * 960 && beat.displayEnd > numberQ(offset) * 960);
        if (beat) {
          if (beat.displayStart !== ticksQ(offset)) engineLimit(context, source.id,
            'alphaTab schedules volume/pan/program at the containing beat onset, not the automation ratio.');
          beat.automations.push(automation);
        }
      }
    }
  }
  return context.diagnostics;
}
