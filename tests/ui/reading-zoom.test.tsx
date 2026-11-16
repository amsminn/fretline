import { act, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ProjectV1 } from '../../src/domain/project';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { installShellEnvironment, mount, openFixture, services } from './shell-harness';

vi.mock('../../src/renderer/score/ScoreView', () => ({
  ScoreView: ({ zoom }: { readonly zoom?: number }) => <div data-testid="score-view" data-zoom={zoom} />,
}));
installShellEnvironment();

const bridge = { createProject: () => Promise.resolve(fixtureId('document-capability', 'copy')), readAsset: () => Promise.resolve(new Uint8Array()) };

it('zooms a document that cannot be edited in the view and leaves the document untouched', async () => {
  const context = services();
  mount(context);
  const project: ProjectV1 = { schemaVersion: 1, projectId: fixtureId('project', 'preserved'), score: fixtureDocument('loop-eight-bars'), assets: [],
    source: null, preservation: [{ feature: 'container.private-fields', location: 'preserved.gp5', status: 'unverified', detail: 'unverified', dependencies: [] }] };
  await act(() => context.documents.open({ kind: 'opened', documentToken: fixtureId('document-capability', 'preserved'), project, assets: [],
    receipt: { revision: 0, contentHash: 'a'.repeat(64), projectId: project.projectId } }, bridge));
  const opened = context.documents.getSnapshot().active;
  expect(opened?.editable).toBe(false);
  const zoomIn = context.registry.present('toolbar', { context: 'editing', platform: 'mac' }).find(command => command.id === 'view.zoomIn');
  expect(zoomIn?.enabled).toBe(true);

  await act(async () => { context.registry.execute('view.zoomIn'); });
  await act(async () => { context.registry.execute('view.zoomIn'); });
  expect(screen.getByTestId('zoom-readout').textContent).toBe('120%');
  expect(screen.getByTestId('score-view').dataset['zoom']).toBe('1.2');
  await act(async () => { context.registry.execute('view.zoomOut'); });
  expect(screen.getByTestId('zoom-readout').textContent).toBe('110%');
  const after = context.documents.getSnapshot().active;
  expect([after?.project.score.layout.scale, after?.dirty, after?.revision]).toEqual([1, false, opened?.revision]);
});

it('keeps the zoom of an editable document in its layout', async () => {
  const context = services();
  mount(context);
  await openFixture(context.documents, 'loop-eight-bars', 'Editable');
  await act(async () => { context.registry.execute('view.zoomIn'); });
  await vi.waitFor(() => { expect(context.documents.getSnapshot().active?.project.score.layout.scale).toBe(1.1); });
  expect(screen.getByTestId('zoom-readout').textContent).toBe('110%');
});
