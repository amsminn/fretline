import { NotationElement } from '@coderline/alphatab/core';
import type { model, rendering, Settings } from '@coderline/alphatab/core';

/** alphaTab keeps this clearance (unscaled px) between neighbouring effect texts; syllables use the same gap. */
const clearance = 3;

export type LyricMeasure = (text: string) => number;
export type LyricSpan = {
  readonly row: string;
  readonly left: number;
  readonly right: number;
  readonly systemWidth: number;
  /** Right edge (scaled px) of the system's track label and bracket: where the first bar's staff begins. */
  readonly labelRight: number;
};
export type PaperShortfall = { readonly width: number; readonly paddingLeft: number; readonly labelPadding: number };

/** Canvas metrics of the engine lyric font at the display scale: the face the SVG text is painted with. */
export function lyricMeasure(settings: Settings): LyricMeasure {
  const font = settings.display.resources.elementFonts.get(NotationElement.EffectLyrics);
  if (!font) throw new TypeError('alphaTab has no lyric font');
  const context = document.createElement('canvas').getContext('2d');
  if (!context) throw new TypeError('Canvas text metrics are unavailable');
  const style = `${font.isItalic ? 'italic ' : ''}${font.isBold ? 'bold ' : ''}`;
  context.font = `${style}${font.size * settings.display.scale}px ${font.families.map(family => `"${family}"`).join(', ')}`;
  return text => context.measureText(text).width;
}

/** `[left, right]` page padding in unscaled px; alphaTab accepts `[x, y]` or `[left, top, right, bottom]`. */
export function horizontalPadding(settings: Settings): readonly [number, number] {
  const padding = settings.display.padding;
  const left = padding[0] ?? 0;
  return padding.length >= 4 ? [left, padding[2] ?? left] : [left, left];
}

const syllableWidth = (beat: model.Beat, measure: LyricMeasure): number => Math.max(0, ...(beat.lyrics ?? []).map(measure));

/**
 * Narrowest paper (scaled px) on which every bar holds its centered syllables: a voice needs the sum of its
 * syllable widths plus clearance around each beat, and the engine never splits one bar across systems.
 */
export function lyricPaperWidth(score: model.Score, settings: Settings, measure: LyricMeasure, available: number): number {
  const scale = settings.display.scale;
  const [left, right] = horizontalPadding(settings);
  let demand = 0;
  for (const track of score.tracks) for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) {
    const beats = voice.beats.filter(beat => !beat.isEmpty);
    const widths = beats.map(beat => syllableWidth(beat, measure));
    if (!widths.some(width => width > 0)) continue;
    const total = widths.reduce((sum, width) => sum + width, 0) + (beats.length + 1) * clearance * scale;
    demand = Math.max(demand, total + (left + right) * scale);
  }
  return Math.max(available, Math.ceil(demand));
}

/**
 * Horizontal extent of every engraved syllable, keyed by the row (system + staff) it is written on.
 * A staff shown as notation plus tablature reports each beat twice; the syllable is written once.
 */
export function lyricSpans(lookup: rendering.BoundsLookup, measure: LyricMeasure): LyricSpan[] {
  const spans: LyricSpan[] = [];
  const seen = new Set<model.Beat>();
  for (const system of lookup.staffSystems) for (const master of system.bars) for (const bar of master.bars) for (const beat of bar.beats) {
    if (seen.has(beat.beat)) continue;
    seen.add(beat.beat);
    const width = syllableWidth(beat.beat, measure);
    if (width === 0) continue;
    const row = `${system.index}:${bar.bar.staff.track.index}:${bar.bar.staff.index}`;
    const labelRight = Math.min(...system.bars.map(candidate => candidate.visualBounds.x));
    spans.push({ row, left: beat.onNotesX - width / 2, right: beat.onNotesX + width / 2, systemWidth: system.visualBounds.w, labelRight });
  }
  return spans;
}

/**
 * Paper the engraved layout still lacks (scaled px). Syllable overlaps and overflow past the right content
 * edge widen the page. The engine has no pre-beat rod for a syllable's left half, so a system-opening
 * syllable may reach left of its bar; the left padding grows until it stays on the paper. Rows are
 * independent, so the worst row decides. Added width spreads over every spring of the system, so the
 * colliding gaps recover only the share of the system they span; the request is scaled up by that share.
 * A system-opening syllable that reaches left of the first bar would cover the vertical track label and
 * bracket; `labelPadding` is the space to add between label and staff so it stays right of them.
 */
export function paperShortfall(spans: readonly LyricSpan[], contentRight: number, scale: number): PaperShortfall {
  const rows = new Map<string, LyricSpan[]>();
  for (const span of spans) rows.set(span.row, [...rows.get(span.row) ?? [], span]);
  let width = 0;
  let paddingLeft = 0;
  let labelPadding = 0;
  for (const row of rows.values()) {
    const sorted = [...row].sort((a, b) => a.left - b.left);
    const first = sorted[0];
    const last = sorted.at(-1);
    if (!first || !last) continue;
    let missing = Math.max(0, last.right - contentRight);
    for (const [index, span] of sorted.entries()) {
      const previous = sorted[index - 1];
      if (previous) missing += Math.max(0, previous.right + clearance * scale - span.left);
    }
    const centers = (last.left + last.right - first.left - first.right) / 2;
    const share = Math.max(0.25, centers / first.systemWidth);
    width = Math.max(width, missing / share);
    paddingLeft = Math.max(paddingLeft, clearance * scale - first.left);
    labelPadding = Math.max(labelPadding, first.labelRight + clearance * scale - first.left);
  }
  return { width: Math.ceil(width), paddingLeft: Math.ceil(paddingLeft), labelPadding: Math.ceil(labelPadding) };
}
