import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { controlBase, iconSizes } from './control';
import { Tooltip } from './Tooltip';

export const iconButtonVariants = cva(cn(controlBase, 'p-0 [&_svg]:size-icon-sm [&_svg]:shrink-0'), {
  variants: {
    variant: {
      default: 'border-border bg-panel-raised text-fg hover:bg-hover active:bg-pressed',
      ghost: 'border-transparent bg-transparent text-muted hover:bg-hover hover:text-fg active:bg-pressed',
      primary: 'border-accent bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active',
    },
    size: iconSizes,
  },
  defaultVariants: { variant: 'ghost', size: 'default' },
});

export type IconButtonProps = Omit<ComponentProps<'button'>, 'aria-label'> & VariantProps<typeof iconButtonVariants> & {
  readonly label: string;
  readonly shortcut?: string;
};

export function IconButton({ className, variant, size, label, shortcut, type = 'button', ...props }: IconButtonProps) {
  return (
    <Tooltip content={label} {...(shortcut === undefined ? {} : { shortcut })}>
      <button data-slot="icon-button" type={type} aria-label={label} className={cn(iconButtonVariants({ variant, size }), className)} {...props} />
    </Tooltip>
  );
}
