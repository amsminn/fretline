import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './control';

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-border-strong bg-pressed p-px transition-colors',
        'outline-none hover:border-accent-hover', focusRing,
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'disabled:pointer-events-none disabled:opacity-(--disabled-opacity)',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-3 rounded-full bg-fg transition-transform data-[state=checked]:translate-x-3 data-[state=checked]:bg-on-accent" />
    </SwitchPrimitive.Root>
  );
}
