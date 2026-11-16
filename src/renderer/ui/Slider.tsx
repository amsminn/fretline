import { Slider as SliderPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { focusRing } from './control';

export type SliderProps = ComponentProps<typeof SliderPrimitive.Root> & { readonly label: string };

export function Slider({ className, label, orientation = 'horizontal', ...props }: SliderProps) {
  const vertical = orientation === 'vertical';
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      orientation={orientation}
      className={cn('relative flex touch-none select-none items-center data-[disabled]:pointer-events-none data-[disabled]:opacity-(--disabled-opacity)',
        vertical ? 'h-24 w-4 flex-col' : 'h-4 w-full', className)}
      {...props}
    >
      <SliderPrimitive.Track className={cn('relative grow overflow-hidden rounded-full bg-pressed', vertical ? 'w-1' : 'h-1')}>
        <SliderPrimitive.Range className={cn('absolute bg-accent', vertical ? 'w-full' : 'h-full')} />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={label}
        className={cn('block size-3 rounded-full border border-border-strong bg-fg outline-none transition-colors hover:border-accent-hover', focusRing)}
      />
    </SliderPrimitive.Root>
  );
}
