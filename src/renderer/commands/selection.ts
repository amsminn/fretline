import type { ScoreDocument } from '../../domain/document';
import type { TrackId } from '../../domain/ids';
import type { SelectionStore } from '../editor/selection-state';
import { extendSelection, trackSelection } from '../editor/selection-state';
import type { ExtendDirection } from '../editor/selection-state';
import type { CommandRegistry } from './registry';

export type SelectionCommandDeps = {
  readonly selection: SelectionStore;
  readonly document: () => ScoreDocument | null;
  readonly activeTrack: () => TrackId | null;
  readonly globalView: { readonly clearRange: () => void };
};

/** Owner-11 catalog commands (UX08): Cmd/Ctrl+A, Escape and Shift+arrows route through the shared registry. */
export function registerSelectionCommands(registry: CommandRegistry, deps: SelectionCommandDeps): () => void {
  const current = () => deps.selection.getSnapshot().selection;
  const extend = (direction: ExtendDirection) => ({
    enabled: () => current() !== null && deps.document() !== null,
    execute: () => {
      const doc = deps.document();
      const selection = current();
      if (doc && selection) deps.selection.set(extendSelection(doc, selection, direction));
    },
  });
  const releases = [
    registry.register('selection.all', {
      enabled: () => deps.document() !== null && deps.activeTrack() !== null,
      execute: () => {
        const doc = deps.document();
        const track = deps.activeTrack();
        if (doc && track) deps.selection.set(trackSelection(doc, track));
      },
    }),
    registry.register('selection.clear', {
      execute: () => { deps.selection.clear(); deps.globalView.clearRange(); },
    }),
    registry.register('selection.left', extend('left')),
    registry.register('selection.right', extend('right')),
    registry.register('selection.up', extend('up')),
    registry.register('selection.down', extend('down')),
  ];
  const unsubscribe = deps.selection.subscribe(() => registry.changed());
  return () => { unsubscribe(); for (const release of releases) release(); };
}
