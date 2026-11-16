import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { fieldBase } from './control';

export type InputProps = Omit<ComponentProps<'input'>, 'size'> & { readonly size?: 'compact' | 'default' };

const heights = { compact: 'h-control-compact text-2xs', default: 'h-control-default' } as const;

export function Input({ className, size = 'default', ...props }: InputProps) {
  return <input data-slot="input" className={cn(fieldBase, heights[size], className)} {...props} />;
}
