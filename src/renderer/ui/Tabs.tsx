import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './control';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn('flex h-area-tabs items-end gap-px border-b border-border bg-toolbar px-1', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex h-[calc(var(--area-tabs)-4px)] items-center gap-1.5 rounded-t-md border border-b-0 border-transparent px-3 text-xs text-muted outline-none transition-colors',
        'hover:bg-hover hover:text-fg', focusRing, 'focus-visible:-outline-offset-2',
        'data-[state=active]:border-border data-[state=active]:bg-panel data-[state=active]:text-fg',
        'disabled:pointer-events-none disabled:opacity-(--disabled-opacity)',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('outline-none', focusRing, className)} {...props} />;
}
