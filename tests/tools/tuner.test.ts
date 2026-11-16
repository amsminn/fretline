import { describe, expect, it } from 'vitest';
import { TunerEngine, describePitch, detectPitch, microphoneErrorMessage, silenceRms } from '../../src/renderer/tools/Tuner';
import type { TunerSource } from '../../src/renderer/tools/Tuner';

const sampleRate = 48_000;
const frameSize = 4096;
const sine = (frequency: number, amplitude = 0.5, phase = 0.3): Float32Array =>
  Float32Array.from({ length: frameSize }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate + phase));
const sawtooth = (frequency: number): Float32Array =>
  Float32Array.from({ length: frameSize }, (_, i) => 0.4 * (2 * ((i * frequency / sampleRate) % 1) - 1));

describe('detectPitch', () => {
  it('detects a generated A4 sine within a cent', () => {
    const reading = detectPitch(sine(440), sampleRate);
    expect(reading).not.toBeNull();
    expect(reading?.name).toBe('A4');
    expect(Math.abs((reading?.frequency ?? 0) - 440)).toBeLessThan(0.3);
    expect(Math.abs(reading?.cents ?? 99)).toBeLessThan(1);
  });
  it('detects low E2 (82.41 Hz) without an octave error', () => {
    const reading = detectPitch(sine(82.41), sampleRate);
    expect(reading?.name).toBe('E2');
    expect(Math.abs((reading?.frequency ?? 0) - 82.41)).toBeLessThan(0.3);
  });
  it('follows the fundamental of a harmonic-rich pluck and reports the detuning in cents', () => {
    const reading = detectPitch(sawtooth(113), sampleRate);
    expect(reading?.name).toBe('A2');
    expect(reading?.cents ?? 0).toBeGreaterThan(40);
    expect(reading?.cents ?? 0).toBeLessThan(52);
  });
  it('returns null for silence and for sub-threshold noise', () => {
    expect(detectPitch(new Float32Array(frameSize), sampleRate)).toBeNull();
    const noise = Float32Array.from({ length: frameSize }, (_, i) => (silenceRms / 4) * Math.sin(i * 12.9898) );
    expect(detectPitch(noise, sampleRate)).toBeNull();
  });
  it('uses the chosen reference pitch', () => {
    expect(describePitch(442, 442)).toMatchObject({ midi: 69, name: 'A4', cents: 0 });
    expect(Math.round(describePitch(440, 442).cents)).toBe(-8);
  });
});

class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  frame: Float32Array = new Float32Array(0);
  readonly inputs: unknown[] = [];
  getFloatTimeDomainData(target: Float32Array): void { target.set(this.frame.subarray(0, target.length)); }
}
class FakeContext {
  readonly sampleRate = sampleRate;
  resumed = 0;
  readonly analyser = new FakeAnalyser();
  createAnalyser(): FakeAnalyser { return this.analyser; }
  async resume(): Promise<void> { this.resumed++; }
}
const fakeSource = (analyser: FakeAnalyser, frame: Float32Array): TunerSource & { stopped: number } => {
  const source = { kind: 'tone' as const, inputTracks: 1, stopped: 0,
    node: { connect: (target: unknown) => { analyser.inputs.push(target); analyser.frame = frame; } } as unknown as AudioNode,
    stop: () => { source.stopped++; analyser.frame = new Float32Array(0); } };
  return source;
};

describe('TunerEngine', () => {
  it('reads pitch only while a source is connected to its analyser and stops the source exactly once', async () => {
    const context = new FakeContext();
    const engine = new TunerEngine(context as unknown as AudioContext);
    expect(engine.read(440)).toBeNull();
    const source = fakeSource(context.analyser, sine(440));
    await engine.start(() => source);
    expect(context.resumed).toBe(1);
    expect(context.analyser.fftSize).toBe(4096);
    expect(context.analyser.inputs).toEqual([context.analyser]);
    expect(engine.running).toBe(true);
    expect(engine.read(440)?.name).toBe('A4');
    engine.stop();
    expect(source.stopped).toBe(1);
    expect(engine.running).toBe(false);
    expect(engine.read(440)).toBeNull();
    engine.stop();
    expect(source.stopped).toBe(1);
  });
  it('replaces a running source when started again', async () => {
    const context = new FakeContext();
    const engine = new TunerEngine(context as unknown as AudioContext);
    const first = fakeSource(context.analyser, sine(440));
    await engine.start(() => first);
    const second = fakeSource(context.analyser, sine(82.41));
    await engine.start(() => second);
    expect(first.stopped).toBe(1);
    expect(engine.read(440)?.name).toBe('E2');
  });
  it('maps a denied microphone to a permission message and rethrows non-errors', () => {
    const denied = new DOMException('Permission denied', 'NotAllowedError');
    expect(microphoneErrorMessage(denied)).toContain('마이크 권한이 거부');
    expect(microphoneErrorMessage(new DOMException('x', 'NotFoundError'))).toContain('마이크가 없습니다');
    expect(() => microphoneErrorMessage('boom')).toThrow('boom');
  });
});
