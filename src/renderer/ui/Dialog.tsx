import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { useRef } from 'react';
import { useT } from '../i18n/react';
import { cn } from '../lib/cn';
import { IconButton } from './IconButton';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, onOpenAutoFocus, onCloseAutoFocus, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  const t = useT();
  const opener = useRef<Element | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-app/60 data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content
        data-slot="dialog"
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-border-strong bg-panel p-4 text-fg shadow-dialog outline-none',
          'data-[state=open]:animate-fade-in',
          className,
        )}
        {...props}
        onOpenAutoFocus={event => {
          // Command-opened dialogs have no Radix trigger. Capture before the focus scope moves focus inside.
          opener.current = document.activeElement;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={event => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const previous = opener.current;
          const owner = previous?.ownerDocument ?? document;
          // Radix dispatches close autofocus after unmount. A replacement surface may
          // already own focus, including an autoFocus input whose mount callback never ran.
          event.preventDefault();
          const active = owner.activeElement;
          if (active && active !== owner.body && !(event.target instanceof Node && event.target.contains(active))) return;
          // Re-engraving can replace a focused SVG hotspot while the dialog is open.
          const target = previous?.isConnected && previous !== owner.body &&
            (previous instanceof HTMLElement || previous instanceof SVGElement)
            ? previous : owner.querySelector<HTMLElement>('[data-area="score"] [data-testid="score-view"]');
          if (target) {
            target.focus({ preventScroll: true });
          }
        }}
      >
        {children}
        <DialogPrimitive.Close asChild>
          <IconButton label={t('ui.close')} shortcut="Esc" size="compact" className="absolute right-2 top-2"><X /></IconButton>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1 pr-6', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('flex justify-end gap-2 pt-1', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-base font-semibold leading-none', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-xs text-muted', className)} {...props} />;
}
