import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { indexDocument } from '../../src/domain/event-time';
import { compareQ, rationalQ } from '../../src/domain/rational';
import { validateDocument } from '../../src/domain/validate';
import { editingRuntime } from '../../src/renderer/commands/editing';
import { structureRuntime } from '../../src/renderer/commands/structure';
import { selectAt } from '../../src/renderer/editor/input';
import { selectionStore } from '../../src/renderer/editor/selection-state';
import { SpecialPaste } from '../../src/renderer/dialogs/SpecialPaste';
import { TooltipProvider } from '../../src/renderer/ui/Tooltip';
import { openFixture, services } from './shell-harness';

afterEach(() => { cleanup(); selectionStore.clear(); });

it.each([
  ['edit.copy', 'ordinary'], ['edit.cut', 'ordinary'],
  ['edit.copy', 'all'], ['edit.cut', 'all'],
] as const)('special paste after %s uses the %s clipboard copied last', async (ordinaryCommand, last) => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'special-paste');
  const editing = editingRuntime(context), structure = structureRuntime(context);
  const releases = [editing.mount(), structure.mount()];
  const score = () => {
    const active = context.documents.getSnapshot().active;
    if (!active) throw new RangeError('Missing project');
    return active.project.score;
  };
  const at = (quarter: number, track = 0) => {
    const voice = score().tracks[track]?.staves[0]?.voices[0];
    const entry = [...indexDocument(score()).events.values()].find(e =>
      e.voiceId === voice?.id && compareQ(e.startQ, rationalQ(BigInt(quarter))) === 0);
    if (!entry) throw new RangeError('Missing fixture beat');
    return entry;
  };
  const execute = async (command: string) => {
    expect(context.registry.execute(command, 'editing')).toBe('executed');
    await structure.idle();
    await editing.idle();
  };
  const range = (quarter: number) => {
    selectionStore.set({ kind: 'timeRange', scope: { trackIds: [], staffIds: [], voices: [1] },
      anchor: { startQ: rationalQ(BigInt(quarter)), endQ: rationalQ(BigInt(quarter + 1)) },
      focus: { startQ: rationalQ(BigInt(quarter)), endQ: rationalQ(BigInt(quarter + 1)) } });
  };
  try {
    await editing.idle();
    const ordinarySource = at(1).event, allSource = at(0).event;
    expect(ordinarySource).not.toEqual(allSource);
    range(8);
    await execute('note.rest');
    const ordinary = async () => {
      selectionStore.set(selectAt(score(), at(1), 1));
      await execute(ordinaryCommand);
    };
    const all = async () => {
      range(0);
      await execute('edit.copyAllTracks');
    };
    if (last === 'ordinary') { await all(); await ordinary(); }
    else { await ordinary(); await all(); }
    selectionStore.set(selectAt(score(), at(8), 1));
    await execute('edit.specialPaste');
    const draft = structure.getSnapshot();
    if (!draft) throw new RangeError('Missing special paste draft');
    render(<TooltipProvider><SpecialPaste draft={draft} onCommit={edit => structure.commit(draft, edit)} onClose={structure.close} /></TooltipProvider>);
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    await structure.idle();
    await editing.idle();
    const pasted = at(8).event;
    const source = last === 'ordinary' ? ordinarySource : allSource;
    if (pasted.kind !== 'noteGroup' || source.kind !== 'noteGroup') throw new RangeError('Paste did not produce notes');
    expect(pasted.notes.map(n => n.kind === 'fretted' ? n.fret : n.kind))
      .toEqual(source.notes.map(n => n.kind === 'fretted' ? n.fret : n.kind));
    expect(pasted.id).not.toBe(source.id);
    expect(at(8, 1).event.kind).toBe(last === 'ordinary' ? 'rest' : 'noteGroup');
    expect(at(8, 2).event.kind).toBe(last === 'ordinary' ? 'rest' : 'noteGroup');
    expect(validateDocument(score())).toEqual([]);
    await execute('edit.undo');
    expect(at(8).event.kind).toBe('rest');
    await execute('edit.redo');
    expect(at(8).event.id).toBe(pasted.id);
  } finally { for (const release of releases.reverse()) release(); }
});
