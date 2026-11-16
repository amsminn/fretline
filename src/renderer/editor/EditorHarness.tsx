import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { id } from '../../domain/ids';
import type { ScoreHitMap } from '../score/overlay';
import { bindCommandKeys } from '../commands/registry';
import { GlobalView } from '../global-view/GlobalView';
import { useDocuments, useServices } from '../shell/services';
import { Input } from '../ui/Input';
import { EditorScoreView } from './EditorScoreView';
import { harnessEventLabels, harnessProject } from './harness-fixture';
import { rangeOf, selectionStore } from './selection-state';
import { normalizeSelection } from '../../domain/selection';

const label = (eventId: string | undefined): string | null => (eventId ? harnessEventLabels.get(eventId) ?? eventId : null);

/** QA-only route (#/editor-harness): the real editor surface and Global View on the loop-eight-bars fixture. */
export function EditorHarness() {
  const { registry, platform, documents } = useServices();
  const { active } = useDocuments();
  const { selection, dragging, rejected } = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
  const [map, setMap] = useState<ScoreHitMap>();
  const [typed, setTyped] = useState('');
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void documents.open({ kind: 'opened', documentToken: id('document-capability', 'e5c3f4a6-7d8e-4f90-a1b2-3c4d5e6f7a81'),
      project: harnessProject, assets: [], receipt: { revision: 0, contentHash: '0'.repeat(64), projectId: harnessProject.projectId } }, window.desktop);
  }, [documents]);
  useEffect(() => bindCommandKeys(registry, { target: document, platform, state: () => ({ playing: false, dialog: false }) }), [registry, platform]);
  const normalized = selection ? normalizeSelection(selection) : null;
  const range = selection ? rangeOf(selection) : null;
  const observation = {
    kind: selection?.kind ?? null, direction: normalized?.direction ?? null,
    range: range ? { startQ: range.startQ, endQ: range.endQ } : null,
    anchor: label(selection?.anchor.eventId), focus: label(selection?.focus.eventId),
    anchorEventId: selection?.anchor.eventId ?? null, focusEventId: selection?.focus.eventId ?? null,
    noteIds: selection?.kind === 'noteSet' ? selection.noteIds : [],
    trackIds: selection?.scope.trackIds ?? [], dragging, rejected, generation: map?.generation ?? 0,
  };
  return <main className="flex h-full min-h-0 flex-col bg-app text-fg" data-testid="editor-harness">
    <header className="flex items-center gap-3 border-b border-border bg-toolbar px-3 py-2">
      <h1 className="text-sm font-semibold">선택 동작</h1>
      <label className="flex items-center gap-2 whitespace-nowrap text-xs">
        <span>가사 메모</span>
        <Input size="compact" aria-label="가사 메모" data-testid="harness-text-input" value={typed} onChange={event => setTyped(event.target.value)} />
      </label>
      <output className="font-mono text-2xs text-muted" data-testid="harness-typed">{typed}</output>
    </header>
    <div className="score-scroll min-h-0 flex-1 overflow-auto p-4" data-testid="score-scroll">
      {active ? <EditorScoreView document={active.project.score} mode="tab" onRendered={setMap} /> : <p role="status">문서를 여는 중…</p>}
    </div>
    <section aria-label="Global View" className="h-area-global-view shrink-0 border-t border-border bg-panel"><GlobalView /></section>
    <output hidden data-testid="score-hit-map">{JSON.stringify(map ?? null)}</output>
    <output hidden data-testid="editor-selection">{JSON.stringify(observation)}</output>
    <output hidden data-testid="harness-labels">{JSON.stringify(Object.fromEntries(harnessEventLabels))}</output>
    <span hidden data-testid="renderer-ready">QA editor ready</span>
  </main>;
}
