import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { CommandRegistry } from '../../../../src/renderer/commands/registry';
import { normalizeKey } from '../../../../src/renderer/commands/keymap';
import type { Platform } from '../../../../src/renderer/commands/keymap';
import type { QaCase } from '../../lib/contracts';

export const run: QaCase = async context => {
  const window = new Window();
  const registry = new CommandRegistry();
  const executed: string[] = [];
  for (const id of ['sound.loop', 'sound.playPause', 'note.durationShorter', 'sound.speedUp', 'edit.undo', 'edit.redo']) {
    registry.register(id, { execute: () => { executed.push(id); } });
  }
  const cases: readonly {
    readonly event: Pick<KeyboardEventInit, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey'>; readonly playing: boolean;
    readonly platform: Platform; readonly expected: string;
  }[] = [
    { event: { key: 'F9' }, playing: false, platform: 'mac', expected: 'sound.loop' },
    { event: { key: ' ' }, playing: false, platform: 'mac', expected: 'sound.playPause' },
    { event: { key: '+', shiftKey: true }, playing: false, platform: 'mac', expected: 'note.durationShorter' },
    { event: { key: '+', shiftKey: true }, playing: true, platform: 'mac', expected: 'sound.speedUp' },
    { event: { key: 'z', metaKey: true }, playing: false, platform: 'mac', expected: 'edit.undo' },
    { event: { key: 'y', ctrlKey: true }, playing: false, platform: 'windows', expected: 'edit.redo' },
    { event: { key: 'Z', metaKey: true, shiftKey: true }, playing: false, platform: 'mac', expected: 'edit.redo' },
  ];
  try {
    const trace = cases.map(row => {
      const event = new window.KeyboardEvent('keydown', row.event);
      const before = executed.length;
      const result = registry.route(event, { platform: row.platform, playing: row.playing, dialog: false, target: null });
      context.log(`key=${normalizeKey(event)} platform=${row.platform} playing=${row.playing} result=${result}`);
      context.assert(result === 'executed' && executed.length === before + 1 && executed.at(-1) === row.expected,
        `${row.platform} ${normalizeKey(event)} routes to ${row.expected}`);
      return { key: normalizeKey(event), expected: row.expected, result, actual: executed.at(-1) };
    });
    await writeFile(join(context.evidence, 'routing.json'), JSON.stringify(trace, null, 2));
  } finally { await window.happyDOM.close(); }
};
