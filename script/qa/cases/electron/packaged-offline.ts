import { expect } from '@playwright/test';
import { listPackage } from '@electron/asar';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { mixedFixture } from './mixed-clock';
import { withPackage } from './packaged-support';
import { loopInput } from './drag-loop-support';
import { inspectMixedRecording } from './backing-support';
import { waitAudio } from './playback-support';
import { saveAs, scoreJson, captureThemes } from './session-support';
import { inspectArchive } from './recovery-support';
import { sha256 } from '../../artifacts';

export const run: QaCase = async context => {
  const app = resolve(context.app ?? 'dist/mac-arm64/Fretline.app');
  const asar = resolve(app, 'Contents/Resources/app.asar');
  const entries = listPackage(asar, { isPack: false });
  context.assert(!entries.some(entry => entry === '/node_modules' || entry.startsWith('/node_modules/')),
    'Fully bundled installer contains no unused runtime node_modules payload');
  context.assert(entries.includes('/out/renderer/index.html') &&
    entries.includes('/out/renderer/font/Bravura.woff2') &&
    entries.includes('/out/renderer/soundfont/sonivox.sf2') &&
    !entries.some(entry => /^\/(src|tests|script)\//.test(entry)),
  'Installer contains local rendering and synth assets without application source or fixture trees');
  context.versions['packagedAsarSha256'] = sha256(await readFile(asar));
  const notices = resolve(app, 'Contents/Resources/third-party-notices');
  for (const file of ['index.json', 'Bravura-OFL.txt', 'Sonivox-NOTICE.txt', 'Apache-2.0.txt', 'Electron-LICENSE.txt', 'Chromium-LICENSES.html']) {
    context.assert((await readFile(resolve(notices, file))).byteLength > 0, `Package ships readable offline notice ${file}`);
  }
  for (const [source, packaged] of [
    ['build/Apache-2.0.txt', 'Apache-2.0.txt'],
    ['node_modules/tailwindcss/LICENSE', 'tailwindcss-4.3.5/LICENSE'],
    ['node_modules/vite/LICENSE.md', 'vite-8.3.6/LICENSE.md'],
    ['build/TinySoundFont-SFZero-LICENSE.txt', 'TinySoundFont-SFZero-LICENSE.txt'],
  ] as const) {
    context.assert((await readFile(resolve(notices, packaged))).equals(await readFile(resolve(source))),
      `Package retains the complete redistribution text for ${packaged}`);
  }
  context.assert((await readFile(resolve(app, 'Contents/Resources/NOTICE'), 'utf8')).includes('https://github.com/CoderLine/alphaTab'),
    'Packaged NOTICE retains attribution and corresponding-source links');
  const fixture = await mixedFixture(context);
  const destination = resolve(context.evidence, 'Offline.fretline');
  let saved = '';
  await withPackage(context, fixture, async surface => {
    const { page } = surface;
    const input = await loopInput({ context, ...surface });
    await input.clickPoint(await input.point(0));
    await page.keyboard.press('9');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
    context.assert(true, 'Packaged score can be opened and edited through score pointer and keyboard');
    await saveAs(context, surface, destination);
    saved = await scoreJson(page);
    await input.drag(4, 7);
    await page.keyboard.press('F9');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing', { timeout: 60_000 });
    await page.waitForFunction(() => (window.fretlinePracticeObservation?.().state.completed ?? 0) >= 3,
      undefined, { timeout: 60_000 });
    await page.screenshot({ path: resolve(context.evidence, 'mixed-loop-playing.png') });
    await page.locator('[data-command="sound.stop"]').first().click();
    await waitAudio(page, 0.3);
    await page.getByTestId('save-audio-evidence').click();
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
    const capture = await inspectMixedRecording(context);
    context.assert(capture.leftPeak > 100 && capture.rightPeak > 100 && capture.attacks >= 12,
      'Bundled SF2 synth and WASM stretched backing are audible through three loop cycles in master WAV');
    const raw: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || !('attacks' in raw) || !Array.isArray(raw.attacks)) throw new TypeError('Missing attacks');
    context.assert(raw.attacks.every((event: unknown) => typeof event === 'object' && event !== null &&
      'tick' in event && typeof event.tick === 'number' && event.tick >= 0 && event.tick < 3840),
    'All captured attacks stay within the selected four-quarter passage');
    await captureThemes(page, 'offline', context.evidence);
    const interfaceFonts = ['inter-', 'noto-sans-kr-', 'jetbrains-mono-'].map(name =>
      entries.find(entry => entry.includes(`/assets/${name}`) && entry.endsWith('.woff2')));
    context.assert(interfaceFonts.every(font => font !== undefined), 'Installer contains all three required interface font families');
    const fontPaths = interfaceFonts.filter((font): font is string => font !== undefined)
      .map(font => font.replace('/out/renderer', ''));
    const local = await page.evaluate(async paths => {
      await document.fonts.ready;
      const assets = await Promise.all(paths.map(async path => {
        const response = await fetch(new URL(path, location.href));
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { path, status: response.status, magic: new TextDecoder().decode(bytes.slice(0, 4)), bytes: bytes.length };
      }));
      const fonts: { family: string; status: string }[] = [];
      document.fonts.forEach(font => fonts.push({ family: font.family, status: font.status }));
      return { fonts, assets };
    }, ['/font/Bravura.woff2', '/soundfont/sonivox.sf2', ...fontPaths]);
    context.log(`Loaded font and resource observation: ${JSON.stringify(local)}`);
    context.assert(local.assets.length === 5 && local.assets.every(asset => asset.status === 200 &&
      asset.magic === (asset.path.endsWith('.sf2') ? 'RIFF' : 'wOF2')) &&
      ['Inter', 'Noto Sans KR', 'JetBrains Mono'].every(family =>
        local.fonts.some(font => font.family.includes(family) && font.status === 'loaded')),
    'Packaged notation, soundfont and all three interface fonts load valid bytes and activate without checkout assets');
  });
  const archive = await inspectArchive(destination);
  context.assert(archive.score.tracks.length === 1, 'Independently decoded saved ZIP contains the edited score and backing');
  await withPackage(context, destination, async ({ page }) => {
    await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => scoreJson(page)).toBe(saved);
    await page.screenshot({ path: resolve(context.evidence, 'reopened.png') });
    context.assert(true, 'A second packaged process reopens the exact saved edited score');
  });
};
