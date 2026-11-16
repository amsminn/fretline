import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { CommandRegistry } from '../../../../src/renderer/commands/registry';
import type { QaCase } from '../../lib/contracts';

export const run: QaCase = async context => {
  const window = new Window();
  const registry = new CommandRegistry();
  let scoreMutations = 0;
  for (const id of ['effects.bend', 'sound.playPause', 'selection.all']) {
    registry.register(id, { execute: () => { scoreMutations++; } });
  }
  const input = window.document.createElement('input');
  input.value = 'B Space Cmd+A stay in this text box';
  window.document.body.append(input);
  input.focus();
  try {
    for (const options of [{ key: 'B' }, { key: ' ' }, { key: 'a', metaKey: true }]) {
      const event = new window.KeyboardEvent('keydown', options);
      const result = registry.route(event, { platform: 'mac', playing: true, dialog: false, target: input });
      context.log(`Focused text box key=${JSON.stringify(options)} route=${result}`);
      context.assert(result === 'unmatched' && scoreMutations === 0, `Text key ${JSON.stringify(options)} does not execute score handlers`);
    }
    // Positive control prevents an unconnected registry from passing the negative test.
    const control = registry.route(new window.KeyboardEvent('keydown', { key: 'b' }),
      { platform: 'mac', playing: false, dialog: false, target: null });
    context.assert(control === 'executed' && scoreMutations === 1, 'B executes its registered handler outside text input');
    for (const surface of ['menu', 'palette', 'toolbar'] as const) {
      const visible = registry.present(surface, { context: 'editing', platform: 'mac' });
      context.assert(visible.length === 3 && !visible.some(command => command.id === 'note.rest'),
        `Pending rest is absent from ${surface}`);
    }
    context.assert(registry.execute('note.rest', 'editing') === 'pending' && scoreMutations === 1, 'Pending action cannot execute');
    await writeFile(join(context.evidence, 'context.json'), JSON.stringify({
      textValue: input.value, negativeMutations: 0, positiveControlMutations: scoreMutations,
      surfaces: registry.menu({ context: 'editing', platform: 'mac' }),
    }, null, 2));
  } finally { await window.happyDOM.close(); }
};
