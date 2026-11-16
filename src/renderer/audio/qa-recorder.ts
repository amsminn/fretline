import recorderUrl from './master-bus.ts?worker&url';
import type { PlaybackBeat } from '../../adapters/alphatab/linearize';
import type { NoteId, TrackId } from '../../domain/ids';
import type { QaEvidenceBridge } from '../../preload';
import type { MasterBus } from './master-bus';

export type AudioAttack = PlaybackBeat & {
  readonly noteIds: readonly NoteId[];
  readonly trackId: TrackId;
  readonly key: number;
  readonly tick: number;
  readonly audioTime: number;
  readonly revision: number;
};
type CaptureChunk = { readonly samples: Float32Array; readonly frame: number };
type CaptureMessage = CaptureChunk | { readonly flushed: true } | { readonly error: string };
export function pcm16Wave(chunks: readonly Float32Array[]): Uint8Array<ArrayBuffer> {
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string): void => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, 48_000, true); view.setUint32(28, 192_000, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) {
    view.setInt16(offset, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true); offset += 2;
  }
  return bytes;
}

/** Read-only tap after the limiter, available solely through main's gated QA capability. */
export class QaRecorder {
  private readonly attacks: AudioAttack[] = [];
  private readonly marks: { readonly name: string; readonly audioTime: number; readonly revision: number }[] = [];
  private resolveFlush: (() => void) | null = null;
  private count = 0;
  private startFrame: number | null = null;
  private pendingBytes = 0;
  private readonly queue: Uint8Array[] = [];
  private writing = false;
  private writes: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private destroyed = false;
  get frames(): number { return this.count / 2; }
  get attackCount(): number { return this.attacks.length; }
  get queuedBytes(): number { return this.pendingBytes; }
  get error(): string | null { return this.failure?.message ?? null; }
  private fail(error: unknown): void {
    if (this.failure || this.destroyed) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.queue.length = 0; this.pendingBytes = 0;
    this.resolveFlush?.(); this.resolveFlush = null;
    reportError(this.failure);
  }
  private async drain(): Promise<void> {
    this.writing = true;
    try {
      for (let bytes = this.queue.shift(); bytes; bytes = this.queue.shift()) {
        await this.bridge.writeEvidence('audio-append', bytes);
        if (this.destroyed || this.failure) return;
        this.pendingBytes -= bytes.length;
      }
    } catch (error) { this.fail(error); }
    finally { this.writing = false; }
  }
  private constructor(private readonly bus: MasterBus, private readonly node: AudioWorkletNode, private readonly bridge: QaEvidenceBridge) {
    node.port.onmessage = (event: MessageEvent<CaptureMessage>) => {
      if ('error' in event.data) { this.fail(new RangeError(event.data.error)); return; }
      if ('flushed' in event.data) { this.resolveFlush?.(); this.resolveFlush = null; return; }
      if (this.failure) return;
      if (!(event.data.samples instanceof Float32Array) || !Number.isSafeInteger(event.data.frame) ||
        event.data.frame < 0 || event.data.samples.length % 2) { this.fail(new TypeError('Invalid recorder chunk')); return; }
      this.startFrame ??= event.data.frame;
      if (event.data.frame !== this.startFrame + this.frames) {
        this.fail(new RangeError(`QA recording has a frame gap: expected ${this.startFrame + this.frames}, received ${event.data.frame}`)); return;
      }
      this.count += event.data.samples.length;
      if (this.count > 48_000 * 2 * 1200) { this.fail(new RangeError('QA recording exceeded 1200 seconds')); return; }
      const bytes = pcm16Wave([event.data.samples]).subarray(44);
      this.pendingBytes += bytes.length;
      if (this.pendingBytes > 8 * 1024 ** 2) { this.fail(new RangeError('QA disk writer exceeded its 8 MiB queue')); return; }
      this.queue.push(bytes);
      if (!this.writing) this.writes = this.drain();
    };
  }
  static async create(bus: MasterBus, bridge: Window['desktop']): Promise<QaRecorder | null> {
    if (!bridge.qa) return null;
    const closed = (): boolean => bus.context.state === 'closed';
    if (closed()) return null;
    await bus.context.audioWorklet.addModule(recorderUrl);
    if (closed()) return null;
    await bridge.qa.writeEvidence('audio-start', pcm16Wave([]));
    if (closed()) return null;
    // Root the tap in destination traversal instead of Chromium's best-effort
    // automatic-pull list. The processor never writes its zero-filled output.
    const node = new AudioWorkletNode(bus.context, 'fretline-master-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2,
    });
    const recorder = new QaRecorder(bus, node, bridge.qa);
    node.connect(bus.context.destination);
    bus.limiter.connect(node);
    return recorder;
  }
  attack(attack: AudioAttack): void {
    if (this.attacks.length >= 100_000) throw new RangeError('QA attack log exceeded its bound');
    this.attacks.push(attack);
  }
  mark(name: string, revision: number): void {
    if (this.marks.length >= 10_000) throw new RangeError('QA mark log exceeded its bound');
    this.marks.push({ name, revision, audioTime: this.bus.context.currentTime });
  }
  async save(): Promise<void> {
    if (this.destroyed) throw new Error('QA recorder is closed');
    if (this.failure) throw this.failure;
    await new Promise<void>(resolve => { this.resolveFlush = resolve; this.node.port.postMessage('flush'); });
    if (this.failure) throw this.failure;
    const startFrame = this.startFrame ?? 0;
    const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, this.count * 2, true);
    const metadata = new TextEncoder().encode(JSON.stringify({
      sampleRate: 48_000, channels: 2, startFrame, startTime: startFrame / 48_000,
      frames: this.count / 2, attacks: this.attacks, marks: this.marks,
    }, null, 2));
    await this.writes;
    if (this.destroyed) throw new Error('QA recorder closed during save');
    if (this.failure) throw this.failure;
    await this.bridge.writeEvidence('audio-finish', size);
    await this.bridge.writeEvidence('attacks', metadata);
  }
  destroy(): void {
    this.destroyed = true;
    this.queue.length = 0; this.pendingBytes = 0;
    this.bus.limiter.disconnect(this.node); this.node.disconnect();
    this.node.port.postMessage('destroy'); this.node.port.onmessage = null; this.node.port.close();
    this.attacks.length = 0; this.marks.length = 0; this.count = 0;
    this.resolveFlush?.(); this.resolveFlush = null;
  }
}
