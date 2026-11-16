import { expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { indexDocument } from '../../../../src/domain/event-time';
import { decodeProject } from '../../../../src/main/projects';
import { QaFailure } from '../../lib/contracts';
import { attackEnergyVerdict, describeAttackEnergy } from '../../lib/attack-energy';
import type { QaContext } from '../../lib/contracts';
import type { NativeInput } from '../../lib/native';

type Surface = { readonly context: QaContext; readonly application: ElectronApplication; readonly page: Page };
type Point = { readonly x: number; readonly y: number };
export async function loopInput({ context, application, page }: Surface, native?: NativeInput) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
  await page.waitForFunction(() => Boolean(window.fretlinePlaybackObservation?.().hits?.beats.length), undefined, { timeout: 20_000 });
  context.assert(await page.locator('[data-area="score"] [data-testid="editor-surface"]').count() === 1 &&
    await page.getByTestId('editor-harness').count() === 0 && await page.evaluate(() => location.hash) === '',
  'The argv-opened fixture is rendered in the production shell EditorScoreView, without a harness route');
  const pid = application.process().pid;
  const origin = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds());
  if (native && pid !== undefined) await native(['focus', String(pid)]);
  const key = async (name: 'F9' | 'Space' | 'Escape'): Promise<void> => {
    context.log(`Key ${name}`);
    if (native) await native(['key', String({ F9: 101, Space: 49, Escape: 53 }[name])]);
    else await page.keyboard.press(name);
  };
  const clickPoint = async (point: Point): Promise<void> => {
    if (native && origin) await native(['click', String(origin.x + point.x), String(origin.y + point.y)]);
    else await page.mouse.click(point.x, point.y);
  };
  const click = async (locator: Locator): Promise<void> => {
    const box = await locator.boundingBox();
    if (!box) throw new QaFailure('assertion', 'Loop control has no visible bounds');
    await clickPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  };
  const point = async (quarter: number): Promise<Point> => {
    if (native) await native(['key', '121']);
    else {
      const viewport = await page.locator('.score-scroll').boundingBox();
      if (viewport) { await page.mouse.move(viewport.x + 50, viewport.y + 50); await page.mouse.wheel(0, 1); }
    }
    if (await page.getByTestId('transport').getAttribute('data-status') === 'playing') {
      await expect(page.getByTestId('transport')).toHaveAttribute('data-follow', 'false');
    }
    const result = await page.evaluate(quarter => {
      const map = window.fretlinePlaybackObservation?.().hits;
      const track = map?.beats[0]?.trackId;
      const hit = map?.beats.find(hit => hit.trackId === track && Number(hit.startQ.n) / Number(hit.startQ.d) === quarter);
      const engine = document.querySelector('[data-testid="score-engine"]');
      const scroll = engine?.closest('.score-scroll');
      if (!hit || !(engine instanceof HTMLElement) || !(scroll instanceof HTMLElement)) return null;
      const y = engine.getBoundingClientRect().top + hit.bounds.y;
      const viewport = scroll.getBoundingClientRect();
      if (y < viewport.top + 30 || y + hit.bounds.height > viewport.bottom - 30) scroll.scrollTop += y - viewport.top - viewport.height / 2;
      const box = engine.getBoundingClientRect();
      return { x: box.x + hit.bounds.x + hit.bounds.width / 2, y: box.y + hit.bounds.y + hit.bounds.height / 2 };
    }, quarter);
    if (!result) throw new QaFailure('assertion', `No rendered beat at written quarter ${quarter}`);
    return result;
  };
  const drag = async (from: number, to: number, handle?: 'start' | 'end'): Promise<void> => {
    context.log(`Drag ${handle ?? 'beats'} ${from} -> ${to} through real pointer input`);
    let start = await point(from);
    if (handle) {
      const target = page.getByTestId(`selection-handle-${handle}`);
      await target.scrollIntoViewIfNeeded();
      const bounds = await target.boundingBox();
      if (!bounds) throw new QaFailure('assertion', 'Resize handle missing');
      start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    }
    if (native && origin) {
      const end = await point(to);
      await native(['drag', ...[origin.x + start.x, origin.y + start.y, origin.x + end.x, origin.y + end.y].map(String)]);
    } else {
      context.log(`Pointer press ${JSON.stringify(start)} on ${await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.tagName, start)}`);
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(start.x + 5, start.y);
      context.log(`Gesture started: ${JSON.stringify(await page.evaluate(() => window.fretlineLoopObservation?.()))}`);
      const end = await point(to);
      await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
    }
  };
  const assertRange = async (start: number, end: number): Promise<void> => {
    await expect.poll(() => page.evaluate(() => {
      const selection = window.fretlineLoopObservation?.().selection;
      return selection?.kind === 'timeRange' ? [
        Math.min(Number(selection.anchor.startQ.n) / Number(selection.anchor.startQ.d), Number(selection.focus.startQ.n) / Number(selection.focus.startQ.d)),
        Math.max(Number(selection.anchor.endQ.n) / Number(selection.anchor.endQ.d), Number(selection.focus.endQ.n) / Number(selection.focus.endQ.d)),
      ] : null;
    })).toEqual([start, end]);
    const overlay = await page.locator('[data-overlay-kind="selection"]').count();
    context.assert(overlay === (end - start) * 2, `[${start},${end}) blue overlay covers exactly ${end - start} beats in standard and TAB notation (actual ${overlay})`);
    const geometry = await page.evaluate(({ start, end }) => {
      const map = window.fretlinePlaybackObservation?.().hits;
      const selection = window.fretlineLoopObservation?.().selection;
      const canvas = document.querySelector('[data-testid="score-engine"]')?.getBoundingClientRect();
      const expected = map?.beats.filter(hit => selection?.scope.trackIds.includes(hit.trackId) &&
        Number(hit.startQ.n) / Number(hit.startQ.d) >= start && Number(hit.endQ.n) / Number(hit.endQ.d) <= end)
        .map(hit => ({ x: (canvas?.x ?? 0) + hit.bounds.x, y: (canvas?.y ?? 0) + hit.bounds.y,
          width: hit.bounds.width, height: hit.bounds.height,
          heads: (map.notes ?? []).filter(note => {
            if (note.eventId !== hit.eventId || note.system !== hit.system) return false;
            const distance = (beat: typeof hit): number => Math.max(0, beat.bounds.y - (note.bounds.y + note.bounds.height),
              note.bounds.y - (beat.bounds.y + beat.bounds.height));
            const rows = map.beats.filter(beat => beat.eventId === note.eventId && beat.system === note.system);
            return rows.reduce((nearest, beat) => distance(beat) < distance(nearest) ? beat : nearest, hit) === hit;
          }).map(note => ({ y: (canvas?.y ?? 0) + note.bounds.y, height: note.bounds.height })) })) ?? [];
      const actual = [...document.querySelectorAll('[data-overlay-kind="selection"]')].map(rect => {
        const box = rect.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, fill: getComputedStyle(rect).fill, stroke: getComputedStyle(rect).stroke };
      });
      return { expected, actual };
    }, { start, end });
    const covers = (expected: typeof geometry.expected[number], actual: typeof geometry.actual[number]): boolean =>
      Math.abs(expected.x - actual.x) <= 0.5 && Math.abs(expected.width - actual.width) <= 0.5 &&
      actual.y <= expected.y + 0.5 && actual.y + actual.height >= expected.y + expected.height - 0.5;
    context.assert(geometry.expected.length === overlay && geometry.expected.every(expected => geometry.actual.some(actual => covers(expected, actual))),
    `[${start},${end}) every overlay's left/right edges match its rendered beat within 0.5 CSS px and it covers the beat vertically`);
    const bandRows = new Map<number, { top: number; bottom: number }>();
    for (const actual of geometry.actual) {
      const row = [...bandRows.keys()].find(top => Math.abs(top - actual.y) <= 0.5);
      if (row === undefined) bandRows.set(actual.y, { top: actual.y, bottom: actual.y + actual.height });
      else bandRows.set(row, { top: row, bottom: Math.max(bandRows.get(row)?.bottom ?? 0, actual.y + actual.height) });
    }
    context.assert(geometry.actual.every(actual => [...bandRows.values()].some(row => Math.abs(row.top - actual.y) <= 0.5 &&
      Math.abs(row.bottom - (actual.y + actual.height)) <= 0.5)), `[${start},${end}) each engraved row's band is one straight strip`);
    context.assert(geometry.expected.every(expected => expected.heads.every(head => geometry.actual.some(actual =>
      Math.abs(expected.x - actual.x) <= 0.5 && actual.y <= head.y + 0.5 && actual.y + actual.height >= head.y + head.height - 0.5))),
    `[${start},${end}) the band covers every selected note head, including ledger-line notes`);
    await writeFile(resolve(context.evidence, `overlay-${start}-${end}.json`), JSON.stringify(geometry, null, 2));
  };
  // Expected sounding events come from the opened fixture itself, independent of what the view happens to display.
  const ids = async (start: number, end: number) => {
    const opened = decodeProject(await readFile(resolve('tests/fixtures/projects/loop-eight-bars.fretline')));
    if (opened.kind !== 'editable') throw new QaFailure('assertion', 'Loop fixture is not an editable project');
    const score = opened.parts.project.score;
    const locations = indexDocument(score).events;
    return score.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice => voice.bars.flatMap(bar =>
      bar.kind === 'active' ? bar.events.filter(event => event.kind === 'noteGroup') : [])))
      .flatMap(event => {
        const location = locations.get(event.id);
        if (!location) throw new QaFailure('assertion', 'Fixture event has no timeline position');
        const q = Number(location.startQ.n) / Number(location.startQ.d);
        return q >= start && q < end ? [{ id: event.id as string, track: track.id as string, q }] : [];
      }));
  };
  const shot = async (name: string): Promise<void> => {
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
    if (native && pid !== undefined) await native(['screenshot', resolve(context.evidence, name), String(pid)]);
    else await page.screenshot({ path: resolve(context.evidence, name) });
  };
  const save = async (): Promise<void> => {
    await click(page.getByTestId('save-audio-evidence'));
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
  };
  return { page, key, click, clickPoint, point, drag, assertRange, ids, shot, save };
}

type Expected = {
  readonly start: number; readonly end: number; readonly period: number; readonly cycles: number;
  readonly ids: readonly { readonly id: string; readonly track: string; readonly q: number }[];
};
export async function inspectLoopCapture(context: QaContext, expected: Expected): Promise<void> {
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  const data: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
  if (typeof data !== 'object' || !data || !('attacks' in data) || !Array.isArray(data.attacks) ||
    !('startTime' in data) || typeof data.startTime !== 'number') throw new QaFailure('assertion', 'Invalid capture log');
  const attacks = data.attacks.map((value: unknown) => {
    if (typeof value !== 'object' || !value || !('eventId' in value) || typeof value.eventId !== 'string' ||
      !('audioTime' in value) || typeof value.audioTime !== 'number' || !('key' in value) || typeof value.key !== 'number' ||
      !('trackId' in value) || typeof value.trackId !== 'string') throw new QaFailure('assertion', 'Invalid attack identity');
    return { id: value.eventId, time: value.audioTime, key: value.key, track: value.trackId };
  });
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 48000 &&
    wav.readUInt16LE(22) === 2 && wav.readUInt32LE(40) === wav.length - 44, 'Actual master-bus PCM16 stereo 48 kHz WAV has consistent frame count');
  const first = Math.min(...attacks.map(attack => attack.time));
  const cycleSize = expected.ids.length;
  context.assert(cycleSize === (expected.end - expected.start) * 3, 'Expected passage spans all three fixture tracks');
  context.assert(attacks.every(attack => expected.ids.some(event => event.id === attack.id)), 'No attack outside the half-open passage');
  const timing: number[] = [];
  for (let cycle = 0; cycle < expected.cycles; cycle++) {
    const events = attacks.filter(attack => attack.time >= first + cycle * expected.period - 0.001 &&
      attack.time < first + (cycle + 1) * expected.period - 0.001);
    context.assert(events.length === cycleSize && events.map(event => event.id).sort().join() === expected.ids.map(event => event.id).sort().join(),
      `Cycle ${cycle + 1} contains exactly the expected attack IDs once per track`);
    for (const event of events) {
      const q = expected.ids.find(candidate => candidate.id === event.id)?.q;
      if (q === undefined) throw new QaFailure('assertion', 'Unknown event in capture');
      timing.push(Math.abs(event.time - first - cycle * expected.period - (q - expected.start) * expected.period / (expected.end - expected.start)));
    }
  }
  context.assert(Math.max(...timing) <= 128 / 48000, `Three cycles have ${expected.period} s periods with at most one block endpoint drift`);
  const frames = (wav.length - 44) / 4;
  const startTime = data.startTime;
  const energy = (time: number, key: number): number => {
    const start = Math.round((time - startTime) * 48000);
    let real = 0; let imaginary = 0;
    const frequency = 440 * 2 ** ((key - 69) / 12);
    for (let i = 0; i < 4096; i++) {
      const frame = start + i;
      if (frame < 0 || frame >= frames) continue;
      const sample = (wav.readInt16LE(44 + frame * 4) + wav.readInt16LE(46 + frame * 4)) / 65536;
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 4095);
      real += sample * window * Math.cos(2 * Math.PI * frequency * i / 48000);
      imaginary += sample * window * Math.sin(2 * Math.PI * frequency * i / 48000);
    }
    return Math.hypot(real, imaginary) / 4096;
  };
  const measured = attacks.slice(0, cycleSize * expected.cycles).map(attack => ({ ...attack, energy: energy(attack.time + 0.03, attack.key) }));
  const audible = attackEnergyVerdict(measured.map(attack => attack.energy));
  context.assert(audible.passed, `Every expected attack frequency is present in recorded PCM within 30-115 ms (${describeAttackEnergy(audible)})`);
  const origin = Math.round((first - startTime) * 48000);
  const periodFrames = Math.round(expected.period * 48000);
  let a2 = 0; let b2 = 0; let ab = 0;
  for (let i = 0; i < periodFrames - 128; i++) {
    const a = wav.readInt16LE(44 + (origin + periodFrames + i) * 4);
    const b = wav.readInt16LE(44 + (origin + 2 * periodFrames + i) * 4);
    a2 += a * a; b2 += b * b; ab += a * b;
  }
  const correlation = ab / Math.sqrt(a2 * b2);
  context.assert(correlation > 0.999, `Recorded PCM independently repeats at exactly ${periodFrames} frames (${expected.period} s), correlation ${correlation}`);
  let tail = 0;
  for (let frame = Math.max(0, frames - 9600); frame < frames; frame++) tail += wav.readInt16LE(44 + frame * 4) ** 2;
  context.assert(Math.sqrt(tail / 9600) < 4, 'Stop releases notes and the last 200 ms of recorded output are silent');
  await writeFile(resolve(context.evidence, 'audio-analysis.json'), JSON.stringify({ ...expected, measured, correlation, maximumTimingError: Math.max(...timing), frames }, null, 2));
}
