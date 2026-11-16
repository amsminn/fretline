import type { CommandRegistry } from '../commands/registry';
import type { WorkspaceStore } from './workspace';

/** Owner-10 catalog commands (UX12): F2 palette, F5 Song inspector, F6 Track inspector, F8 Global View. */
export function registerShellCommands(registry: CommandRegistry, workspace: WorkspaceStore): () => void {
  const releases = [
    registry.register('view.palette', { execute: () => workspace.togglePanel('palette') }),
    registry.register('view.songInspector', { execute: () => workspace.showInspector('song') }),
    registry.register('view.trackInspector', { execute: () => workspace.showInspector('track') }),
    registry.register('view.globalView', { execute: () => workspace.togglePanel('globalView') }),
  ];
  return () => { for (const release of releases) release(); };
}

export const hasOpenDialog = (root: Document): boolean => root.querySelector('[role="dialog"][data-state="open"]') !== null;
