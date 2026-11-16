import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { Toggle as TogglePrimitive, ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { controlBase, controlSizes } from './control';

export const toggleVariants = cva(
  cn(controlBase, 'border-transparent bg-transparent text-muted hover:bg-hover hover:text-fg active:bg-pressed ' +
    'data-[state=on]:bg-pressed data-[state=on]:text-accent-hover data-[state=on]:border-border [&_svg]:size-icon-sm [&_svg]:shrink-0'),
  { variants: { size: controlSizes }, defaultVariants: { size: 'default' } },
);

export type ToggleButtonProps = ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>;

export function ToggleButton({ className, size, ...props }: ToggleButtonProps) {
  return <TogglePrimitive.Root data-slot="toggle" className={cn(toggleVariants({ size }), className)} {...props} />;
}

export function ToggleGroup({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return <ToggleGroupPrimitive.Root data-slot="toggle-group" className={cn('inline-flex items-center gap-0.5 rounded-md', className)} {...props} />;
}

export type ToggleGroupItemProps = ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>;

export function ToggleGroupItem({ className, size, ...props }: ToggleGroupItemProps) {
  return <ToggleGroupPrimitive.Item data-slot="toggle-group-item" className={cn(toggleVariants({ size }), className)} {...props} />;
}
