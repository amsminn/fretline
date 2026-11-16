import { ContextMenu as Primitive } from 'radix-ui';
import { Check, ChevronRight } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { formatShortcut } from '../lib/shortcut-format';

const itemClass = 'relative flex h-control-compact cursor-default select-none items-center gap-2 rounded-sm px-2 text-xs outline-none data-[highlighted]:bg-accent data-[highlighted]:text-on-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-(--disabled-opacity) [&_svg]:size-icon-sm';
const contentClass = 'z-50 rounded-lg border border-border bg-panel-raised text-fg shadow-popover outline-none data-[state=open]:animate-fade-in min-w-40 p-1';

export const ContextMenu = Primitive.Root;
export const ContextMenuTrigger = Primitive.Trigger;
export const ContextMenuGroup = Primitive.Group;
export const ContextMenuSub = Primitive.Sub;
export const ContextMenuRadioGroup = Primitive.RadioGroup;

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content data-slot="context-menu" className={cn(contentClass, className)} {...props} />
    </Primitive.Portal>
  );
}

export function ContextMenuSubContent({ className, ...props }: ComponentProps<typeof Primitive.SubContent>) {
  return <Primitive.Portal><Primitive.SubContent data-slot="context-menu-sub" className={cn(contentClass, className)} {...props} /></Primitive.Portal>;
}

export function ContextMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof Primitive.SubTrigger>) {
  return (
    <Primitive.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-hover', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </Primitive.SubTrigger>
  );
}

export type ContextMenuItemProps = ComponentProps<typeof Primitive.Item> & { readonly shortcut?: string; readonly destructive?: boolean };

export function ContextMenuItem({ className, children, shortcut, destructive = false, ...props }: ContextMenuItemProps) {
  return (
    <Primitive.Item className={cn(itemClass, destructive && 'text-danger', className)} {...props}>
      {children}
      {shortcut && <span className="ml-auto pl-4 font-mono text-2xs text-muted group-data-[highlighted]:text-on-accent">{formatShortcut(shortcut)}</span>}
    </Primitive.Item>
  );
}

export function ContextMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof Primitive.CheckboxItem>) {
  return (
    <Primitive.CheckboxItem className={cn(itemClass, 'pl-7', className)} {...props}>
      <Primitive.ItemIndicator className="absolute left-2 flex items-center"><Check className="size-3.5" /></Primitive.ItemIndicator>
      {children}
    </Primitive.CheckboxItem>
  );
}

export function ContextMenuRadioItem({ className, children, ...props }: ComponentProps<typeof Primitive.RadioItem>) {
  return (
    <Primitive.RadioItem className={cn(itemClass, 'pl-7', className)} {...props}>
      <Primitive.ItemIndicator className="absolute left-2 flex items-center"><span className="size-1.5 rounded-full bg-current" /></Primitive.ItemIndicator>
      {children}
    </Primitive.RadioItem>
  );
}

export function ContextMenuLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return <Primitive.Label className={cn('px-2 py-1 text-2xs font-medium text-subtle', className)} {...props} />;
}

export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
