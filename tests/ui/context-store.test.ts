import { afterEach, describe, expect, it } from 'vitest';
import { PlaybackTransport } from '../../src/renderer/audio/transport';
import { CommandContextStore } from '../../src/renderer/commands/context-store';
import type { CommandContext } from '../../src/renderer/commands/contexts';
import { bindCommandKeys, CommandRegistry } from '../../src/renderer/commands/registry';
import { bindNativeMenu } from '../../src/renderer/shell/native-menu';
import type { MenuAvailabilityEntry } from '../../src/preload';
import { fixtureDocument } from '../domain/fixtures';

const releases: (() => void)[] = [];
afterEach(() => { for (const release of releases.splice(0).reverse()) release(); document.body.replaceChildren(); });

function setup() {
  const transport = new PlaybackTransport(() => Promise.resolve({
    position: { tick: 0, seconds: 0, total: 16, bpm: 120 },
    start: () => undefined, reset: () => undefined, subscribe: () => () => undefined, destroy: () => undefined,
  }));
  transport.setDocument(fixtureDocument('loop-eight-bars'), 0);
  const store = new CommandContextStore(document, transport);
  const registry = new CommandRegistry();
  registry.bindContext(store, 'mac');
  releases.push(() => transport.destroy());
  return { transport, store, registry };
}

function modal(): HTMLDivElement {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('data-state', 'open');
  document.body.append(dialog);
  return dialog;
}

describe('shared command context', () => {
  it('notifies only transitions, prioritizes dialog over playback and text, and disconnects subscribers', async () => {
    const { store, transport } = setup();
    const seen: CommandContext[] = [];
    const release = store.subscribe(() => { seen.push(store.getSnapshot()); });
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    await transport.play();
    transport.seek(960);
    const dialog = modal();
    await Promise.resolve();
    dialog.remove();
    await Promise.resolve();
    transport.pause();
    input.blur();
    await Promise.resolve();
    expect(seen).toEqual(['text-input', 'playback', 'dialog', 'playback', 'text-input', 'editing']);
    release();
    await transport.play();
    expect(seen).toHaveLength(6);
  });

  it.each([
    ['+', 'note.durationShorter', 'sound.speedUp'],
    ['-', 'note.durationLonger', 'sound.speedDown'],
  ])('routes %s through the live store and blocks it immediately on dialog insertion', async (key, editId, speedId) => {
    const { registry, transport } = setup();
    const executed: string[] = [];
    for (const id of [editId, speedId]) registry.register(id, { execute: () => { executed.push(id); } });
    releases.push(bindCommandKeys(registry, { target: document, platform: 'mac' }));
    const press = (): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); };
    press();
    await transport.play();
    press();
    const dialog = modal();
    press();
    dialog.remove();
    transport.stop();
    press();
    expect(executed).toEqual([editId, speedId, editId]);
  });

  it('publishes actual native availability through playing, dialog removal and editing', async () => {
    const { registry, store, transport } = setup();
    registry.register('note.rest', { execute: () => undefined });
    registry.register('sound.speedUp', { execute: () => undefined });
    const published: (readonly MenuAvailabilityEntry[])[] = [];
    releases.push(bindNativeMenu(registry, { context: store, platform: 'mac', onSyncError: error => { throw error; },
      bridge: { menuSync: entries => { published.push(entries); return Promise.resolve(); }, onMenuCommand: () => () => undefined } }));
    const enabled = (): string[] => (published.at(-1) ?? []).filter(entry => entry.enabled).map(entry => entry.id);
    expect(enabled()).toEqual(['note.rest']);
    await transport.play();
    expect(enabled()).toEqual(['sound.speedUp']);
    const dialog = modal();
    await Promise.resolve();
    expect(enabled()).toEqual([]);
    dialog.remove();
    await Promise.resolve();
    expect(enabled()).toEqual(['sound.speedUp']);
    transport.stop();
    expect(enabled()).toEqual(['note.rest']);
  });

  it('preserves focused text input even during playback without explicit key context', async () => {
    const { registry, transport } = setup();
    let edits = 0;
    for (const id of ['note.rest', 'sound.speedUp', 'sound.playPause']) registry.register(id, { execute: () => { edits++; } });
    releases.push(bindCommandKeys(registry, { target: document, platform: 'mac' }));
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    await transport.play();
    for (const key of ['r', '+', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(edits).toBe(0);
  });
});
