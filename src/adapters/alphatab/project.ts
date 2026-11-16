import { NotationElement } from '@coderline/alphatab/core';
import type { model } from '@coderline/alphatab/core';
import type { ScoreDocument } from '../../domain/document';
import { DomainError } from '../../domain/diagnostics';
import { validateDocument } from '../../domain/validate';
import { buildProjection } from './map/graph';
import type { ScoreProjection } from './map/graph';
import type { EventId, TrackId } from '../../domain/ids';
import { selectParts } from './map/reuse';
import type { ProjectionSnapshot } from './map/reuse';
export type { ScoreProjection } from './map/graph';
export type { ProjectionDiagnostic } from './map/context';

/** Each snapshot owns a fresh mutable engine graph; the source stays immutable. */
export function projectScore(document: ScoreDocument) {
  const diagnostics = validateDocument(document);
  if (diagnostics.length) throw new DomainError(diagnostics);
  return buildProjection(document);
}

/** Engraving estimate of attached text width in unscaled px: average glyph advance of the notation text font. */
const textWidth = (text: string, fontSize: number): number => (text.length + 1) * fontSize * 0.58;

/**
 * alphaTab sizes bars, not beats. Authored spacing overrides (per event ID) are exact beat widths;
 * lyric and performance-text widths are minimums so long syllables stop colliding. A bar gets a
 * displayWidth only when something in it asks for more than the natural beat width.
 */
export function applyEventSpacing(document: ScoreDocument, projection: ScoreProjection): void {
  const fontSize = document.layout.stylesheet.fontSize;
  const natural = fontSize * 3;
  const demands = new Map<model.Bar, Map<model.Beat, { readonly width: number; readonly exact: boolean }>>();
  const demand = (eventId: EventId, width: number, exact: boolean): void => {
    const beat = projection.identity.events.get(eventId);
    if (!beat) return;
    const bar = demands.get(beat.voice.bar) ?? new Map<model.Beat, { readonly width: number; readonly exact: boolean }>();
    const current = bar.get(beat);
    if (!current || exact || (!current.exact && width > current.width)) bar.set(beat, { width, exact });
    demands.set(beat.voice.bar, bar);
  };
  for (const lyric of document.lyrics) demand(lyric.eventId, textWidth(lyric.text, fontSize), false);
  for (const track of document.tracks) for (const staff of track.staves) for (const voice of staff.voices) for (const bar of voice.bars) {
    if (bar.kind !== 'active') continue;
    for (const event of bar.events) {
      const longest = Math.max(0, ...(event.annotations ?? []).map(text => textWidth(text, fontSize)));
      if (longest > 0) demand(event.id, longest, false);
    }
  }
  for (const entry of document.layout.eventSpacing ?? []) demand(entry.eventId, entry.width, true);
  for (const [bar, beats] of demands) {
    const widths = [...beats.values()];
    const exact = widths.some(entry => entry.exact);
    if (!exact && widths.every(entry => entry.width <= natural)) continue;
    const authoredTotal = widths.reduce((sum, entry) => sum + entry.width, 0);
    const fallback = exact ? authoredTotal / widths.length : natural;
    let total = 0;
    let count = 0;
    for (const voice of bar.voices) {
      let voiceTotal = 0;
      let voiceCount = 0;
      for (const beat of voice.beats) {
        if (beat.isEmpty) continue;
        const entry = beats.get(beat);
        voiceTotal += entry ? (entry.exact ? entry.width : Math.max(natural, entry.width)) : fallback;
        voiceCount += 1;
      }
      if (voiceTotal > total) { total = voiceTotal; count = voiceCount; }
    }
    const width = Math.round(total);
    // Page layout weighs bars by displayScale (relative to a natural bar of the same beat count); horizontal layout takes the absolute width.
    const scale = count > 0 ? width / (count * natural) : 1;
    bar.displayWidth = width;
    bar.displayScale = scale;
    bar.masterBar.displayWidth = Math.max(bar.masterBar.displayWidth, width);
    bar.masterBar.displayScale = Math.max(bar.masterBar.displayScale, scale);
  }
}

/**
 * The visible score shows a tempo mark at the first bar and where the tempo changes. Only the engraved
 * projection drops repeats of the carried tempo: export keeps every authored event and the playback projection
 * re-emits the entry tempo per visited bar itself.
 */
export function hideRepeatedTempoMarks(score: model.Score): void {
  let carried: number | undefined;
  for (const master of score.masterBars) {
    const kept: typeof master.tempoAutomations = [];
    for (const automation of [...master.tempoAutomations].sort((a, b) => a.ratioPosition - b.ratioPosition)) {
      if (automation.isLinear || automation.value !== carried) kept.push(automation);
      carried = automation.value;
    }
    master.tempoAutomations = kept;
  }
}

/**
 * Renderer-owned projection of an already parsed editor document. Unlike projectScore,
 * successive results belong to one mutable render session, not independent snapshots.
 * Keeping immutable domain references here avoids worker structured-clone/JSON roundtrips.
 */
export class ScoreProjector {
  private previous: ProjectionSnapshot | undefined;

  project(document: ScoreDocument, trackIds?: readonly TrackId[]) {
    const selected = trackIds ? new Set(trackIds) : undefined;
    const tracks = document.tracks.filter(track => selected ? selected.has(track.id) : !document.layout.hiddenTracks.includes(track.id));
    const part = selectParts(document, tracks);
    const projection = buildProjection(part, undefined, this.previous);
    hideRepeatedTempoMarks(projection.score);
    // Multi-track tuning rows are the shell's header (per-track labels drawn by the engine overlap); a single part keeps the engraved tuning.
    projection.settings.notation.elements.set(NotationElement.GuitarTuning, tracks.length <= 1);
    applyEventSpacing(part, projection);
    this.previous = { document: part, projection };
    return projection;
  }
}
