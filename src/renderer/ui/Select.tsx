import { getNonce } from 'get-nonce';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { fieldBase } from './control';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export type SelectTriggerProps = ComponentProps<typeof SelectPrimitive.Trigger> & { readonly size?: 'compact' | 'default' };

export function SelectTrigger({ className, size = 'default', children, ...props }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(fieldBase, 'w-auto items-center justify-between gap-2 data-[placeholder]:text-subtle data-[disabled]:pointer-events-none data-[disabled]:opacity-(--disabled-opacity)',
        size === 'compact' ? 'h-control-compact text-2xs' : 'h-control-default', className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild><ChevronDown className="size-3.5 text-muted" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, position = 'popper', ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={4}
        className={cn('z-50 rounded-lg border border-border bg-panel-raised text-fg shadow-popover outline-none data-[state=open]:animate-fade-in', 'max-h-72 min-w-(--radix-select-trigger-width) overflow-hidden p-1', className)}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-5 items-center justify-center text-muted"><ChevronUp className="size-3.5" /></SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport {...(getNonce() === undefined ? {} : { nonce: getNonce() })}>{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-5 items-center justify-center text-muted"><ChevronDown className="size-3.5" /></SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn('relative flex h-control-compact cursor-default select-none items-center gap-2 rounded-sm px-2 text-xs outline-none data-[highlighted]:bg-accent data-[highlighted]:text-on-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-(--disabled-opacity) [&_svg]:size-icon-sm', 'pl-7', className)}
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="absolute left-2 flex items-center"><Check className="size-3.5" /></SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn('px-2 py-1 text-2xs font-medium text-subtle', className)} {...props} />;
}

export function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
