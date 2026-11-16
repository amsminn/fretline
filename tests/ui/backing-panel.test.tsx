import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWave } from '../../src/adapters/backing/wave';
import { backingRuntime } from '../../src/renderer/backing/runtime';
import { transportRuntime } from '../../src/renderer/commands/transport';
import { selectionStore } from '../../src/renderer/editor/selection-state';
import { documentEdits } from '../../src/renderer/state/document-edits';
import { referencedBlobs } from '../../src/renderer/state/documents';
import type { ShellServices } from '../../src/renderer/shell/services';
import { installShellEnvironment, mount, openFixture, services } from './shell-harness';

vi.mock('../../src/renderer/score/ScoreView', () => ({
  ScoreView: () => <div data-testid="score-view" />,
}));
installShellEnvironment();

class AudioNodeStub {
  readonly gain = { value: 1, setTargetAtTime(): void {} }; readonly threshold = this.gain; readonly knee = this.gain;
  readonly ratio = this.gain; readonly attack = this.gain; readonly release = this.gain;
  connect(): void {} disconnect(): void {}
}
class AudioClock {
  readonly currentTime = 0; readonly destination = new AudioNodeStub();
  createGain(): AudioNodeStub { return new AudioNodeStub(); }
  createStereoPanner(): AudioNodeStub { return new AudioNodeStub(); }
  createDynamicsCompressor(): AudioNodeStub { return new AudioNodeStub(); }
  async resume(): Promise<void> {} async close(): Promise<void> {}
}

const wavBytes = (seconds: number): Uint8Array => {
  const frames = seconds * 48_000;
  const left = new Float32Array(frames).fill(0.4); const right = new Float32Array(frames).fill(-0.4);
  return encodeWave([left, right], 48_000);
};
const chooseFile = async (name: string, bytes: Uint8Array): Promise<void> => {
  const input = screen.getByTestId('backing-file');
  const file = new File([bytes.slice().buffer], name, { type: name.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(bytes.slice().buffer) });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { fireEvent.change(input); });
};
const waitIdle = async (context: ShellServices): Promise<void> => { await act(async () => { await documentEdits(context).idle(); }); };
const importWav = async (context: ShellServices, seconds: number): Promise<Uint8Array> => {
  const bytes = wavBytes(seconds);
  await chooseFile('loop.wav', bytes);
  await waitFor(() => expect(screen.getByTestId('backing-panel').dataset['asset']).toBe('ready'));
  await waitIdle(context);
  return bytes;
};

async function setup() {
  const context = services();
  const runtime = backingRuntime(context, transportRuntime(context), async () => ({ sampleRate: 48_000, channels: [new Float32Array(48_000).fill(0.2), new Float32Array(48_000).fill(0.2)] }));
  await openFixture(context.documents, 'loop-eight-bars', 'Backing panel');
  mount(context);
  const score = () => {
    const current = context.documents.getSnapshot().active;
    if (!current) throw new RangeError('Missing active document');
    return current;
  };
  return { context, runtime, score };
}

describe('backing track panel', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', AudioClock);
    Object.defineProperty(window, 'desktop', { configurable: true, value: {} });
    HTMLCanvasElement.prototype.getContext = () => null;
  });
  afterEach(() => { selectionStore.clear(); });

  it('imports a WAV through the toolbar command, attaches one undoable asset and keeps its bytes for save', async () => {
    const { context, score } = await setup();
    const waveform = screen.getByRole('button', { name: '파형 표시' });
    expect(waveform.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('backing-panel')).toBeNull();
    expect(context.registry.execute('backing.sync', 'editing')).toBe('disabled');
    fireEvent.click(waveform);
    expect(screen.getByTestId('backing-panel').dataset['asset']).toBe('none');
    expect(screen.getByTestId('backing-status').textContent).toContain('반주 오디오가 없습니다');
    const bytes = wavBytes(16);
    await chooseFile('loop.wav', bytes);
    await waitIdle(context);
    await waitFor(() => expect(screen.getByTestId('backing-panel').dataset['asset']).toBe('ready'));
    expect(screen.getByTestId('backing-status').textContent).toContain('16.0s');
    const session = score();
    expect(session.project.score.backing?.syncPoints).toEqual([]);
    expect(session.project.assets).toHaveLength(1);
    expect(session.project.assets[0]?.byteLength).toBe(bytes.byteLength);
    expect(session.dirty).toBe(true);
    expect(referencedBlobs(session).map(blob => blob.bytes)).toEqual([bytes]);
    expect(context.registry.execute('backing.sync', 'editing')).toBe('executed');
    await act(async () => { await documentEdits(context).undo(); });
    expect(score().project.score.backing).toBeUndefined();
    expect(score().project.assets).toEqual([]);
    expect(referencedBlobs(score())).toEqual([]);
    expect(score().blobs).toHaveLength(1);
    await act(async () => { await documentEdits(context).redo(); });
    expect(score().project.score.backing?.assetId).toBe(session.project.score.backing?.assetId);
    expect(referencedBlobs(score())).toHaveLength(1);
  });

  it('adds, nudges and removes sync anchors with undo/redo, rejects a second anchor at the same place and blocks fixed BPM while synced', async () => {
    const { context, runtime, score } = await setup();
    fireEvent.click(screen.getByRole('button', { name: '파형 표시' }));
    await importWav(context, 16);
    const panel = () => within(screen.getByTestId('backing-panel'));
    fireEvent.click(panel().getByTestId('backing-add-sync'));
    await waitIdle(context);
    expect(score().project.score.backing?.syncPoints).toEqual([expect.objectContaining({ pass: 1, mediaSeconds: 0 })]);
    expect(screen.getByTestId('backing-panel').dataset['syncActive']).toBe('true');
    expect(screen.getByTestId('backing-sync-notice')).toBeTruthy();
    expect(() => runtime.transport.practice.configure({ mode: 'fixed', value: 100, trainer: null, audible: false, visual: false, countIn: false })).toThrow('반주 동기화');
    fireEvent.click(panel().getByTestId('backing-add-sync'));
    await waitIdle(context);
    await waitFor(() => expect(screen.getByTestId('backing-error').textContent).toContain('같은 악보 위치'));
    expect(score().project.score.backing?.syncPoints).toHaveLength(1);
    const marker = () => screen.getByRole('button', { name: /^동기점 1:/ });
    fireEvent.keyDown(marker(), { key: 'ArrowRight', shiftKey: true });
    await waitIdle(context);
    expect(score().project.score.backing?.syncPoints[0]?.mediaSeconds).toBe(0.5);
    expect(marker().dataset['media']).toBe('0.5');
    fireEvent.keyDown(marker(), { key: 'ArrowLeft' });
    await waitIdle(context);
    expect(score().project.score.backing?.syncPoints[0]?.mediaSeconds).toBe(0.45);
    await act(async () => { await documentEdits(context).undo(); });
    expect(score().project.score.backing?.syncPoints[0]?.mediaSeconds).toBe(0.5);
    await act(async () => { await documentEdits(context).undo(); });
    expect(score().project.score.backing?.syncPoints[0]?.mediaSeconds).toBe(0);
    await act(async () => { await documentEdits(context).redo(); });
    expect(score().project.score.backing?.syncPoints[0]?.mediaSeconds).toBe(0.5);
    fireEvent.click(screen.getByRole('switch', { name: '반주 동기화' }));
    expect(screen.getByTestId('backing-panel').dataset['syncActive']).toBe('false');
    expect(screen.queryByTestId('backing-sync-notice')).toBeNull();
    expect(score().project.score.backing?.syncPoints).toHaveLength(1);
    runtime.transport.practice.configure({ mode: 'fixed', value: 100, trainer: null, audible: false, visual: false, countIn: false });
    expect(runtime.transport.practice.getSnapshot().mode).toBe('fixed');
    fireEvent.keyDown(marker(), { key: 'Delete' });
    await waitIdle(context);
    expect(score().project.score.backing?.syncPoints).toEqual([]);
    expect(screen.queryByRole('button', { name: /^동기점 1:/ })).toBeNull();
  });

  it('reports a corrupt replacement file and keeps the existing asset, anchors and score untouched', async () => {
    const { context, score } = await setup();
    fireEvent.click(screen.getByRole('button', { name: '파형 표시' }));
    await importWav(context, 16);
    fireEvent.click(within(screen.getByTestId('backing-panel')).getByTestId('backing-add-sync'));
    await waitIdle(context);
    const before = JSON.stringify(score().project);
    const past = documentEdits(context).getSnapshot().past;
    await chooseFile('broken.wav', wavBytes(16).slice(0, 64));
    await waitIdle(context);
    await waitFor(() => expect(screen.getByTestId('backing-error').textContent).toContain('손상된 WAV'));
    expect(JSON.stringify(score().project)).toBe(before);
    expect(documentEdits(context).getSnapshot().past).toBe(past);
    expect(screen.getByTestId('backing-panel').dataset['asset']).toBe('ready');
    await chooseFile('notes.txt', new Uint8Array([1, 2, 3]));
    await waitFor(() => expect(screen.getByTestId('backing-error').textContent).toContain('지원하지 않는 오디오 형식'));
    expect(JSON.stringify(score().project)).toBe(before);
  });

  it('exposes gain and mute as session controls that never dirty the document', async () => {
    const { context, runtime, score } = await setup();
    fireEvent.click(screen.getByRole('button', { name: '파형 표시' }));
    await importWav(context, 4);
    const revision = score().revision;
    fireEvent.click(screen.getByRole('button', { name: '반주 음소거' }));
    expect(runtime.store.getSnapshot().mute).toBe(true);
    expect(context.registry.execute('backing.mute', 'editing')).toBe('executed');
    expect(runtime.store.getSnapshot().mute).toBe(false);
    expect(score().revision).toBe(revision);
    fireEvent.click(screen.getByRole('button', { name: '반주 패널 닫기' }));
    expect(screen.queryByTestId('backing-panel')).toBeNull();
    expect(screen.getByRole('button', { name: '파형 표시' }).getAttribute('aria-pressed')).toBe('false');
  });
});
