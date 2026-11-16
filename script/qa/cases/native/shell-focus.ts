import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withElectron } from '../../lib/electron';
import { withNative } from '../../lib/native';
import type { QaCase } from '../../lib/contracts';
export const run: QaCase = async context => {
  await withNative(context, async input => {
    await withElectron(context, async ({ application }) => {
      const pid = application.process().pid;
      if (pid === undefined) throw new TypeError('Electron PID missing');
      await input(['focus', String(pid)]);
      const boundsText = await input(['bounds', String(pid)]);
      await writeFile(resolve(context.evidence, 'accessibility.json'), boundsText);
      const bounds: unknown = JSON.parse(boundsText);
      if (typeof bounds !== 'object' || bounds === null || !('x' in bounds) || !('y' in bounds) ||
        typeof bounds.x !== 'number' || typeof bounds.y !== 'number') throw new TypeError('Invalid AX bounds');
      await input(['screenshot', resolve(context.evidence, 'before.png'), String(pid)]);
      await input(['click', String(bounds.x + 60), String(bounds.y + 60)]);
      await input(['screenshot', resolve(context.evidence, 'after.png'), String(pid)]);
      context.assert(true, 'OS focus, AX bounds, CGEvent click and screencapture completed');
    });
  });
};
