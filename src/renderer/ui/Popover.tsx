import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({ className, align = 'start', sideOffset = 4, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover"
        align={align}
        sideOffset={sideOffset}
        className={cn('z-50 rounded-lg border border-border bg-panel-raised text-fg shadow-popover outline-none data-[state=open]:animate-fade-in', 'w-64 p-3', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
