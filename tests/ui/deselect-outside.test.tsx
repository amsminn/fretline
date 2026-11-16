import { fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { caretSelection, selectionStore } from '../../src/renderer/editor/selection-state';
import { beatHit, syntheticHitMap } from './selection-fixture';
import { installShellEnvironment, mount, openFixture, services } from './shell-harness';

vi.mock('../../src/renderer/score/ScoreView', () => ({ ScoreView: () => <div data-testid="score-view" /> }));
installShellEnvironment();
afterEach(() => { selectionStore.clear(); });

it('releases the selection on a press beside the page, and keeps it on the page and on the scroll bar', async () => {
  const context = services();
  mount(context);
  const project = await openFixture(context.documents, 'loop-eight-bars', 'Deselect');
  const select = (): void => { selectionStore.set(caretSelection(project.score, beatHit(syntheticHitMap(project.score, 1), 'm2b2'))); };
  const area = screen.getByTestId('score-scroll');
  Object.defineProperties(area, { clientWidth: { value: 900 }, clientHeight: { value: 600 } });

  select();
  fireEvent.pointerDown(screen.getByTestId('score-view'), { button: 0, clientX: 100, clientY: 100 });
  expect(selectionStore.getSnapshot().selection).not.toBeNull();
  fireEvent.pointerDown(area, { button: 0, clientX: 905, clientY: 100 });
  expect(selectionStore.getSnapshot().selection).not.toBeNull();
  fireEvent.pointerDown(screen.getByTestId('engine-credit'), { button: 0, clientX: 100, clientY: 500 });
  expect(selectionStore.getSnapshot().selection).toBeNull();

  select();
  fireEvent.pointerDown(area, { button: 0, clientX: 5, clientY: 100 });
  expect(selectionStore.getSnapshot().selection).toBeNull();
});
