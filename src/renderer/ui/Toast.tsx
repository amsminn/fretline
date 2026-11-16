import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { useT } from '../i18n/react';
import { cn } from '../lib/cn';
import { focusRing } from './control';

export function ToastProvider(props: ComponentProps<typeof ToastPrimitive.Provider>) {
  return <ToastPrimitive.Provider swipeDirection="right" duration={5000} {...props} />;
}

export function ToastViewport({ className, ...props }: ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn('fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none', className)}
      {...props}
    />
  );
}

export const toastVariants = cva(
  'group relative flex items-start gap-3 rounded-lg border bg-panel-raised p-3 pr-8 text-xs text-fg shadow-popover outline-none data-[state=open]:animate-fade-in ' +
  'data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x) data-[swipe=end]:translate-x-(--radix-toast-swipe-end-x) data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform',
  {
    variants: {
      tone: { info: 'border-border', success: 'border-success', warning: 'border-warning', danger: 'border-danger' },
    },
    defaultVariants: { tone: 'info' },
  },
);

export type ToastProps = ComponentProps<typeof ToastPrimitive.Root> & VariantProps<typeof toastVariants>;

export function Toast({ className, tone, children, ...props }: ToastProps) {
  const t = useT();
  return (
    <ToastPrimitive.Root data-slot="toast" className={cn(toastVariants({ tone }), className)} {...props}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      <ToastPrimitive.Close aria-label={t('ui.closeToast')} className={cn('absolute right-2 top-2 flex size-5 items-center justify-center rounded-sm text-muted outline-none hover:bg-hover hover:text-fg', focusRing)}>
        <X className="size-3.5" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

export function ToastTitle({ className, ...props }: ComponentProps<typeof ToastPrimitive.Title>) {
  return <ToastPrimitive.Title className={cn('font-semibold', className)} {...props} />;
}

export function ToastDescription({ className, ...props }: ComponentProps<typeof ToastPrimitive.Description>) {
  return <ToastPrimitive.Description className={cn('text-muted', className)} {...props} />;
}

export function ToastAction({ className, ...props }: ComponentProps<typeof ToastPrimitive.Action>) {
  return (
    <ToastPrimitive.Action
      className={cn('mt-1 inline-flex h-control-compact w-fit items-center rounded-md border border-border bg-panel px-2 text-2xs font-medium outline-none hover:bg-hover active:bg-pressed', focusRing, className)}
      {...props}
    />
  );
}
