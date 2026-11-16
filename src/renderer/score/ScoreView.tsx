import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { model, rendering, StaveProfile } from '@coderline/alphatab/core';
import type { ScoreDocument } from '../../domain/document';
import type { TrackId } from '../../domain/ids';
import { ScoreProjector } from '../../adapters/alphatab/project';
import type { ScoreProjection } from '../../adapters/alphatab/project';
import { visibleHitMap } from './visible-hit-map';
import { buildHitMap, hitTest } from './overlay';
import type { ScoreHit, ScoreHitMap, ScoreOverlayState } from './overlay';
import { OverlayLayer } from './OverlayLayer';
import { applySystemsLayout, renderProjection, scoreSvg } from './render';
import type { RenderInput } from './render';
import { lyricMeasure, lyricPaperWidth } from './lyrics';
import { renderFrame } from './render-frame';
import { registerQaOwner } from '../audio/qa-owner-diagnostics';
import { useT } from '../i18n/react';
import './score.css';

export type ScoreMode = 'tab' | 'standard' | 'both';
export type ScoreViewProps = {
  readonly document: ScoreDocument;
  readonly mode?: ScoreMode;
  readonly trackIds?: readonly TrackId[];
  readonly zoom?: number;
  readonly overlay?: ScoreOverlayState;
  readonly onHit?: (hit: ScoreHit) => void;
  readonly onHitRejected?: () => void;
  readonly onRendered?: (map: ScoreHitMap) => void;
};
type Rendered = {
  readonly map: ScoreHitMap;
  readonly projection: ScoreProjection;
  readonly width: number;
  readonly height: number;
};
const emptyOverlay: ScoreOverlayState = {};

/** Long documents lay out once, then engrave only chunks near the actual scroll viewport. */
async function renderVisible(input: RenderInput & {
  readonly changed: (lookup: rendering.BoundsLookup, width: number, height: number) => void;
}, host: HTMLElement, signal: AbortSignal) {
  const { settings, score } = input.projection;
  settings.core.engine = 'svg';
  settings.core.enableLazyLoading = true;
  settings.player.enablePlayer = false;
  settings.display.scale = input.zoom;
  if (input.mode) settings.display.staveProfile = { tab: StaveProfile.Tab, standard: StaveProfile.Score, both: StaveProfile.ScoreTab }[input.mode];
  applySystemsLayout(settings, input.manualSpacing);
  const style = getComputedStyle(host);
  const ink = model.Color.fromJson(style.getPropertyValue('--paper-ink').trim());
  const staff = model.Color.fromJson(style.getPropertyValue('--paper-staff').trim());
  if (ink) {
    settings.display.resources.mainGlyphColor = ink;
    settings.display.resources.secondaryGlyphColor = ink;
    settings.display.resources.scoreInfoColor = ink;
    settings.display.resources.barNumberColor = ink;
  }
  if (staff) settings.display.resources.staffLineColor = staff;
  const fontSize = settings.display.resources.engravingSettings.musicFontSize;
  await document.fonts.load(`${fontSize}px alphaTab`);
  await document.fonts.ready;
  if (signal.aborted) return undefined;
  const renderer = new rendering.ScoreRenderer(settings);
  const releaseOwner = registerQaOwner('scoreRenderers');
  const paperWidth = lyricPaperWidth(score, settings, lyricMeasure(settings), input.width);
  renderer.width = paperWidth;
  const chunks = new Map<string, HTMLElement>();
  const layouts: rendering.RenderFinishedEventArgs[] = [];
  const existing = [...host.children];
  let width = 0;
  let height = 0;
  let complete = false;
  let failure: Error | undefined;
  const scroller = host.closest('.score-scroll');
  const painted = new Set<string>();
  let painting = false;
  const paintVisible = async (): Promise<void> => {
    if (painting) return;
    painting = true;
    try {
      for (;;) {
        if (complete && !await renderFrame(signal)) return;
        if (signal.aborted) return;
        const viewport = scroller?.getBoundingClientRect() ?? host.getBoundingClientRect();
        const origin = host.getBoundingClientRect().top;
        const visible = layouts.flatMap((layout, index) => origin + layout.y < viewport.bottom &&
          origin + layout.y + layout.height > viewport.top ? [index] : []);
        const first = visible[0];
        const last = visible.at(-1);
        if (first === undefined || last === undefined) return;
        const needed = layouts.slice(Math.max(0, first - 1), last + 2).filter(layout => !painted.has(layout.id));
        if (!needed.length) return;
        // Commit the bounded initial viewport together; later scroll work yields between chunks.
        for (const layout of complete ? needed.slice(0, 1) : needed) {
          painted.add(layout.id);
          renderer.renderResult(layout.id);
        }
        if (!complete) return;
      }
    } finally {
      painting = false;
    }
  };
  const scroll = (): void => { void paintVisible(); };
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    scroller?.removeEventListener('scroll', scroll); renderer.destroy(); releaseOwner();
  };
  signal.addEventListener('abort', dispose, { once: true });
  renderer.error.on(error => { failure = error; });
  renderer.partialRenderFinished.on(result => {
    if (typeof result.renderResult !== 'string') throw new TypeError('Expected SVG chunk');
    chunks.get(result.id)?.replaceChildren(scoreSvg(result.renderResult, fontSize, paperWidth - result.x));
    if (complete && renderer.boundsLookup) input.changed(renderer.boundsLookup, width, height);
  });
  renderer.partialLayoutFinished.on(result => {
    const previous = existing[layouts.length];
    const element = previous instanceof HTMLDivElement ? previous : document.createElement('div');
    layouts.push(result);
    element.setAttribute('data-render-chunk', result.id);
    Object.assign(element.style, { position: 'absolute', left: `${result.x}px`, top: `${result.y}px`,
      width: `${Math.min(result.width, paperWidth - result.x)}px`, height: `${result.height}px` });
    chunks.set(result.id, element);
    if (!element.parentNode) host.append(element);
  });
  renderer.renderFinished.on(result => { width = result.totalWidth; height = result.totalHeight; });
  renderer.renderScore(score, [...input.trackIndexes]);
  for (const element of existing.slice(layouts.length)) element.remove();
  await paintVisible();
  if (signal.aborted) return undefined;
  complete = true;
  if (failure) { dispose(); throw failure; }
  const lookup = renderer.boundsLookup;
  if (!lookup) { dispose(); throw new TypeError('Missing lazy render bounds'); }
  host.style.width = `${paperWidth}px`;
  host.style.height = `${height}px`;
  scroller?.addEventListener('scroll', scroll, { passive: true });
  return { lookup, width, height };
}

/** The canvas never owns document state; host callbacks dispatch editor commands using domain IDs. */
export function ScoreView({ document: scoreDocument, mode, trackIds, zoom, overlay = emptyOverlay,
  onHit, onHitRejected, onRendered }: ScoreViewProps) {
  const t = useT();
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const projector = useRef(new ScoreProjector());
  const hitMap = useRef<ScoreHitMap | undefined>(undefined);
  const pressed = useRef<ScoreHit | undefined>(undefined);
  const callbacks = useRef({ onHit, onHitRejected, onRendered });
  callbacks.current = { onHit, onHitRejected, onRendered };
  const [width, setWidth] = useState(0);
  const [rendered, setRendered] = useState<Rendered>();
  const [error, setError] = useState<string>();
  const previousRender = useRef<Rendered | undefined>(undefined);
  const trackKey = trackIds?.join(',') ?? '';

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const host = canvas.current;
    return () => {
      host?.replaceChildren();
      if (host) { host.style.width = ''; host.style.height = ''; }
      previousRender.current = undefined;
    };
  }, []);

  useLayoutEffect(() => {
    const host = canvas.current;
    if (!host || width <= 0) return;
    const emptyMap = visibleHitMap.begin(scoreDocument, host);
    const current = emptyMap.generation;
    hitMap.current = emptyMap;
    callbacks.current.onRendered?.(emptyMap);
    setRendered(undefined);
    setError(undefined);
    const controller = new AbortController();
    const fail = (message: string): void => {
      if (visibleHitMap.accepts(current)) setError(message);
    };
    const render = async (): Promise<void> => {
      try {
        if (scoreDocument.measures.length >= 128) {
          await Promise.resolve();
          if (controller.signal.aborted) return;
        }
        const projection = projector.current.project(scoreDocument, trackIds);
        const indexes = projection.score.tracks.map(track => track.index);
        const publish = (lookup: rendering.BoundsLookup, renderWidth: number, height: number): void => {
          if (!visibleHitMap.accepts(current)) return;
          const map = buildHitMap({ document: scoreDocument, projection, generation: current }, lookup);
          hitMap.current = map;
          visibleHitMap.publish(map);
          previousRender.current = { map, projection, width: renderWidth, height };
          setRendered(previousRender.current);
          callbacks.current.onRendered?.(map);
        };
        const input = { projection, width, trackIndexes: indexes, zoom: zoom ?? scoreDocument.layout.scale,
          manualSpacing: (scoreDocument.layout.eventSpacing?.length ?? 0) > 0, ...(mode ? { mode } : {}) };
        const result = scoreDocument.measures.length >= 128 && projection.nestedTuplets.length === 0
          ? await renderVisible({ ...input, changed: publish }, host, controller.signal)
          : await renderProjection(input, host, controller.signal);
        if (!result || !visibleHitMap.accepts(current)) return;
        publish(result.lookup, result.width, result.height);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        fail(error.message);
      }
    };
    void render();
    return () => {
      visibleHitMap.clear(current);
      hitMap.current = undefined;
      controller.abort();
    };
  }, [scoreDocument, mode, trackKey, zoom, width]);

  const pointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const bounds = canvas.current?.getBoundingClientRect();
    const map = hitMap.current;
    pressed.current = bounds && map && visibleHitMap.accepts(map.generation)
      ? hitTest(map, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, map.generation) : undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  };
  const pointerUp = (): void => {
    const hit = pressed.current;
    pressed.current = undefined;
    if (!hit) return;
    if (!visibleHitMap.accepts(hit.generation) || hitMap.current?.generation !== hit.generation) {
      callbacks.current.onHitRejected?.();
      return;
    }
    callbacks.current.onHit?.(hit);
  };
  return <div ref={container} className="score-view" data-testid="score-view" tabIndex={0}
    role="region" aria-label={t('score.region')} aria-busy={!rendered && !error} data-generation={rendered?.map.generation ?? ''}
    onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={() => {
      if (pressed.current) callbacks.current.onHitRejected?.();
      pressed.current = undefined;
    }}>
    {error ? <p role="alert" className="score-status">{error}</p> : null}
    {!rendered && !error && !previousRender.current ? <p role="status" className="score-status">{t('score.rendering')}</p> : null}
    <div className="score-canvas">
      <div ref={canvas} data-testid="score-engine" />
      {rendered ? <OverlayLayer hitMap={rendered.map} state={overlay} width={rendered.width}
        height={rendered.height} tuplets={rendered.projection.nestedTuplets}
        fontSize={scoreDocument.layout.stylesheet.fontSize} scale={rendered.projection.settings.display.scale} /> : null}
    </div>
  </div>;
}
