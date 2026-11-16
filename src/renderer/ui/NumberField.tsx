import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { useT } from '../i18n/react';
import { cn } from '../lib/cn';
import { fieldBase } from './control';

export type NumberFieldProps = {
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly label: string;
  readonly unit?: string;
  readonly disabled?: boolean;
  readonly className?: string;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const decimals = (step: number): number => (step.toString().split('.')[1] ?? '').length;

export function NumberField({ value, onValueChange, min = -Infinity, max = Infinity, step = 1, label, unit, disabled = false, className }: NumberFieldProps) {
  const t = useT();
  const id = useId();
  const commit = (next: number): void => {
    if (Number.isFinite(next)) onValueChange(Number(clamp(next, min, max).toFixed(decimals(step))));
  };
  const nudge = (direction: 1 | -1, multiplier = 1): void => commit(value + direction * step * multiplier);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const multiplier = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case 'ArrowUp': event.preventDefault(); nudge(1, multiplier); break;
      case 'ArrowDown': event.preventDefault(); nudge(-1, multiplier); break;
      case 'Home': if (Number.isFinite(min)) { event.preventDefault(); commit(min); } break;
      case 'End': if (Number.isFinite(max)) { event.preventDefault(); commit(max); } break;
      default: break;
    }
  };
  const onChange = (event: ChangeEvent<HTMLInputElement>): void => commit(Number(event.currentTarget.value));
  const stepper = 'flex h-1/2 w-5 items-center justify-center border-l border-border text-muted hover:bg-hover hover:text-fg active:bg-pressed ' +
    'disabled:pointer-events-none disabled:opacity-(--disabled-opacity) [&_svg]:size-3';
  return (
    <div data-slot="number-field" className={cn('inline-flex h-control-default items-stretch overflow-hidden rounded-md border border-border bg-input', disabled && 'opacity-(--disabled-opacity) pointer-events-none', className)}>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        role="spinbutton"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={Number.isFinite(min) ? min : undefined}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        value={value}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        step={step}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onChange={onChange}
        className={cn(fieldBase, 'h-auto w-16 rounded-none border-0 bg-transparent font-mono tabular-nums hover:border-transparent')}
      />
      {unit && <span className="flex items-center pr-1.5 font-mono text-2xs text-subtle">{unit}</span>}
      <div className="flex flex-col">
        <button type="button" tabIndex={-1} aria-label={t('ui.increase', { label })} disabled={disabled} onClick={() => nudge(1)} className={stepper}><ChevronUp /></button>
        <button type="button" tabIndex={-1} aria-label={t('ui.decrease', { label })} disabled={disabled} onClick={() => nudge(-1)} className={cn(stepper, 'border-t')}><ChevronDown /></button>
      </div>
    </div>
  );
}
