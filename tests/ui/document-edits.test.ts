import { afterEach, expect, it } from 'vitest';
import { hashDocument } from '../../src/domain/history';
import { contentToken, freezeRoot } from '../../src/domain/commands/core';
import { DomainError } from '../../src/domain/diagnostics';
import { indexDocument } from '../../src/domain/event-time';
import { rationalQ } from '../../src/domain/rational';
import type { Selection } from '../../src/domain/selection';
import { isValidatedRoot } from '../../src/domain/validated-root';
import { editingRuntime } from '../../src/renderer/commands/editing';
import { bindRhythm, commitRhythm } from '../../src/renderer/commands/rhythm';
import type { RhythmDraft } from '../../src/renderer/commands/rhythm';
import { bindArticulations } from '../../src/renderer/commands/articulations';
import { structureRuntime } from '../../src/renderer/commands/structure';
import { viewRuntime } from '../../src/renderer/commands/view';
import { selectAt } from '../../src/renderer/editor/input';
import { selectionStore } from '../../src/renderer/editor/selection-state';
import { documentEdits } from '../../src/renderer/state/document-edits';
import { openFixture, services } from './shell-harness';

const releases: (() => void)[] = [];
afterEach(() => { for (const release of releases.splice(0).reverse()) release(); selectionStore.clear(); });

async function setup() {
  const context = services();
  const edits = documentEdits(context);
  await openFixture(context.documents, 'loop-eight-bars', 'Document edits');
  const editing = editingRuntime(context);
  releases.push(editing.mount(), structureRuntime(context).mount(), viewRuntime(context).mount(),
    bindArticulations(context, () => undefined));
  const score = () => {
    const current = context.documents.getSnapshot().active?.project.score;
    if (!current) throw new RangeError('Missing open score');
    return current;
  };
  const first = [...indexDocument(score()).events.values()][0];
  if (!first) throw new RangeError('Missing first beat');
  selectionStore.set(selectAt(score(), first, 1));
  const execute = async (command: string) => {
    expect(context.registry.execute(command, 'editing')).toBe('executed');
    await edits.idle();
  };
  return { context, edits, editing, score, first, execute };
}

it('undoes and redoes fret, tuplet, technique, meter, metadata and spacing in exact order with selections', async () => {
  const { context, edits, score, first, execute } = await setup();
  const hashes = [(await hashDocument(score())).sha256];
  const before: (Selection | null)[] = [], after: (Selection | null)[] = [];
  const step = async (action: () => Promise<unknown>) => {
    before.push(selectionStore.getSnapshot().selection);
    await action();
    after.push(selectionStore.getSnapshot().selection);
    hashes.push((await hashDocument(score())).sha256);
    expect(edits.getSnapshot().rejection).toBeNull();
    expect(edits.getSnapshot().past).toBe(before.length);
  };
  await step(async () => { await execute('note.fret.1'); await execute('note.fret.2'); });
  const fret = indexDocument(score()).events.get(first.event.id)?.event;
  expect(fret?.kind === 'noteGroup' && fret.notes[0]).toMatchObject({ fret: 12 });
  const events = [...indexDocument(score()).events.values()].filter(e => e.voiceId === first.voiceId).slice(0, 3);
  selectionStore.set({ kind: 'timeRange', scope: { trackIds: [], staffIds: [first.staff.id], voices: [1] },
    anchor: { startQ: rationalQ(0n), endQ: rationalQ(1n) }, focus: { startQ: rationalQ(2n), endQ: rationalQ(3n) } });
  const drafts: RhythmDraft[] = [];
  releases.push(bindRhythm(context, draft => drafts.push(draft)));
  await execute('note.tuplet');
  const draft = drafts[0];
  if (!draft) throw new RangeError('Tuplet command did not open its draft');
  await step(async () => expect(await commitRhythm(context, draft, {
    kind: 'tuplet', actual: 3, normal: 2, unit: 4, eventIds: events.map(e => e.event.id),
  })).toBe(true));
  expect(score().tuplets).toHaveLength(1);
  await step(() => execute('effects.palmMute'));
  expect(indexDocument(score()).events.get(first.event.id)?.event).toMatchObject({ notes: [{ techniques: [{ kind: 'palmMute' }] }] });
  await step(async () => {
    structureRuntime(context).edit({ kind: 'meter', measureId: first.measureId, meter: { beats: 8, unit: 8 } });
    await edits.idle();
  });
  expect(score().measures[0]?.meter).toEqual({ beats: 8, unit: 8 });
  await step(async () => {
    structureRuntime(context).edit(doc => ({ kind: 'metadata', metadata: { ...doc.metadata, title: 'Across families' } }));
    await edits.idle();
  });
  expect(score().metadata.title).toBe('Across families');
  await step(() => viewRuntime(context).spaceEvents([{ eventId: first.event.id, width: 72 }]));
  expect(score().layout.eventSpacing).toEqual([{ eventId: first.event.id, width: 72 }]);
  expect(new Set(hashes).size).toBe(7);

  for (let i = 5; i >= 0; i--) {
    await execute('edit.undo');
    expect((await hashDocument(score())).sha256).toBe(hashes[i]);
    expect(selectionStore.getSnapshot().selection).toEqual(before[i]);
    expect(edits.getSnapshot()).toMatchObject({ past: i, future: 6 - i });
  }
  for (let i = 0; i < 6; i++) {
    await execute('edit.redo');
    expect((await hashDocument(score())).sha256).toBe(hashes[i + 1]);
    expect(selectionStore.getSnapshot().selection).toEqual(after[i]);
  }
});

it('serializes different command families submitted without waiting and ends a fret gesture at a foreign edit', async () => {
  const { context, edits, score, first, execute } = await setup();
  expect(context.registry.execute('note.fret.1', 'editing')).toBe('executed');
  expect(context.registry.execute('effects.palmMute', 'editing')).toBe('executed');
  structureRuntime(context).edit(doc => ({ kind: 'metadata', metadata: { ...doc.metadata, title: 'Queued title' } }));
  void viewRuntime(context).spaceEvents([{ eventId: first.event.id, width: 80 }]);
  await edits.idle();
  await execute('note.fret.2');
  expect(indexDocument(score()).events.get(first.event.id)?.event).toMatchObject({
    notes: [{ fret: 2, techniques: [{ kind: 'palmMute' }] }],
  });
  expect(score().metadata.title).toBe('Queued title');
  expect(score().layout.eventSpacing).toEqual([{ eventId: first.event.id, width: 80 }]);
  expect(edits.getSnapshot()).toMatchObject({ past: 5, future: 0, rejection: null });
});

it('keeps document, selection and redo history unchanged when a domain command or stale draft rejects', async () => {
  const { edits, score, first, execute } = await setup();
  const stale = contentToken(score());
  await execute('note.fret.9');
  await execute('note.fret.8');
  await execute('edit.undo');
  const original = score();
  const selection = selectionStore.getSnapshot().selection;
  const state = edits.getSnapshot();
  const rejected = await edits.edit('invalid spacing', () => ({
    kind: 'layout', edit: { kind: 'eventSpacing', entries: [{ eventId: first.event.id, width: -1 }] },
  }));
  expect(rejected).toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'RANGE' }] });
  expect(score()).toBe(original);
  expect(selectionStore.getSnapshot().selection).toBe(selection);
  expect(edits.getSnapshot()).toMatchObject({ past: state.past, future: state.future });
  await execute('edit.redo');
  const changed = score();
  const rejectedDraft = await edits.edit('stale title', doc => ({
    kind: 'structure', expectedToken: stale, edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'Must not appear' } },
  }));
  expect(rejectedDraft).toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'REFERENCE' }] });
  expect(score()).toBe(changed);
  expect(edits.getSnapshot()).toMatchObject({ past: 1, future: 0 });
});

it('keeps a two digit insertion into a rest as one reversible gesture', async () => {
  const { edits, score, first, execute } = await setup();
  await execute('note.rest');
  const rest = score();
  await execute('note.fret.1');
  await execute('note.fret.2');
  expect(indexDocument(score()).events.get(first.event.id)?.event).toMatchObject({ notes: [{ fret: 12 }] });
  expect(edits.getSnapshot().past).toBe(2);
  await execute('edit.undo');
  expect(score()).toBe(rest);
  await execute('edit.redo');
  expect(indexDocument(score()).events.get(first.event.id)?.event).toMatchObject({ notes: [{ fret: 12 }] });
});

it('continues a fret gesture when its first digit equals the existing fret', async () => {
  const { edits, score, first, execute } = await setup();
  const note = first.event.kind === 'noteGroup' ? first.event.notes[0] : undefined;
  if (!note) throw new RangeError('Missing fixture note');
  await edits.edit('initial fret', () => ({ kind: 'core', edit: { kind: 'setFret', noteId: note.id, fret: 1 } }));
  const before = edits.getSnapshot().past;
  await execute('note.fret.1');
  expect(edits.getSnapshot().past).toBe(before);
  await execute('note.fret.2');
  expect(indexDocument(score()).notes.get(note.id)?.note).toMatchObject({ fret: 12 });
  expect(edits.getSnapshot().past).toBe(before + 1);
  await execute('edit.undo');
  expect(indexDocument(score()).notes.get(note.id)?.note).toMatchObject({ fret: 1 });
});

it('fully validates unknown roots at the document publication boundary', async () => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Boundary validation');
  const active = context.documents.getSnapshot().active;
  if (!active) throw new RangeError('Missing active document');
  const valid = structuredClone({
    ...active.project.score,
    metadata: { ...active.project.score.metadata, title: 'Uncertified valid root' },
  });
  freezeRoot(valid);
  expect(isValidatedRoot(valid)).toBe(false);
  expect(context.documents.updateProject({ ...active.project, score: valid }, active.documentToken)).toBe(true);
  expect(isValidatedRoot(valid)).toBe(true);

  const invalid = freezeRoot({ ...valid, tracks: valid.tracks.map((track, trackIndex) => trackIndex !== 0 ? track : {
    ...track, staves: track.staves.map((staff, staffIndex) => staffIndex !== 0 ? staff : {
      ...staff, voices: staff.voices.map((voice, voiceIndex) => voiceIndex !== 0 ? voice : {
        ...voice, bars: voice.bars.slice(0, -1),
      }),
    }),
  }) });
  expect(isValidatedRoot(invalid)).toBe(false);
  expect(() => context.documents.updateProject({
    ...context.documents.getSnapshot().active?.project ?? active.project,
    score: invalid,
  }, active.documentToken)).toThrow(DomainError);
  expect(context.documents.getSnapshot().active?.project.score).toBe(valid);
});
