import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { formatShortcut } from '../lib/shortcut-format';

export function TooltipProvider(props: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={200} {...props} />;
}

export type TooltipProps = {
  readonly content: ReactNode;
  readonly shortcut?: string;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  readonly children: ReactNode;
};

export function Shortcut({ keys, className }: { readonly keys: string; readonly className?: string }) {
  return <kbd data-slot="shortcut" className={cn('ml-2 rounded-sm border border-border bg-input px-1 font-mono text-2xs text-muted', className)}>{formatShortcut(keys)}</kbd>;
}

export function Tooltip({ content, shortcut, side = 'bottom', children }: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          data-slot="tooltip"
          side={side}
          sideOffset={4}
          className="z-50 flex items-center rounded-md border border-border bg-panel-raised px-2 py-1 text-xs text-fg shadow-popover"
        >
          {content}
          {shortcut && <Shortcut keys={shortcut} />}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
