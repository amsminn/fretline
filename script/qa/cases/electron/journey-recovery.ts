import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { chooseThroughOpen } from './import-support';
import { readEditing } from './editing-support';
import { withSessionApp } from './session-support';
import { clickBeat, commitStep, contentHash, hitsOf, ready, savePicker, shot } from './journey-support';
import { journeyHelp } from './journey-workspace';

/** Both launches honor context.app, including the post-crash recovery process. */
export async function journeyRecovery(context: QaContext, launch: { readonly userData: string; readonly file: string }): Promise<void> {
  context.log('Stage crash recovery: reopen saved file -> durable unsaved edit -> forced kill -> recovery');
  let lastEdit = '';
  await withSessionApp(context, launch.userData, async surface => {
    const { page, application } = surface;
    context.assert(await application.evaluate(({ app }) => app.isPackaged) === Boolean(context.app),
      'Crash-stage process matches the requested packaged or development app');
    await chooseThroughOpen(context, surface, launch.file);
    await ready(page);
    const opened = await contentHash(page);
    const target = (await hitsOf(page))[0];
    if (!target) throw new QaFailure('assertion', 'Saved document has no rendered beat to edit');
    await clickBeat(page, target.eventId);
    lastEdit = await commitStep(page, () => page.keyboard.press('3'));
    context.assert(lastEdit !== opened, 'Unsaved fret edit changes the reopened document hash');
    const { revision } = await readEditing(page);
    await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'true');
    await expect(page.getByTestId('recovery-status')).toHaveAttribute('data-revision', String(revision), { timeout: 20_000 });
    await shot(context, page, 'w5-before-crash');
    context.assert(true, `Autosave acknowledged revision ${revision} before the forced kill`);
    const child = application.process();
    if (child.pid === undefined) throw new QaFailure('infrastructure', 'Missing owned Electron PID');
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    process.kill(-child.pid, 'SIGKILL');
    await exited;
    context.log(`Forced owned Electron process group ${child.pid} to exit without clean-quit hooks`);
  });
  await withSessionApp(context, launch.userData, async surface => {
    const { page } = surface;
    context.assert(await surface.application.evaluate(({ app }) => app.isPackaged) === Boolean(context.app),
      'Recovery-stage process matches the requested packaged or development app');
    await expect(page.getByTestId('recovery-dialog')).toBeVisible();
    await shot(context, page, 'w5-recovery-dialog');
    await page.getByRole('button', { name: '복구', exact: true }).click();
    await expect(page.getByTestId('recovery-dialog')).toBeHidden();
    await ready(page);
    await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'true');
    context.assert(await contentHash(page) === lastEdit, 'Recovery restores exactly the last acknowledged unsaved edit');
    await shot(context, page, 'w5-recovered');
    await savePicker(surface, resolve(context.evidence, 'Recovered.fretline'));
    await page.keyboard.press('Meta+Shift+s');
    await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'false');
    await journeyHelp(context, surface);
  });
}
