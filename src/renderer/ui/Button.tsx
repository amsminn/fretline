import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { controlBase, controlSizes } from './control';

export const buttonVariants = cva(controlBase, {
  variants: {
    variant: {
      default: 'border-border bg-panel-raised text-fg hover:bg-hover active:bg-pressed',
      primary: 'border-accent bg-accent text-on-accent hover:bg-accent-hover hover:border-accent-hover active:bg-accent-active active:border-accent-active',
      ghost: 'border-transparent bg-transparent text-fg hover:bg-hover active:bg-pressed',
      danger: 'border-danger bg-transparent text-danger hover:bg-hover active:bg-pressed',
    },
    size: controlSizes,
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { readonly asChild?: boolean };

export function Button({ className, variant, size, asChild = false, type = 'button', ...props }: ButtonProps) {
  const Component = asChild ? Slot.Root : 'button';
  return <Component data-slot="button" type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
