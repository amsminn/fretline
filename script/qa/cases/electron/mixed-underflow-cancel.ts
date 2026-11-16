import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { mixedFixture } from './mixed-clock';
import { withImportApp } from './import-support';
import { loopInput } from './drag-loop-support';
import { waitAudio } from './playback-support';

export const run: QaCase = async context => {
  const fixture = await mixedFixture(context);
  await withImportApp(context, fixture, async surface => {
    const { page } = surface;
    page.on('crash', () => context.log('Renderer crashed during mixed cancellation'));
    page.on('close', () => context.log('Renderer closed during mixed cancellation'));
    surface.application.process().on('exit', (code, signal) => context.log(`Electron exited: ${JSON.stringify({ code, signal })}`));
    surface.application.process().stderr?.on('data', (bytes: Buffer) => context.log(`Electron stderr: ${bytes.toString().trim()}`));
    const input = await loopInput({ context, ...surface });
    // Fault only the real producer boundary. Synthesis, DSP, input and captures stay shipped code.
    await page.evaluate(() => {
      const post = MessagePort.prototype.postMessage;
      let chunks = 0;
      MessagePort.prototype.postMessage = function(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
        const send = (): void => {
          if (Array.isArray(options)) post.call(this, message, { transfer: options });
          else post.call(this, message, options);
        };
        if (Array.isArray(message) && message[1] === 'addBuffers' && ++chunks > 14) setTimeout(send, 1800);
        else send();
      };
    });
    context.log('Delayed actual Signalsmith PCM deliveries by 1800 ms after the first rolling window');
    await input.key('Space');
    await page.waitForFunction(() => window.fretlinePlaybackObservation?.().state.buffering === true, undefined, { timeout: 30000 });
    const frozen = await page.evaluate(() => window.fretlinePlaybackObservation?.().state.tick);
    await waitAudio(page, 0.3);
    context.assert(await page.evaluate(() => window.fretlinePlaybackObservation?.().state.tick) === frozen,
      'The cursor freezes while the backing producer is underflowing');
    await page.screenshot({ path: resolve(context.evidence, 'buffering.png') });
    context.log('Stop the buffering generation');
    await input.click(page.locator('[data-command="sound.stop"]').first());
    await input.key('Space');
    context.log('Seek the restarted generation forward');
    await input.click(page.locator('[data-command="sound.fastForward"]').first());
    context.log('Seek the restarted generation backward');
    await input.click(page.locator('[data-command="sound.stepBackward"]').first());
    context.log('Stop before delayed PCM replies arrive');
    await input.click(page.locator('[data-command="sound.stop"]').first());
    await waitAudio(page, 2.5);
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
    await page.getByTestId('save-audio-evidence').click();
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
    const wav = await readFile(resolve(context.evidence, 'playback.wav'));
    const frames = (wav.length - 44) / 4;
    let tailPeak = 0;
    for (let frame = frames - 48000; frame < frames; frame++) for (let channel = 0; channel < 2; channel++) {
      tailPeak = Math.max(tailPeak, Math.abs(wav.readInt16LE(44 + frame * 4 + channel * 2)));
    }
    context.assert(tailPeak < 4, 'Late PCM deliveries and rapid seeks cannot revive either stopped audio path');
    await writeFile(resolve(context.evidence, 'underflow.json'), JSON.stringify({ frozenTick: frozen, tailPeak, frames }, null, 2));
  });
};
