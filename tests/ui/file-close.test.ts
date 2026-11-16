import { afterEach, expect, it, vi } from 'vitest';
import { registerFileCommands } from '../../src/renderer/commands/file';
import type { CloseChoice } from '../../src/renderer/commands/file';
import type { DocumentSession } from '../../src/renderer/state/documents';
import { documentEdits } from '../../src/renderer/state/document-edits';
import { fixtureId } from '../domain/fixtures';
import { openFixture, services } from './shell-harness';

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.unstubAllGlobals(); });

async function setup(confirm: (session: DocumentSession) => Promise<CloseChoice>) {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Other');
  await openFixture(context.documents, 'loop-eight-bars', 'Closing');
  const edits = documentEdits(context);
  vi.stubGlobal('desktop', { pendingOpenFiles: async () => [], onOpenFiles: () => () => {} });
  disposers.push(registerFileCommands(context.registry, context.documents, confirm, () => edits.idle()));
  const completed = Promise.withResolvers<void>();
  let started = false;
  disposers.push(context.registry.subscribe(() => {
    const status = context.registry.status('file.close', 'editing');
    if (status === 'disabled') started = true;
    if (started && status === 'ready') completed.resolve();
  }));
  return { ...context, edits, completed: completed.promise };
}

it.each([false, true])('prompts for an in-flight edit on the originally addressed tab when focus changes: %s', async switchFocus => {
  const prompted: DocumentSession[] = [];
  const context = await setup(async session => { prompted.push(session); return 'cancel'; });
  const pendingEdit = context.edits.edit('rename', doc => ({
    kind: 'structure', edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'In-flight change' } },
  }));

  context.registry.execute('file.close', 'editing');
  if (switchFocus) context.documents.activate(fixtureId('document-capability', 'Other'));
  const result = await pendingEdit;
  await context.completed;

  expect(result.kind).toBe('applied');
  expect(prompted.map(session => [session.documentToken, session.dirty, session.project.score.metadata.title]))
    .toEqual([[fixtureId('document-capability', 'Closing'), true, 'In-flight change']]);
  expect(context.documents.getSnapshot().sessions).toHaveLength(2);
});

it('keeps an edit queued during the discard prompt instead of closing under it', async () => {
  let pendingEdit: ReturnType<ReturnType<typeof documentEdits>['edit']> | undefined;
  const context = await setup(async () => {
    pendingEdit = context.edits.edit('later', doc => ({
      kind: 'structure', edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'During prompt' } },
    }));
    return 'discard';
  });
  await context.edits.edit('dirty', doc => ({
    kind: 'structure', edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'Before prompt' } },
  }));

  context.registry.execute('file.close', 'editing');
  await context.completed;

  expect((await pendingEdit)?.kind).toBe('applied');
  expect(context.documents.getSnapshot().sessions).toHaveLength(2);
  expect(context.documents.getSnapshot().active?.project.score.metadata.title).toBe('During prompt');
  expect(context.documents.getSnapshot().error).not.toBeNull();
});
