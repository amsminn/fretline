import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './control';

export type ScrollAreaProps = ComponentProps<'div'> & { readonly orientation?: 'vertical' | 'horizontal' | 'both' };

const overflow = { vertical: 'overflow-y-auto overflow-x-hidden', horizontal: 'overflow-x-auto overflow-y-hidden', both: 'overflow-auto' } as const;

export function ScrollArea({ className, orientation = 'vertical', tabIndex = 0, ...props }: ScrollAreaProps) {
  return (
    <div
      data-slot="scroll-area"
      tabIndex={tabIndex}
      className={cn('relative min-h-0 min-w-0 overscroll-contain outline-none', focusRing, 'focus-visible:-outline-offset-2', overflow[orientation], className)}
      {...props}
    />
  );
}
