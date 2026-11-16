/**
 * Shared focus-visible ring. `outline-solid` is explicit because `outline-none`
 * (used to clear the UA ring) sets `--tw-outline-style: none`, which `outline-*`
 * width utilities would otherwise inherit and render no ring at all.
 */
export const focusRing =
  'focus-visible:outline-solid focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-offset-(--focus-ring-offset) focus-visible:outline-focus-ring';

export const controlBase =
  'inline-flex items-center justify-center gap-1 whitespace-nowrap select-none rounded-md border text-xs font-medium ' +
  `transition-colors outline-none ${focusRing} ` +
  'disabled:pointer-events-none disabled:opacity-(--disabled-opacity) data-[disabled]:pointer-events-none data-[disabled]:opacity-(--disabled-opacity)';

export const controlSizes = {
  compact: 'h-control-compact px-2 text-2xs',
  default: 'h-control-default px-2.5',
  toolbar: 'h-control-toolbar px-3 text-sm',
} as const;

export const iconSizes = {
  compact: 'size-control-compact',
  default: 'size-control-default',
  toolbar: 'size-control-toolbar',
  toolbarCompact: 'h-control-toolbar w-control-default',
} as const;

export const fieldBase =
  'flex w-full rounded-md border border-border bg-input px-2 text-xs text-fg placeholder:text-subtle ' +
  `transition-colors outline-none hover:border-border-strong ${focusRing} ` +
  'disabled:pointer-events-none disabled:opacity-(--disabled-opacity) aria-invalid:border-danger';
