import { expect, it } from 'vitest';
import { PlaybackThrottlingOwner } from '../../src/main/playback-throttling';

class Events<Event extends string> {
  private readonly listeners = new Map<Event, Set<() => void>>();
  readonly on = (event: Event, listener: () => void): void => {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener); this.listeners.set(event, listeners);
  };
  emit(event: Event): void { for (const listener of this.listeners.get(event) ?? []) listener(); }
}
function fixture(baseline = true) {
  const load = new Events<'load'>(); const gone = new Events<'gone'>(); const closed = new Events<'closed'>();
  const calls: boolean[] = [];
  const owner = new PlaybackThrottlingOwner({
    setAllowed: allowed => { calls.push(allowed); },
    onDidFinishLoad: listener => { load.on('load', listener); },
    onRendererGone: listener => { gone.on('gone', listener); },
    onWindowClosed: listener => { closed.on('closed', listener); },
  }, baseline);
  return { owner, calls, load, gone, closed };
}

it.each([
  ['production', true, [false, true]],
  ['default QA', false, []],
  ['production-throttling QA', true, [false, true]],
] as const)('preserves the registered %s baseline across idempotent play and stop transitions',
  (_label, baseline, expected) => {
    const { owner, calls } = fixture(baseline);
    owner.setActive(true); owner.setActive(true);
    owner.setActive(false); owner.setActive(false);
    expect(calls).toEqual(expected);
  });

it.each(['did-finish-load', 'render-process-gone'] as const)(
  'restores throttling after %s while playback is active', event => {
    const { owner, calls, load, gone } = fixture();
    owner.setActive(true);
    switch (event) {
      case 'did-finish-load': load.emit('load'); break;
      case 'render-process-gone': gone.emit('gone'); break;
      default: { const invalid: never = event; throw new TypeError(String(invalid)); }
    }
    expect(calls).toEqual([false, true]);
  });

it('drops active ownership after the window is actually closed without touching destroyed webContents', () => {
  const { owner, calls, closed } = fixture();
  owner.setActive(true);
  closed.emit('closed');
  owner.setActive(false);
  expect(calls).toEqual([false]);
});
