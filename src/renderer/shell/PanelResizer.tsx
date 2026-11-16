import type { KeyboardEvent, PointerEvent } from 'react';
import { useRef } from 'react';
import { useT } from '../i18n/react';
import { cn } from '../lib/cn';
import { panelLimits } from './workspace';
import type { PanelId } from './workspace';

export type PanelResizerProps = {
  readonly panel: PanelId;
  readonly size: number;
  readonly onResize: (size: number) => void;
  /** Which screen edge of the panel the handle sits on; drag away from the panel grows it. */
  readonly edge: 'left' | 'right' | 'top';
};
const keyboardStep = 16;

export function PanelResizer({ panel, size, onResize, edge }: PanelResizerProps) {
  const t = useT();
  const drag = useRef<{ readonly origin: number; readonly size: number } | null>(null);
  const horizontal = edge === 'top';
  const direction = edge === 'left' ? -1 : edge === 'right' ? 1 : -1;
  const position = (event: PointerEvent<HTMLDivElement>): number => (horizontal ? event.clientY : event.clientX);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const grow = horizontal ? ['ArrowUp'] : edge === 'left' ? ['ArrowLeft'] : ['ArrowRight'];
    const shrink = horizontal ? ['ArrowDown'] : edge === 'left' ? ['ArrowRight'] : ['ArrowLeft'];
    if (grow.includes(event.key)) { event.preventDefault(); onResize(size + keyboardStep); }
    else if (shrink.includes(event.key)) { event.preventDefault(); onResize(size - keyboardStep); }
    else if (event.key === 'Home') { event.preventDefault(); onResize(panelLimits[panel].min); }
    else if (event.key === 'End') { event.preventDefault(); onResize(panelLimits[panel].max); }
  };
  return (
    <div role="separator" tabIndex={0} aria-label={t('shell.resize', { panel })} aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-valuemin={panelLimits[panel].min} aria-valuemax={panelLimits[panel].max} aria-valuenow={size} data-resizer={panel}
      onKeyDown={onKeyDown}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { origin: position(event), size }; }}
      onPointerMove={event => { if (drag.current) onResize(drag.current.size + direction * (position(event) - drag.current.origin)); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      className={cn('absolute z-10 touch-none bg-transparent outline-none transition-colors hover:bg-accent focus-visible:bg-accent',
        horizontal ? 'inset-x-0 top-0 h-1 cursor-row-resize' : 'inset-y-0 w-1 cursor-col-resize', edge === 'left' && 'left-0', edge === 'right' && 'right-0')} />
  );
}
