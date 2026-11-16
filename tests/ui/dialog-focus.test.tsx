import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '../../src/renderer/ui/Dialog';
import { Popover, PopoverContent } from '../../src/renderer/ui/Popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '../../src/renderer/ui/DropdownMenu';
import { TooltipProvider } from '../../src/renderer/ui/Tooltip';

afterEach(cleanup);

function Harness({ replaced = false }: { readonly replaced?: boolean }) {
  const [open, setOpen] = useState(false);
  const openFromKey = (event: { readonly key: string }): void => { if (event.key === 'b') setOpen(true); };
  return <TooltipProvider>
    <main data-area="score">
      <div data-testid="score-view" tabIndex={0} onKeyDown={openFromKey}>Score</div>
      <svg><rect key={String(replaced)} role="button" aria-label="Score symbol" tabIndex={0} onKeyDown={openFromKey} /></svg>
    </main>
    <aside data-area="inspector"><input key={String(replaced)} aria-label="Inspector title" onKeyDown={openFromKey} /></aside>
    {open && <Dialog open onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Edit score</DialogTitle>
        <input aria-label="Dialog field" />
        <button onClick={() => setOpen(false)}>Cancel</button>
        <button onClick={() => setOpen(false)}>Apply</button>
      </DialogContent>
    </Dialog>}
  </TooltipProvider>;
}

describe('dialog focus restoration', () => {
  it.each(['palette', 'dialog', 'popover', 'menu'] as const)('preserves the newer %s focus owner during close autofocus', async surface => {
    const view = render(<TooltipProvider>
      <main data-area="score"><div data-testid="score-view" tabIndex={0}>Score</div></main>
      <Dialog key="old" open><DialogContent aria-describedby={undefined}><DialogTitle>Old dialog</DialogTitle><input aria-label="Old field" /></DialogContent></Dialog>
    </TooltipProvider>);
    await screen.findByRole('textbox', { name: 'Old field' });
    vi.useFakeTimers();
    try {
      view.rerender(<TooltipProvider>
        <main data-area="score"><div data-testid="score-view" tabIndex={0}>Score</div></main>
        {surface === 'palette' || surface === 'dialog'
          ? <Dialog key="new" open><DialogContent aria-describedby={undefined}><DialogTitle>New dialog</DialogTitle>
            <input autoFocus={surface === 'palette'} role={surface === 'palette' ? 'combobox' : 'textbox'} aria-label="New owner" />
          </DialogContent></Dialog>
          : surface === 'popover'
            ? <Popover open><PopoverContent><input aria-label="New owner" /></PopoverContent></Popover>
            : <DropdownMenu open><DropdownMenuContent><DropdownMenuItem>New owner</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
      </TooltipProvider>);
      // Drain Radix's deferred unmount autofocus after the replacement has mounted.
      await act(async () => { await vi.runAllTimersAsync(); });
      const target = surface === 'menu' ? screen.getByRole('menu') : screen.getByRole(surface === 'palette' ? 'combobox' : 'textbox', { name: 'New owner' });
      expect(document.activeElement).toBe(target);
    } finally {
      cleanup();
      await act(async () => { await vi.runAllTimersAsync(); });
      vi.useRealTimers();
    }
  });

  for (const origin of ['score symbol', 'inspector field'] as const) {
    for (const replaced of [false, true]) {
      it.each(['Escape', 'Cancel', 'Apply'] as const)(
        `returns focus after %s from ${origin} when the opener is ${replaced ? 'replaced' : 'connected'}`,
        async close => {
          const view = render(<Harness />);
          const opener = origin === 'score symbol'
            ? screen.getByRole('button', { name: 'Score symbol' })
            : screen.getByRole('textbox', { name: 'Inspector title' });
          act(() => opener.focus());
          fireEvent.keyDown(opener, { key: 'b' });
          const dialog = await screen.findByRole('dialog');
          expect(dialog.contains(document.activeElement)).toBe(true);
          if (replaced) view.rerender(<Harness replaced />);
          expect(opener.isConnected).toBe(!replaced);

          if (close === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' });
          else fireEvent.click(screen.getByRole('button', { name: close }));

          await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
          await waitFor(() => expect(document.activeElement).toBe(replaced ? screen.getByTestId('score-view') : opener));
        },
      );
    }
  }
});
