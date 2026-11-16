import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './control';

export type KnobProps = {
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly label: string;
  readonly formatValue?: (value: number) => string;
  readonly disabled?: boolean;
  readonly className?: string;
};

const sweep = 270;
const startAngle = -135;
const radius = 10;
const toPoint = (angle: number): readonly [number, number] => {
  const radians = (angle - 90) * (Math.PI / 180);
  return [12 + radius * Math.cos(radians), 12 + radius * Math.sin(radians)];
};
const arc = (from: number, to: number): string => {
  const [x1, y1] = toPoint(from);
  const [x2, y2] = toPoint(to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const direction = to >= from ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} ${direction} ${x2} ${y2}`;
};
const pixelsPerStep = 3;

export function Knob({ value, onValueChange, min = -1, max = 1, step = 0.01, label, formatValue, disabled = false, className }: KnobProps) {
  const drag = useRef<{ readonly y: number; readonly value: number } | null>(null);
  const decimals = (step.toString().split('.')[1] ?? '').length;
  const commit = (next: number): void => onValueChange(Number(Math.min(max, Math.max(min, next)).toFixed(decimals)));
  const fraction = (value - min) / (max - min);
  const center = min < 0 && max > 0 ? (0 - min) / (max - min) : 0;
  const angleAt = (f: number): number => startAngle + f * sweep;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const multiplier = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case 'ArrowUp': case 'ArrowRight': event.preventDefault(); commit(value + step * multiplier); break;
      case 'ArrowDown': case 'ArrowLeft': event.preventDefault(); commit(value - step * multiplier); break;
      case 'Home': event.preventDefault(); commit(min); break;
      case 'End': event.preventDefault(); commit(max); break;
      case 'PageUp': event.preventDefault(); commit(value + (max - min) / 10); break;
      case 'PageDown': event.preventDefault(); commit(value - (max - min) / 10); break;
      default: break;
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    drag.current = { y: event.clientY, value };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    const steps = Math.round((drag.current.y - event.clientY) / pixelsPerStep);
    commit(drag.current.value + steps * step * (event.shiftKey ? 0.1 : 1));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const text = formatValue ? formatValue(value) : value.toFixed(decimals);
  return (
    <div
      data-slot="knob"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={text}
      aria-disabled={disabled || undefined}
      onKeyDown={disabled ? undefined : onKeyDown}
      onDoubleClick={disabled ? undefined : () => commit(min < 0 && max > 0 ? 0 : min)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn('inline-flex size-control-default cursor-ns-resize touch-none select-none items-center justify-center rounded-full text-muted outline-none transition-colors',
        'hover:text-fg', focusRing,
        disabled && 'pointer-events-none opacity-(--disabled-opacity)', className)}
    >
      <svg viewBox="0 0 24 24" className="size-icon-md" aria-hidden="true">
        <path d={arc(angleAt(0), angleAt(1))} fill="none" stroke="var(--bg-pressed)" strokeWidth="2.5" strokeLinecap="round" />
        {fraction !== center && <path d={arc(angleAt(center), angleAt(fraction))} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />}
        <line x1="12" y1="12" x2={toPoint(angleAt(fraction))[0]} y2={toPoint(angleAt(fraction))[1]} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  );
}
