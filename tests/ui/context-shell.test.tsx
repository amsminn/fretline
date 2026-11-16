import { act, fireEvent, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { commandContextStore } from '../../src/renderer/shell/services';
import { editingRuntime } from '../../src/renderer/commands/editing';
import { installShellEnvironment, mount, openFixture, services } from './shell-harness';

vi.mock('../../src/renderer/score/ScoreView', () => ({ ScoreView: () => null }));
installShellEnvironment();

it('keeps inspector typing out of score commands and restores commands when focus leaves', async () => {
  const context = services();
  mount(context);
  await openFixture(context.documents, 'loop-eight-bars', 'Inspector');
  const before = context.documents.getSnapshot().active?.project.score;
  const title = screen.getByRole('textbox', { name: '제목' });
  act(() => title.focus());
  expect(commandContextStore(context).getSnapshot()).toBe('text-input');
  for (const key of ['r', '+', ' ', '1']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    title.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  await editingRuntime(context).idle();
  expect(context.documents.getSnapshot().active?.project.score).toBe(before);
  await act(async () => { title.blur(); await Promise.resolve(); });
  fireEvent.keyDown(document, { key: 'F2' });
  expect(document.querySelector<HTMLElement>('[data-area="palette"]')?.hidden).toBe(true);
});
