import { describe, expect, it } from 'vitest';
import { CommandContractError, CommandRegistry, bindCommandKeys } from '../../src/renderer/commands/registry';
import { commandDefinitions } from '../../src/renderer/commands/catalog';
import { parityRows, sources } from '../../src/renderer/commands/parity';
import { normalizeKey, normalizeShortcut } from '../../src/renderer/commands/keymap';

describe('command routing contract', () => {
  it('rejects conflicting normalized keys within one platform and context', () => {
    const base = commandDefinitions.find(command => command.id === 'note.rest');
    if (!base) throw new TypeError('Missing rest command');
    expect(() => new CommandRegistry([base, { ...base, id: 'other.rest' }])).toThrow(CommandContractError);
  });

  it('rejects duplicate IDs and duplicate handler registration', () => {
    const registry = new CommandRegistry();
    registry.register('note.rest', { execute: () => undefined });
    expect(() => registry.register('note.rest', { execute: () => undefined })).toThrow(CommandContractError);
    expect(() => new CommandRegistry([...commandDefinitions, ...commandDefinitions])).toThrow(CommandContractError);
  });

  it.each(['pending', 'disabled', 'context-blocked'] as const)('cannot execute a %s command', status => {
    const registry = new CommandRegistry();
    let mutations = 0;
    if (status !== 'pending') registry.register('effects.bend', {
      execute: () => { mutations++; }, enabled: () => status !== 'disabled',
    });
    expect(registry.execute('effects.bend', status === 'context-blocked' ? 'text-input' : 'editing')).toBe(status);
    expect(mutations).toBe(0);
  });

  it.each([
    { key: 'F9', id: 'sound.loop', playing: false, platform: 'mac' },
    { key: ' ', id: 'sound.playPause', playing: false, platform: 'mac' },
    { key: '+', shiftKey: true, id: 'note.durationShorter', playing: false, platform: 'mac' },
    { key: '=', id: 'sound.speedUp', playing: true, platform: 'windows' },
    { key: '_', shiftKey: true, id: 'sound.speedDown', playing: true, platform: 'mac' },
    { key: 'z', metaKey: true, id: 'edit.undo', playing: false, platform: 'mac' },
    { key: 'Z', metaKey: true, shiftKey: true, id: 'edit.redo', playing: false, platform: 'mac' },
    { key: 'y', ctrlKey: true, id: 'edit.redo', playing: false, platform: 'windows' },
  ] as const)('routes $key to $id in the correct context', row => {
    const registry = new CommandRegistry();
    const executed: string[] = [];
    for (const id of ['sound.loop', 'sound.playPause', 'note.durationShorter', 'sound.speedUp', 'sound.speedDown', 'edit.undo', 'edit.redo']) {
      registry.register(id, { execute: () => { executed.push(id); } });
    }
    registry.route(new KeyboardEvent('keydown', row), { playing: row.playing, platform: row.platform, dialog: false, target: null });
    expect(executed).toEqual([row.id]);
  });

  it.each(['input', 'textarea', 'select', 'editable', 'textbox', 'nested'] as const)(
    'preserves native text editing in %s without consuming score shortcuts', kind => {
      const registry = new CommandRegistry();
      let mutations = 0;
      for (const id of ['effects.bend', 'sound.playPause', 'selection.all']) {
        registry.register(id, { execute: () => { mutations++; } });
      }
      const parent = document.createElement(kind === 'editable' || kind === 'textbox' || kind === 'nested' ? 'div' : kind);
      if (kind === 'editable' || kind === 'nested') parent.setAttribute('contenteditable', 'true');
      if (kind === 'textbox') parent.setAttribute('role', 'textbox');
      const target = kind === 'nested' ? parent.appendChild(document.createElement('span')) : parent;
      document.body.append(parent);
      const dispose = bindCommandKeys(registry, { target: document, platform: 'mac', state: () => ({ playing: true, dialog: false }) });
      try {
        for (const options of [{ key: 'b' }, { key: ' ' }, { key: 'a', metaKey: true }]) {
          const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true });
          target.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(false);
        }
        expect(mutations).toBe(0);
      } finally { dispose(); parent.remove(); }
    });

  it('blocks modal and composition input and detaches the keyboard listener', () => {
    const registry = new CommandRegistry();
    let mutations = 0;
    registry.register('effects.bend', { execute: () => { mutations++; } });
    const dispose = bindCommandKeys(registry, { target: document, platform: 'mac', state: () => ({ playing: false, dialog: true }) });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    dispose();
    registry.route(new KeyboardEvent('keydown', { key: 'b', isComposing: true }),
      { playing: false, dialog: false, platform: 'mac', target: null });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    expect(mutations).toBe(0);
  });

  it('hides pending actions on every surface and removes disposed handlers', () => {
    const registry = new CommandRegistry();
    const dispose = registry.register('sound.loop', { execute: () => undefined, enabled: () => false });
    for (const surface of ['menu', 'palette', 'toolbar'] as const) {
      expect(registry.present(surface, { context: 'editing', platform: 'mac' }).map(command =>
        ({ id: command.id, enabled: command.enabled, shortcut: command.shortcut })))
        .toEqual([{ id: 'sound.loop', enabled: false, shortcut: 'F9' }]);
    }
    dispose();
    expect(registry.menu({ context: 'editing', platform: 'mac' }).flatMap(group => group.commands)).toEqual([]);
  });

  it('consumes executed DOM shortcuts and notifies availability subscribers', () => {
    const registry = new CommandRegistry();
    let changes = 0;
    let executions = 0;
    const unsubscribe = registry.subscribe(() => { changes++; });
    const unregister = registry.register('sound.loop', { execute: () => { executions++; } });
    const dispose = bindCommandKeys(registry, { target: document, platform: 'mac', state: () => ({ playing: false, dialog: false }) });
    try {
      const event = new KeyboardEvent('keydown', { key: 'F9', cancelable: true });
      document.dispatchEvent(event);
      expect({ consumed: event.defaultPrevented, executions, changes }).toEqual({ consumed: true, executions: 1, changes: 1 });
      unregister();
      expect(changes).toBe(2);
      unsubscribe();
      registry.changed();
      expect(changes).toBe(2);
    } finally { dispose(); unsubscribe(); }
  });

  it('keeps all parity rows traceable to source, feature owner and executable case', () => {
    expect(new Set(parityRows.map(row => row.id)).size).toBe(20);
    for (const row of parityRows) {
      expect(row.source.every(source => sources[source].length > 0)).toBe(true);
      expect(row.owner.every(owner => owner >= 5 && owner <= 33)).toBe(true);
      expect(row.case).toMatch(/^[a-z]+(?:-[a-z]+)+$/);
    }
  });

  it('normalizes literal shifted punctuation and preserves modifier distinctions', () => {
    expect(normalizeShortcut('Meta+Shift+Z')).toBe('Meta+Shift+z');
    expect(normalizeShortcut('+')).toBe('+');
    expect(normalizeKey(new KeyboardEvent('keydown', { key: '+', shiftKey: true }))).toBe('+');
    expect(normalizeShortcut('Ctrl+y')).not.toBe(normalizeShortcut('Meta+y'));
  });
});
