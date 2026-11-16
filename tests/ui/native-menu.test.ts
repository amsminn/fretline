import { describe, expect, it } from 'vitest';
import type { MenuAvailabilityEntry } from '../../src/preload';
import { CommandRegistry } from '../../src/renderer/commands/registry';
import { bindNativeMenu } from '../../src/renderer/shell/native-menu';
import type { CommandContext } from '../../src/renderer/commands/contexts';

function fakeBridge() {
  const published: (readonly MenuAvailabilityEntry[])[] = [];
  let listener: ((id: string) => void) | undefined;
  let listening = 0;
  return {
    published,
    click: (id: string): void => { listener?.(id); },
    get listening() { return listening; },
    bridge: {
      menuSync: (availability: readonly MenuAvailabilityEntry[]): Promise<void> => { published.push(availability); return Promise.resolve(); },
      onMenuCommand: (next: (id: string) => void) => { listener = next; listening++; return () => { listener = undefined; listening--; }; },
    },
  };
}

describe('native menu binding', () => {
  it('publishes context transitions without resending unchanged ticks and releases the subscription', () => {
    const registry = new CommandRegistry();
    const fake = fakeBridge();
    const listeners = new Set<() => void>();
    let context: CommandContext = 'editing';
    const notify = (): void => { for (const listener of listeners) listener(); };
    const dispose = bindNativeMenu(registry, {
      platform: 'mac', bridge: fake.bridge, context: {
        getSnapshot: () => context,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      }, onSyncError: () => undefined,
    });
    notify(); notify();
    expect(fake.published).toHaveLength(1);
    context = 'playback';
    notify(); notify(); notify();
    expect(fake.published).toHaveLength(2);
    context = 'dialog';
    notify();
    expect(fake.published).toHaveLength(3);
    dispose();
    context = 'editing';
    notify();
    expect(fake.published).toHaveLength(3);
  });
  it('publishes only handler-backed commands with their enabled state and republishes on change', () => {
    const registry = new CommandRegistry();
    const fake = fakeBridge();
    let enabled = false;
    registry.register('view.palette', { execute: () => undefined });
    const dispose = bindNativeMenu(registry, { platform: 'mac', bridge: fake.bridge,
      context: { getSnapshot: () => 'editing', subscribe: () => () => undefined }, onSyncError: () => undefined });
    expect(fake.published.at(-1)).toEqual([{ id: 'view.palette', enabled: true }]);
    registry.register('file.save', { execute: () => undefined, enabled: () => enabled });
    expect(fake.published.at(-1)).toEqual([{ id: 'file.save', enabled: false }, { id: 'view.palette', enabled: true }]);
    enabled = true;
    registry.changed();
    expect(fake.published.at(-1)?.find(entry => entry.id === 'file.save')?.enabled).toBe(true);
    dispose();
    registry.register('edit.undo', { execute: () => undefined });
    expect(fake.published.at(-1)?.some(entry => entry.id === 'edit.undo')).toBe(false);
    expect(fake.listening).toBe(0);
  });
  it('routes a native menu click to the renderer handler under the renderer context', () => {
    const registry = new CommandRegistry();
    const fake = fakeBridge();
    const executed: string[] = [];
    let dialogOpen = false;
    registry.register('view.palette', { execute: () => { executed.push('view.palette'); } });
    const dispose = bindNativeMenu(registry, { platform: 'mac', bridge: fake.bridge,
      context: { getSnapshot: () => (dialogOpen ? 'dialog' : 'editing'), subscribe: () => () => undefined }, onSyncError: () => undefined });
    fake.click('view.palette');
    expect(executed).toEqual(['view.palette']);
    dialogOpen = true;
    fake.click('view.palette');
    fake.click('edit.undo');
    expect(executed).toEqual(['view.palette']);
    dispose();
  });
  it('does not publish unchanged menu availability after score-only registry notifications', () => {
    const registry = new CommandRegistry();
    const fake = fakeBridge();
    let enabled = false;
    registry.register('file.save', { execute: () => undefined, enabled: () => enabled });
    const dispose = bindNativeMenu(registry, { platform: 'mac', bridge: fake.bridge,
      context: { getSnapshot: () => 'editing', subscribe: () => () => undefined }, onSyncError: () => undefined });

    registry.changed();
    registry.changed();

    expect(fake.published).toEqual([[{ id: 'file.save', enabled: false }]]);
    enabled = true;
    registry.changed();
    expect(fake.published).toEqual([
      [{ id: 'file.save', enabled: false }], [{ id: 'file.save', enabled: true }],
    ]);
    dispose();
  });
});
