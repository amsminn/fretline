import { _electron, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { parseManifest } from '../../../../src/domain/project';
import { parseScoreDocument } from '../../../../src/domain/validate';
import type { QaContext } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import { koreanSystem } from '../../lib/electron';

export async function withRecoveryApp(context: QaContext, launch: { readonly userData: string; readonly file?: string },
  action: (surface: ImportSurface) => Promise<'crash' | 'close'>): Promise<void> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
  const application = await _electron.launch({ args: [resolve('out/main/index.js'), ...(launch.file ? [launch.file] : []), ...koreanSystem],
    env: { ...environment, FRETLINE_QA: '1', FRETLINE_QA_HEADLESS: '1', FRETLINE_QA_PARENT_PID: String(process.pid),
      FRETLINE_QA_EVIDENCE: context.evidence, FRETLINE_USER_DATA: launch.userData }, timeout: 30_000 });
  const child = application.process();
  context.log(`Started hidden Electron ${child.pid}; isolated userData=${launch.userData}`);
  const errors: string[] = [];
  let page: Page | undefined;
  try {
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => context.log(`renderer ${message.type()}: ${message.text()}`));
    Object.assign(context.versions, await application.evaluate(() => process.versions));
    await page.getByTestId('renderer-ready').waitFor({ timeout: 25_000 });
    const result = await action({ application, page });
    context.assert(errors.length === 0, `No uncaught renderer errors: ${errors.join('; ')}`);
    if (result === 'crash') {
      const exited = new Promise<void>(done => child.once('exit', () => done()));
      if (child.pid === undefined) throw new TypeError('Missing Electron PID');
      process.kill(-child.pid, 'SIGKILL');
      await exited;
      context.log('Forced process-group SIGKILL after durable recovery receipt; no clean-quit hooks ran');
    }
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: resolve(context.evidence, 'failure.png') });
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      // Closing a window with unsaved edits opens the save-changes prompt; teardown is bounded by the owned child.
      const forced = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { context.log(`Teardown forced: SIGKILL owned Electron ${child.pid}`); child.kill('SIGKILL'); }
      }, 5_000);
      const exitedAfterClose = new Promise<void>(done => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once('exit', () => done()); });
      try { await Promise.race([application.close(), exitedAfterClose]); await exitedAfterClose; } finally { clearTimeout(forced); }
    }
    let gone = false;
    try { if (child.pid !== undefined) process.kill(child.pid, 0); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') gone = true; else throw error; }
    context.cleanup.push({ name: 'Recovery Electron (kill-0 failed)', pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, reaped: gone });
    context.log(`Electron teardown ${child.pid}: kill-0 fails=${gone}`);
  }
}

export async function setTitle(page: Page, title: string): Promise<void> {
  await page.locator('[data-inspector-tab="song"]').click();
  await page.locator('[data-metadata="title"]').fill(title);
  await expect.poll(() => page.evaluate(() => window.fretlineArrangementObservation?.()?.score.metadata.title)).toBe(title);
  await page.locator('[data-metadata="title"]').blur();
}
export async function generationFor(userData: string, title: string): Promise<string> {
  let found = '';
  await expect.poll(async () => {
    const projects = join(userData, 'recovery/projects');
    try {
      for (const project of await readdir(projects)) {
        for (const generation of (await readdir(join(projects, project))).filter(name => /^\d{16}$/.test(name)).sort().reverse()) {
          const directory = join(projects, project, generation);
          const score = parseScoreDocument(JSON.parse(await readFile(join(directory, 'score.json'), 'utf8')));
          if (score.metadata.title === title) { found = directory; return true; }
        }
      }
      return false;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }, { timeout: 20_000 }).toBe(true);
  return found;
}
/** Independent fflate ZIP decoder plus domain validation; never uses the production project reader. */
export async function inspectArchive(path: string) {
  const bytes = await readFile(path);
  const entries = unzipSync(bytes);
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(entries['manifest.json'])));
  const scoreBytes = entries['score.json'];
  if (!scoreBytes) throw new TypeError('Missing saved score');
  const score = parseScoreDocument(JSON.parse(new TextDecoder().decode(scoreBytes)));
  expect(createHash('sha256').update(scoreBytes).digest('hex')).toBe(manifest.scoreSha256);
  for (const reference of [...manifest.assets.map(asset => ({ ...asset, path: `assets/${asset.sha256}` })),
    ...(manifest.source ? [{ ...manifest.source, path: `source/original.${manifest.source.extension}` }] : [])]) {
    const data = entries[reference.path];
    if (!data) throw new TypeError(`Missing ${reference.path}`);
    expect(data.length).toBe(reference.byteLength);
    expect(createHash('sha256').update(data).digest('hex')).toBe(reference.sha256);
  }
  return { manifest, score, entries };
}
export async function captureRecovery(context: QaContext, page: Page): Promise<void> {
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ['dark', 'light']) {
      const styles = await page.evaluate(async theme => {
        document.documentElement.dataset['theme'] = theme;
        const sample = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="recovery-dialog"] button')]
          .filter(button => ['사본 저장', '나중에'].includes(button.textContent?.trim() ?? '')).map(button => {
            const style = getComputedStyle(button);
            return { label: button.textContent?.trim(), disabled: button.disabled, foreground: style.color,
              background: style.backgroundColor, opacity: style.opacity };
          });
        const before = sample(); // Computed style flush creates the theme's CSS transitions.
        let observedTransitions = 0;
        const active = () => document.getAnimations().filter(animation => (animation.playState === 'running' || animation.pending) &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime));
        for (let transitions = active(); transitions.length; transitions = active()) {
          observedTransitions += transitions.length;
          await Promise.all(transitions.map(animation => animation.finished.catch((error: unknown) => {
            // Resizing can replace a CSS transition; await its replacement on the next observation.
            if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
          })));
        }
        return { before, after: sample(), observedTransitions };
      }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(styles.after).toHaveLength(2);
      for (const button of styles.after) {
        expect(button.disabled).toBe(false);
        expect(button.opacity).toBe('1');
        const luminance = (color: string): number => {
          const rgb = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
          if (!rgb || rgb.length !== 3) throw new TypeError(`Expected computed RGB: ${color}`);
          return rgb.reduce((sum, value, index) => {
            const channel = value / 255;
            return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * ([0.2126, 0.7152, 0.0722][index] ?? 0);
          }, 0);
        };
        const foreground = luminance(button.foreground), background = luminance(button.background);
        context.assert((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) >= 4.5,
          `${theme}/${width}: ${button.label} is enabled and settled text contrast meets 4.5:1`);
      }
      await writeFile(resolve(context.evidence, `recovery-${width}-${theme}-styles.json`), JSON.stringify(styles, null, 2));
      await page.screenshot({ path: resolve(context.evidence, `recovery-${width}-${theme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
