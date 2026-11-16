import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultSettings, rendererSettings } from '../../src/main/settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { DesktopBridge, MenuAvailabilityEntry } from '../../src/preload';
import { Shell } from '../../src/renderer/shell/Shell';
import { ServicesContext } from '../../src/renderer/shell/services';
import { transportRuntime } from '../../src/renderer/commands/transport';
import { editingRuntime } from '../../src/renderer/commands/editing';
import { structureRuntime } from '../../src/renderer/commands/structure';
import { caretSelection, selectionStore } from '../../src/renderer/editor/selection-state';
import { TooltipProvider } from '../../src/renderer/ui';
import { AudioEnvironment } from '../audio/audio-environment';
import { installShellEnvironment, openFixture, services } from './shell-harness';
import { syntheticHitMap } from './selection-fixture';
import { projectHash } from '../../src/main/projects';

// Engraving is not this contract; the Shell, registry, commands and transport remain real.
vi.mock('../../src/renderer/score/ScoreView', () => ({ ScoreView: () => <div data-testid="score-view" /> }));
installShellEnvironment();
const disposers: (() => void)[] = [];
let audio: AudioEnvironment;
beforeEach(async () => {
  audio = new AudioEnvironment();
  audio.install();
  const font = new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2'));
  vi.stubGlobal('fetch', async () => new Response(font));
});
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); selectionStore.clear(); vi.useRealTimers(); });

async function setup() {
  const context = services();
  const project = await openFixture(context.documents, 'loop-eight-bars', 'Practice contexts');
  const editor = editingRuntime(context);
  disposers.push(editor.mount());
  await editor.idle();
  const hit = syntheticHitMap(project.score, 1).beats[0];
  if (!hit) throw new RangeError('Missing fixture beat');
  selectionStore.set(caretSelection(project.score, hit));
  const callbacks = new Set<(id: string) => void>();
  const published: (readonly MenuAvailabilityEntry[])[] = [];
  const unavailable = (): never => { throw new RangeError('Unexpected file IPC'); };
  const bridge: DesktopBridge = {
    menuSync: async availability => { published.push(availability); },
    onMenuCommand: listener => { callbacks.add(listener); return () => { callbacks.delete(listener); }; },
    pendingOpenFiles: async () => [], onOpenFiles: () => () => {},
    bootstrapStatus: unavailable, createProject: unavailable, openDocument: unavailable,
    recentFiles: unavailable, openSelectedFile: unavailable, releaseDocument: unavailable,
    recentForget: unavailable, recentPin: unavailable, closeWindow: unavailable, cancelClose: unavailable, receiveClose: unavailable, onCloseRequested: () => () => {},
    setPlaybackActive: async () => {},
    preferences: { get: async () => rendererSettings(defaultSettings, ['ko-KR']), set: unavailable },
    saveProject: unavailable, saveProjectAs: unavailable, readAsset: unavailable,
    listRecovery: async () => [],
    writeRecovery: async (_token, revision, parts) => ({ kind: 'written', projectId: parts.project.projectId, revision,
      contentHash: projectHash(parts.project), generation: '0000000000000001', writtenAssetBytes: 0 }),
    restoreRecovery: unavailable, discardRecovery: unavailable,
    exportArtifact: unavailable, exportArtifactSet: unavailable, beginExportStream: unavailable,
    writeExportStream: unavailable, commitExportStream: unavailable, abortExportStream: unavailable,
    renderAudio: unavailable, cancelAudioRender: unavailable, onAudioRenderProgress: () => () => {},
    printPdf: unavailable, printPages: unavailable,
  };
  vi.stubGlobal('desktop', bridge);
  render(<ServicesContext.Provider value={context}><TooltipProvider><Shell bridge={bridge} /></TooltipProvider></ServicesContext.Provider>);
  const runtime = transportRuntime(context);
  const duration = (): number | undefined => {
    const event = context.documents.getSnapshot().active?.project.score.tracks[0]?.staves[0]?.voices[0]?.bars[0];
    if (event?.kind !== 'active') return undefined;
    const written = event.events[0]?.duration;
    return written === 'fullMeasure' ? undefined : written?.base;
  };
  const key = async (value: string): Promise<void> => {
    await act(async () => { fireEvent.keyDown(document, { key: value }); await editor.idle(); });
  };
  const menu = async (id: string): Promise<void> => {
    await act(async () => { for (const callback of callbacks) callback(id); await editor.idle(); });
  };
  return { context, runtime, editor, duration, key, menu, published };
}

describe('mounted Shell practice contexts', () => {
  it('restores editing menu availability after an arrangement dialog is cancelled', async () => {
    const app = await setup();
    const enabled = () => app.published.at(-1)?.find(entry => entry.id === 'note.durationShorter')?.enabled;
    expect(enabled()).toBe(true);

    await act(async () => {
      await app.menu('section.edit');
      await structureRuntime(app.context).idle();
    });
    const dialog = screen.getByRole('dialog', { name: '섹션' });
    await waitFor(() => { expect(enabled()).toBe(false); });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '취소' })); });

    await waitFor(() => { expect(enabled()).toBe(true); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await app.menu('note.durationShorter');
    expect(app.duration()).toBe(8);
  });
  it('does not republish menu availability for playback position notifications', async () => {
    const app = await setup();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await act(() => app.runtime.play());
    // The first audible tick completes the practice start transition.
    act(() => {
      audio.time = 0.2;
      vi.advanceTimersByTime(16);
    });
    const count = app.published.length;
    const tick = app.runtime.transport.getSnapshot().tick;
    act(() => {
      audio.time = 0.4;
      vi.advanceTimersByTime(16);
    });
    expect(app.runtime.transport.getSnapshot().tick).toBeGreaterThan(tick);
    expect(app.published).toHaveLength(count);
    act(() => app.runtime.stop());
  });
  it.each([['+', '-'], ['=', '_']] as const)('routes %s/%s to tempo while playing and duration otherwise', async (up, down) => {
    const app = await setup();
    await app.key(up);
    expect(app.duration()).toBe(8);
    await app.key(down);
    expect(app.duration()).toBe(4);
    const revision = app.context.documents.getSnapshot().active?.revision;
    await act(() => app.runtime.play());
    expect(app.runtime.transport.getSnapshot().status).toBe('playing');
    await app.key(up);
    expect(app.runtime.practice.getSnapshot().value).toBe(105);
    await app.key(down);
    expect(app.runtime.practice.getSnapshot().value).toBe(100);
    expect(app.duration()).toBe(4);
    expect(app.context.documents.getSnapshot().active?.revision).toBe(revision);
    act(() => app.runtime.stop());
    await app.key(up);
    expect(app.duration()).toBe(8);
    expect(app.runtime.practice.getSnapshot().value).toBe(100);
  });
  it('publishes and routes native menu contexts across playback, dialogs and stop', async () => {
    const app = await setup();
    const commands = ['sound.speedUp', 'sound.speedDown', 'note.durationShorter', 'note.durationLonger'];
    const enabled = (id: string) => app.published.at(-1)?.find(entry => entry.id === id)?.enabled;
    expect(commands.map(enabled)).toEqual([false, false, true, true]);
    await app.menu('sound.speedUp');
    expect(app.runtime.practice.getSnapshot().value).toBe(100);
    await app.menu('note.durationShorter');
    expect(app.duration()).toBe(8);
    await act(() => app.runtime.play());
    expect(commands.map(enabled)).toEqual([true, true, false, false]);
    await app.menu('sound.speedUp');
    expect(app.runtime.practice.getSnapshot().value).toBe(105);
    await app.menu('note.durationLonger');
    expect(app.duration()).toBe(8);
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'dialog'); dialog.dataset['state'] = 'open';
    try {
      await app.menu('sound.speedDown');
      expect(app.runtime.practice.getSnapshot().value).toBe(105);
    } finally { dialog.remove(); }
    await app.menu('sound.speedDown');
    expect(app.runtime.practice.getSnapshot().value).toBe(100);
    act(() => app.runtime.stop());
    expect(commands.map(enabled)).toEqual([false, false, true, true]);
    await app.menu('note.durationLonger');
    expect(app.duration()).toBe(4);
  });
});
