import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { ScoreDocument } from '../../domain/document';
import type { MeasureId, TrackId } from '../../domain/ids';
import type { SpacingEntry } from '../../domain/commands/layout';
import { spacingLimits } from '../../domain/commands/layout';
import { t } from '../i18n';
import { useT } from '../i18n/react';
import { cn } from '../lib/cn';
import { hasOpenDialog } from '../shell/commands';
import type { SymbolKind, SymbolTarget } from '../commands/view';
import { editHits, hitId } from './overlay';
import type { EditHit, Rect, ScoreHit, ScoreHitMap } from './overlay';
import { takeNearestLabel, printedLabels } from './printed-labels';
import type { PrintedLabel } from './printed-labels';

export type { SymbolTarget } from '../commands/view';
export type DesignOverlayProps = {
  readonly document: ScoreDocument;
  readonly map: ScoreHitMap | undefined;
  readonly offset: { readonly x: number; readonly y: number };
  readonly scale: number;
  readonly design: boolean;
  readonly onSymbol: (kind: SymbolKind, target: SymbolTarget) => void;
  readonly onLineBreak: (measureId: MeasureId) => void;
  readonly onSpacing: (entries: readonly SpacingEntry[]) => void;
};
type MeasureGroup = { readonly measureId: MeasureId; readonly system: number; readonly beats: readonly ScoreHit[]; readonly box: Rect; readonly first: EditHit };
type Hotspot = { readonly id: string; readonly kind: SymbolKind; readonly label: string; readonly bounds: Rect; readonly target: SymbolTarget };
type Drag = { readonly hit: ScoreHit; readonly group: MeasureGroup; readonly startX: number; readonly currentX: number };

/** Top-most staff of every (measure, system): the clickable printed symbols sit around that row. */
export function measureGroups(map: ScoreHitMap): readonly MeasureGroup[] {
  const groups = new Map<string, Map<string, EditHit[]>>();
  for (const beat of editHits(map)) {
    // Inactive auxiliary voices share painted geometry with the main voice.
    if (beat.eventId === undefined && beat.voiceNumber !== 1) continue;
    const key = `${beat.measureId}:${beat.system}`;
    const staves = groups.get(key) ?? new Map<string, EditHit[]>();
    const list = staves.get(beat.staffId) ?? [];
    list.push(beat);
    staves.set(beat.staffId, list);
    groups.set(key, staves);
  }
  return [...groups.values()].flatMap(staves => {
    const top = [...staves.values()].sort((a, b) => Math.min(...a.map(h => h.bounds.y)) - Math.min(...b.map(h => h.bounds.y)))[0];
    if (!top?.length) return [];
    // A staff showing notation and tab reports one beat twice (one row each); the box spans both rows, the beat list keeps the upper hit.
    const upper = new Map<string, EditHit>();
    for (const hit of top) { const kept = upper.get(hitId(hit)); if (!kept || hit.bounds.y < kept.bounds.y) upper.set(hitId(hit), hit); }
    const ordered = [...upper.values()].sort((a, b) => a.bounds.x - b.bounds.x);
    const first = ordered[0];
    const beats = ordered.filter((hit): hit is ScoreHit => hit.eventId !== undefined);
    if (!first) return [];
    const x = Math.min(...top.map(h => h.bounds.x));
    const y = Math.min(...top.map(h => h.bounds.y));
    const right = Math.max(...top.map(h => h.bounds.x + h.bounds.width));
    const bottom = Math.max(...top.map(h => h.bounds.y + h.bounds.height));
    return [{ measureId: first.measureId, system: first.system, beats, first, box: { x, y, width: right - x, height: bottom - y } }];
  }).sort((a, b) => a.system - b.system || a.box.x - b.box.x);
}

/** Printed-symbol hit regions derived from engraved beat geometry; `tier` is the engraving unit in CSS px. */
export function symbolHotspots(document: ScoreDocument, groups: readonly MeasureGroup[], tier: number, labels: readonly PrintedLabel[] = []): readonly Hotspot[] {
  const remainingLabels = [...labels];
  const trackIndex = new Map<TrackId, number>(document.tracks.map((track, index) => [track.id, index]));
  const measures = new Map(document.measures.map((measure, index) => [measure.id, { measure, index }]));
  const chords = new Map(document.chords.map(chord => [chord.eventId, chord]));
  const lyrics = new Set(document.lyrics.map(lyric => lyric.eventId));
  const spots: Hotspot[] = [];
  const systemStarts = new Set(groups.filter((group, i) => i === 0 || groups[i - 1]?.system !== group.system).map(group => group.measureId));
  for (const group of groups) {
    const entry = measures.get(group.measureId);
    if (!entry) continue;
    const { measure, index } = entry;
    const previous = document.measures[index - 1];
    const target: SymbolTarget = { trackIndex: trackIndex.get(group.first.trackId) ?? 0,
      ...(group.first.eventId === undefined ? { barSlot: group.first.barSlot } : { eventId: group.first.eventId }) };
    const { x, y, height } = group.box;
    const staffHeight = Math.min(height, 5 * tier);
    const push = (kind: SymbolKind, label: string, bounds: Rect, matches?: (text: string) => boolean): void => {
      spots.push({ id: `${kind}:${group.measureId}:${group.system}`, kind, label,
        bounds: matches ? takeNearestLabel(remainingLabels, matches, bounds) : bounds, target });
    };
    const meterShown = index === 0 || systemStarts.has(group.measureId) || previous?.meter.beats !== measure.meter.beats || previous.meter.unit !== measure.meter.unit;
    if (meterShown) push('meter', t('score.hotspot.meter', { meter: `${measure.meter.beats}/${measure.meter.unit}`, bar: index + 1 }), { x: x - 2.4 * tier, y, width: 2 * tier, height: staffHeight });
    const keyShown = index === 0 || systemStarts.has(group.measureId) || previous?.key.fifths !== measure.key.fifths || previous.key.mode !== measure.key.mode;
    if (keyShown) push('key', t('score.hotspot.key', { bar: index + 1 }), { x: x - 4.8 * tier, y, width: 2.2 * tier, height: staffHeight });
    // Separate effect rows even before the SVG text has been measured.
    if (measure.tempoEvents.length) push('tempo', t('score.hotspot.tempo', { bpm: measure.tempoEvents[0]?.bpm ?? '', bar: index + 1 }),
      { x, y: y - 2.7 * tier, width: 4 * tier, height: 1.5 * tier },
      text => text.replace(/\s/g, '') === `=${measure.tempoEvents[0]?.bpm ?? ''}`);
    if (measure.section) {
      const section = measure.section;
      push('section', t('score.hotspot.section', { letter: section.letter, name: section.name, bar: index + 1 }).trim(),
        { x: x - 1.2 * tier, y: y - 4.2 * tier, width: 4 * tier, height: 1.5 * tier },
        text => text === (section.letter ? `[${section.letter}] ${section.name}` : section.name));
    }
    if (index === 0 && group.system === 0) {
      push('tuning', t('score.hotspot.tuning'), { x: x - 6 * tier, y: y - (measure.section ? 5.7 : 4.2) * tier, width: 6 * tier, height: 1.5 * tier },
        text => /tuning/i.test(text));
      const staff = document.tracks[target.trackIndex]?.staves.find(staff => staff.id === group.first.staffId);
      if (staff && staff.capo > 0) {
        push('capo', t('score.hotspot.capo', { fret: staff.capo }), { x, y: y - 1.2 * tier, width: 6 * tier, height: 1.2 * tier },
          text => text === `Capo. fret ${staff.capo}`);
      }
    }
    for (const [i, beat] of group.beats.entries()) {
      const next = group.beats[i + 1];
      const width = Math.max(tier, Math.min(beat.bounds.width, next ? next.bounds.x - beat.bounds.x : Infinity));
      const chord = chords.get(beat.eventId);
      if (chord) spots.push({ id: `chord:${beat.eventId}`, kind: 'chord', label: t('score.hotspot.chord', { name: chord.name }),
        bounds: takeNearestLabel(remainingLabels, text => text === chord.name, { x: beat.bounds.x, y: y - 5.7 * tier, width, height: 1.5 * tier }),
        target: { eventId: beat.eventId, trackIndex: target.trackIndex } });
      if (lyrics.has(beat.eventId)) spots.push({ id: `lyrics:${beat.eventId}`, kind: 'lyrics', label: t('score.hotspot.lyrics'), bounds: { x: beat.bounds.x, y: y + height + 0.2 * tier, width, height: 1.5 * tier }, target: { eventId: beat.eventId, trackIndex: target.trackIndex } });
    }
  }
  return spots;
}

/** Widths of every beat in the dragged voice/bar, in unscaled engraving px, with the dragged beat resized by `dx`. */
export function spacingEntries(group: MeasureGroup, hit: ScoreHit, dx: number, scale: number): readonly SpacingEntry[] {
  return group.beats.filter(beat => beat.voiceId === hit.voiceId).map(beat => {
    const base = beat.bounds.width / scale;
    const width = beat.eventId === hit.eventId ? base + dx / scale : base;
    return { eventId: beat.eventId, width: Math.round(Math.min(spacingLimits.max, Math.max(spacingLimits.min, width))) };
  });
}

const hotspotClass = 'pointer-events-auto cursor-pointer fill-transparent stroke-transparent transition-colors hover:fill-selection-fill hover:stroke-selection-edge focus-visible:fill-selection-fill focus-visible:stroke-selection-edge outline-none';

export function DesignOverlay({ document, map, offset, scale, design, onSymbol, onLineBreak, onSpacing }: DesignOverlayProps) {
  useT();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const pointerTarget = useRef<EventTarget | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [labels, setLabels] = useState<readonly PrintedLabel[]>([]);
  useLayoutEffect(() => {
    setLabels(printedLabels(svg.current?.parentElement?.querySelector('[data-testid="score-engine"]')));
  }, [map, scale, offset.x, offset.y, document]);
  useEffect(() => { setDrag(null); pointerTarget.current = null; }, [map]);
  if (!map) return null;
  const currentDrag = drag && drag.hit.generation === map.generation && map.beats.includes(drag.hit) ? drag : null;
  const tier = document.layout.stylesheet.fontSize * scale;
  const groups = measureGroups(map);
  const spots = symbolHotspots(document, groups, tier, labels);
  const tabStop = spots.some(spot => spot.id === focusedId) ? focusedId : spots[0]?.id;
  const breaks = new Set(document.layout.systemBreaks);
  const measureIndex = new Map(document.measures.map((measure, index) => [measure.id, index + 1]));
  const beginDrag = (event: PointerEvent<SVGRectElement>, group: MeasureGroup, hit: ScoreHit): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ hit, group, startX: event.clientX, currentX: event.clientX });
  };
  const endDrag = (): void => {
    if (!currentDrag) return;
    const dx = currentDrag.currentX - currentDrag.startX;
    setDrag(null);
    if (Math.abs(dx) >= 2) onSpacing(spacingEntries(currentDrag.group, currentDrag.hit, dx, scale));
  };
  const isolate = (event: { stopPropagation: () => void }): void => event.stopPropagation();
  const blockModal = (event: { readonly currentTarget: SVGSVGElement; preventDefault: () => void; stopPropagation: () => void }): boolean => {
    if (!hasOpenDialog(event.currentTarget.ownerDocument)) return false;
    pointerTarget.current = null;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  return <svg ref={svg} data-testid="design-overlay" data-design={design} aria-label={t('score.symbols')} role="group"
    className="pointer-events-none absolute inset-0 size-full overflow-visible" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
    onKeyDownCapture={blockModal}
    onPointerDownCapture={event => { if (!blockModal(event)) pointerTarget.current = event.target; }}
    onPointerMoveCapture={blockModal} onPointerUpCapture={blockModal}
    onPointerCancel={() => { pointerTarget.current = null; setDrag(null); }}
    onClickCapture={event => {
      if (blockModal(event)) return;
      if (event.detail > 0 && pointerTarget.current !== event.target) { event.preventDefault(); event.stopPropagation(); }
      pointerTarget.current = null;
    }}
    onPointerDown={isolate} onPointerMove={isolate} onPointerUp={isolate} onClick={isolate}>
    {spots.map((spot, index) => <rect key={spot.id} role="button" tabIndex={spot.id === tabStop ? 0 : -1} aria-label={spot.label} data-symbol={spot.kind} data-symbol-event={'eventId' in spot.target ? spot.target.eventId : undefined}
      className={cn(hotspotClass, 'rounded-sm')} strokeWidth={1} rx={2} x={spot.bounds.x} y={spot.bounds.y} width={spot.bounds.width} height={spot.bounds.height}
      onFocus={() => setFocusedId(spot.id)}
      onClick={() => onSymbol(spot.kind, spot.target)}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); onSymbol(spot.kind, spot.target); }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          const next = (index + spots.length + (event.key === 'ArrowRight' ? 1 : -1)) % spots.length;
          event.currentTarget.ownerSVGElement?.querySelectorAll<SVGElement>('[data-symbol]')[next]?.focus();
        }
      }}>
      <title>{spot.label}</title>
    </rect>)}
    {design && groups.map(group => {
      const on = breaks.has(group.measureId);
      const number = measureIndex.get(group.measureId) ?? 0;
      return <g key={`${group.measureId}:${group.system}`}>
        {group.beats.map(beat => <rect key={beat.eventId} role="slider" tabIndex={-1} aria-label={t('score.beatSpacing', { bar: number })} aria-valuenow={Math.round(beat.bounds.width / scale)}
          data-design-spacing={beat.eventId} className={cn(hotspotClass, 'cursor-col-resize')} strokeWidth={1}
          x={beat.bounds.x + beat.bounds.width - 0.6 * tier} y={group.box.y + group.box.height * 0.3} width={0.6 * tier} height={group.box.height * 0.4}
          onPointerDown={event => beginDrag(event, group, beat)}
          onPointerMove={event => { if (currentDrag?.hit === beat) setDrag({ ...currentDrag, currentX: event.clientX }); }}
          onPointerUp={endDrag} onPointerCancel={() => setDrag(null)} />)}
        <rect role="button" tabIndex={-1} aria-pressed={on} aria-label={t('score.lineBreak', { bar: number })} data-design-break={group.measureId}
          className={cn(hotspotClass, on && 'fill-accent/40 stroke-accent')} strokeWidth={1}
          x={group.box.x + group.box.width + 0.1 * tier} y={group.box.y} width={0.9 * tier} height={group.box.height}
          onClick={() => onLineBreak(group.measureId)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onLineBreak(group.measureId); } }}>
          <title>{on ? t('score.lineBreak.remove', { bar: number }) : t('score.lineBreak.add', { bar: number })}</title>
        </rect>
      </g>;
    })}
    {currentDrag && <line className="stroke-selection-edge" strokeWidth={2} strokeDasharray="4 2"
      x1={currentDrag.hit.bounds.x + currentDrag.hit.bounds.width + currentDrag.currentX - currentDrag.startX} x2={currentDrag.hit.bounds.x + currentDrag.hit.bounds.width + currentDrag.currentX - currentDrag.startX}
      y1={currentDrag.group.box.y} y2={currentDrag.group.box.y + currentDrag.group.box.height} />}
  </svg>;
}
