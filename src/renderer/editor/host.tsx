import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { editingRuntime } from '../commands/editing';
import { registerSelectionCommands } from '../commands/selection';
import { bindGlobalViewSelection } from '../global-view/selection';
import { useServices } from '../shell/services';
import { EditorHarness } from './EditorHarness';
import { selectionStore } from './selection-state';

const qaEnabled = (): boolean => import.meta.env.DEV || document.querySelector('meta[name="fretline-qa"]')?.getAttribute('content') === '1';

/** Mounted once from App: selection commands, the Global View range bridge and the QA editor route. */
export function EditorHost({ children }: { readonly children: ReactNode }) {
  const services = useServices();
  const { registry, documents, workspace, globalView } = services;
  const activeScore = () => documents.getSnapshot().active?.project.score ?? null;
  useEffect(() => registerSelectionCommands(registry, {
    selection: selectionStore, document: activeScore, globalView,
    activeTrack: () => activeScore()?.tracks[workspace.getSnapshot().activeTrackIndex]?.id ?? null,
  }), [registry, documents, workspace, globalView]);
  useEffect(() => bindGlobalViewSelection(globalView, selectionStore, activeScore), [globalView, documents]);
  useEffect(() => editingRuntime(services).mount(), [services]);
  useEffect(() => documents.subscribe(() => { if (!documents.getSnapshot().active) selectionStore.clear(); }), [documents]);
  if (qaEnabled() && location.hash === '#/editor-harness') return <EditorHarness />;
  return children;
}
