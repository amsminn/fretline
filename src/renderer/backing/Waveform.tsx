import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { peakColumns } from '../../adapters/backing/peaks';
import type { PeakPyramid } from '../../adapters/backing/peaks';
import { useT } from '../i18n/react';
import { cn } from '../lib/cn';
import type { GridMeasure } from './timeline';

export type WaveformMarker = { readonly index: number; readonly mediaSeconds: number; readonly label: string };
export type WaveformProps = {
  readonly pyramid: PeakPyramid | null;
  readonly duration: number;
  readonly offsetSeconds: number;
  readonly measures: readonly GridMeasure[];
  readonly markers: readonly WaveformMarker[];
  readonly cursorSeconds: number | null;
  readonly editable: boolean;
  readonly onMoveMarker: (index: number, mediaSeconds: number) => void;
  readonly onRemoveMarker: (index: number) => void;
  readonly onOffset: (offsetSeconds: number) => void;
};
type Drag =
  | { readonly kind: 'marker'; readonly index: number; readonly startX: number; readonly origin: number; preview: number }
  | { readonly kind: 'offset'; readonly startX: number; readonly origin: number; preview: number };

const token = (element: HTMLElement, name: string): string => getComputedStyle(element).getPropertyValue(name).trim();
const nudgeStep = (event: KeyboardEvent): number => (event.shiftKey ? 0.5 : event.altKey ? 0.005 : 0.05);

export function Waveform(props: WaveformProps) {
  const t = useT();
  const { pyramid, duration, measures, markers, cursorSeconds, editable } = props;
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const span = Math.max(duration, 0.001);
  const offsetPreview = drag?.kind === 'offset' ? drag.preview : props.offsetSeconds;
  const shift = offsetPreview - props.offsetSeconds;
  const x = (seconds: number): number => seconds / span * width;
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => { for (const entry of entries) setWidth(entry.contentRect.width); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = canvas.current; const surface = host.current;
    if (!element || !surface || width <= 0) return;
    const height = surface.getBoundingClientRect().height;
    const scale = window.devicePixelRatio || 1;
    element.width = Math.round(width * scale); element.height = Math.round(height * scale);
    const context = element.getContext('2d');
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    const middle = height / 2;
    if (pyramid) {
      context.fillStyle = token(surface, '--fg-muted');
      for (const [column, peak] of peakColumns(pyramid, 0, duration, Math.round(width)).entries()) {
        const top = middle - Math.max(0.5, peak.max * middle * 0.9);
        const bottom = middle - Math.min(-0.5, peak.min * middle * 0.9);
        context.fillRect(column, top, 1, bottom - top);
      }
    }
    context.strokeStyle = token(surface, '--fg-subtle'); context.lineWidth = 1;
    for (const measure of measures) for (const beat of measure.beats) {
      const position = Math.round(x(beat + shift)) + 0.5;
      context.beginPath(); context.moveTo(position, height - 6); context.lineTo(position, height); context.stroke();
    }
    context.strokeStyle = token(surface, '--border-strong');
    context.fillStyle = token(surface, '--fg-muted');
    context.font = `${token(surface, '--text-2xs') || '11px'} ${token(surface, '--font-mono')}`;
    context.textBaseline = 'top';
    for (const measure of measures) {
      const position = Math.round(x(measure.mediaStart + shift)) + 0.5;
      context.beginPath(); context.moveTo(position, 0); context.lineTo(position, height); context.stroke();
      context.fillText(String(measure.index + 1), position + 3, 12);
    }
  }, [pyramid, duration, measures, width, shift, span]);
  const beginMarker = (event: PointerEvent<HTMLButtonElement>, marker: WaveformMarker): void => {
    if (!editable || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ kind: 'marker', index: marker.index, startX: event.clientX, origin: marker.mediaSeconds, preview: marker.mediaSeconds });
  };
  const beginOffset = (event: PointerEvent<HTMLDivElement>): void => {
    if (!editable || event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ kind: 'offset', startX: event.clientX, origin: props.offsetSeconds, preview: props.offsetSeconds });
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    if (!drag) return;
    const delta = (event.clientX - drag.startX) / Math.max(1, width) * span;
    switch (drag.kind) {
      case 'marker': setDrag({ ...drag, preview: Math.max(0, Math.min(duration, drag.origin + delta)) }); break;
      case 'offset': setDrag({ ...drag, preview: drag.origin - delta }); break;
      default: { const exhaustive: never = drag; throw new RangeError(String(exhaustive)); }
    }
  };
  const finish = (event: PointerEvent<HTMLElement>): void => {
    if (!drag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
    switch (drag.kind) {
      case 'marker': if (drag.preview !== drag.origin) props.onMoveMarker(drag.index, Number(drag.preview.toFixed(3))); break;
      case 'offset': if (drag.preview !== drag.origin) props.onOffset(Number(drag.preview.toFixed(3))); break;
      default: { const exhaustive: never = drag; throw new RangeError(String(exhaustive)); }
    }
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, marker: WaveformMarker): void => {
    if (!editable) return;
    switch (event.key) {
      case 'ArrowLeft': event.preventDefault(); props.onMoveMarker(marker.index, Number(Math.max(0, marker.mediaSeconds - nudgeStep(event)).toFixed(3))); break;
      case 'ArrowRight': event.preventDefault(); props.onMoveMarker(marker.index, Number(Math.min(duration, marker.mediaSeconds + nudgeStep(event)).toFixed(3))); break;
      case 'Delete': case 'Backspace': event.preventDefault(); props.onRemoveMarker(marker.index); break;
      default: break;
    }
  };
  return (
    <div ref={host} data-testid="backing-waveform" data-dragging={drag?.kind ?? 'none'} data-offset={offsetPreview}
      className={cn('relative h-full min-h-16 w-full select-none overflow-hidden rounded-md border border-border bg-input', editable && 'cursor-ew-resize')}
      onPointerDown={beginOffset} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}
      title={editable ? t('backing.dragHint') : undefined}>
      <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 size-full" />
      {cursorSeconds !== null && cursorSeconds >= 0 && cursorSeconds <= duration && (
        <div data-testid="backing-cursor" aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-playback-cursor" style={{ left: x(cursorSeconds) }} />
      )}
      {markers.map(marker => {
        const preview = drag?.kind === 'marker' && drag.index === marker.index ? drag.preview : marker.mediaSeconds;
        return (
          <button key={marker.index} type="button" data-sync-marker={marker.index} data-media={preview}
            aria-label={t('backing.marker', { index: marker.index + 1, label: marker.label })} title={t('backing.markerHint', { label: marker.label })}
            disabled={!editable}
            className={cn('group absolute inset-y-0 -ml-2 w-4 cursor-col-resize outline-none focus-visible:bg-selection-fill disabled:cursor-default', drag?.kind === 'marker' && drag.index === marker.index && 'bg-selection-fill')}
            style={{ left: x(preview) }}
            onPointerDown={event => beginMarker(event, marker)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}
            onKeyDown={event => keyboard(event, marker)}>
            <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent group-hover:bg-accent-hover group-focus-visible:bg-accent-hover" />
            <span aria-hidden="true" className="absolute left-1/2 top-0 size-2.5 -translate-x-1/2 rotate-45 rounded-sm bg-accent group-hover:bg-accent-hover group-focus-visible:bg-accent-hover" />
          </button>
        );
      })}
    </div>
  );
}
