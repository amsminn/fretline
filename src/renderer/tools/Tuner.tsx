import { Mic, MicOff, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useT } from '../i18n/react';
import { midiFrequency, noteName, toolsRuntime } from '../commands/tools';
import type { TunerReport } from '../commands/tools';
import { cn } from '../lib/cn';
import { useServices } from '../shell/services';
import { t } from '../i18n';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { NumberField } from '../ui/NumberField';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';

export type PitchReading = { readonly frequency: number; readonly midi: number; readonly name: string; readonly cents: number; readonly clarity: number };
export const silenceRms = 0.005;
const clarityThreshold = 0.9;

export function describePitch(frequency: number, reference = 440): Omit<PitchReading, 'clarity'> {
  const midi = Math.round(69 + 12 * Math.log2(frequency / reference));
  return { frequency, midi, name: noteName(midi), cents: 1200 * Math.log2(frequency / midiFrequency(midi, reference)) };
}

/**
 * McLeod normalized square difference (NSDF): the first key maximum above 90% of the global peak
 * is the fundamental; parabolic interpolation refines the lag to sub-sample precision.
 */
export function detectPitch(frame: Float32Array, sampleRate: number, reference = 440): PitchReading | null {
  const length = frame.length;
  let energy = 0;
  for (const sample of frame) energy += sample * sample;
  if (Math.sqrt(energy / length) < silenceRms) return null;
  const maxLag = Math.floor(length / 2);
  const nsdf = new Float32Array(maxLag);
  for (let lag = 0; lag < maxLag; lag++) {
    let acf = 0; let norm = 0;
    for (let i = 0; i < length - lag; i++) {
      const a = frame[i] ?? 0; const b = frame[i + lag] ?? 0;
      acf += a * b; norm += a * a + b * b;
    }
    nsdf[lag] = norm > 0 ? 2 * acf / norm : 0;
  }
  const peaks: { readonly lag: number; readonly value: number }[] = [];
  let lag = 1;
  while (lag < maxLag && (nsdf[lag] ?? 0) > 0) lag++;
  while (lag < maxLag) {
    while (lag < maxLag && (nsdf[lag] ?? 0) <= 0) lag++;
    let best = lag;
    while (lag < maxLag && (nsdf[lag] ?? 0) > 0) { if ((nsdf[lag] ?? 0) > (nsdf[best] ?? 0)) best = lag; lag++; }
    if (best < maxLag) peaks.push({ lag: best, value: nsdf[best] ?? 0 });
  }
  const highest = peaks.reduce((max, peak) => Math.max(max, peak.value), 0);
  const chosen = peaks.find(peak => peak.value >= clarityThreshold * highest);
  if (!chosen || chosen.value < clarityThreshold) return null;
  const left = nsdf[chosen.lag - 1] ?? chosen.value; const right = nsdf[chosen.lag + 1] ?? chosen.value;
  const denominator = left - 2 * chosen.value + right;
  const refined = chosen.lag + (denominator === 0 ? 0 : (left - right) / (2 * denominator));
  const frequency = sampleRate / refined;
  if (!Number.isFinite(frequency) || frequency < 20 || frequency > 5000) return null;
  return { ...describePitch(frequency, reference), clarity: chosen.value };
}

export type TunerSource = { readonly kind: 'microphone' | 'tone'; readonly node: AudioNode; readonly inputTracks: number; readonly stop: () => void };
export async function microphoneSource(context: AudioContext): Promise<TunerSource> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const node = context.createMediaStreamSource(stream);
  return { kind: 'microphone', node, inputTracks: stream.getAudioTracks().length,
    stop: () => { node.disconnect(); for (const track of stream.getTracks()) track.stop(); } };
}
/** QA/test input: a generated sine enters the same analyser the microphone would feed; it never reaches the output. */
export function toneSource(context: AudioContext, frequency: number): TunerSource {
  const oscillator = context.createOscillator();
  oscillator.frequency.value = frequency;
  const gain = context.createGain();
  gain.gain.value = 0.5;
  oscillator.connect(gain);
  oscillator.start();
  return { kind: 'tone', node: gain, inputTracks: 0, stop: () => { oscillator.stop(); oscillator.disconnect(); gain.disconnect(); } };
}

export class TunerEngine {
  private readonly analyser: AnalyserNode;
  private source: TunerSource | null = null;
  private readonly frame: Float32Array<ArrayBuffer>;
  constructor(private readonly context: AudioContext) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    this.frame = new Float32Array(this.analyser.fftSize);
  }
  get running(): boolean { return this.source !== null; }
  get inputTracks(): number { return this.source?.inputTracks ?? 0; }
  get sourceKind(): TunerSource['kind'] | null { return this.source?.kind ?? null; }
  async start(open: (context: AudioContext) => Promise<TunerSource> | TunerSource): Promise<void> {
    this.stop();
    await this.context.resume();
    const source = await open(this.context);
    source.node.connect(this.analyser);
    this.source = source;
  }
  stop(): void { this.source?.stop(); this.source = null; }
  read(reference: number): PitchReading | null {
    if (!this.source) return null;
    this.analyser.getFloatTimeDomainData(this.frame);
    return detectPitch(this.frame, this.context.sampleRate, reference);
  }
}

export const microphoneErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) throw error;
  switch (error.name) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError': return t('tools.tuner.denied');
    case 'NotFoundError': case 'OverconstrainedError': return t('tools.tuner.noMic');
    default: return t('tools.tuner.openFailed', { message: error.message });
  }
};

/** Explicit start/stop tuner (C4); closing the panel stops the input, so no microphone stays open unseen. */
export function Tuner() {
  useT();
  const services = useServices();
  const runtime = toolsRuntime(services);
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const engine = useRef<TunerEngine | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<PitchReading | null>(null);
  const [reference, setReference] = useState(440);
  const [source, setSource] = useState<TunerSource['kind']>('microphone');
  const [toneHz, setToneHz] = useState(440);
  const qa = window.desktop?.qa !== undefined;
  useEffect(() => runtime.mount(), [runtime]);
  useEffect(() => {
    const report: TunerReport = { running, source: engine.current?.sourceKind ?? null, inputTracks: engine.current?.inputTracks ?? 0,
      note: reading?.name ?? null, frequency: reading?.frequency ?? null, cents: reading?.cents ?? null, error };
    runtime.reportTuner(report);
  }, [runtime, running, reading, error]);
  useEffect(() => {
    if (!running) return;
    let handle = 0;
    const poll = (): void => { setReading(engine.current?.read(reference) ?? null); handle = requestAnimationFrame(poll); };
    handle = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(handle);
  }, [running, reference]);
  useEffect(() => () => { engine.current?.stop(); engine.current = null; }, []);
  if (!state.tuner) return null;
  const stop = (): void => { engine.current?.stop(); setRunning(false); setReading(null); };
  const start = async (): Promise<void> => {
    setError(null);
    engine.current ??= new TunerEngine(runtime.audio().context);
    try {
      await engine.current.start(context => source === 'tone' ? toneSource(context, toneHz) : microphoneSource(context));
      setRunning(true);
    } catch (failure) { setRunning(false); setError(microphoneErrorMessage(failure)); }
  };
  const close = (): void => { stop(); runtime.setTuner(false); };
  const cents = reading?.cents ?? 0;
  const inTune = reading !== null && Math.abs(cents) <= 5;
  return <section role="region" aria-label={t('tools.tuner.title')} data-testid="tuner" data-running={running} data-note={reading?.name ?? ''}
    data-cents={reading ? cents.toFixed(1) : ''} data-frequency={reading ? reading.frequency.toFixed(2) : ''}
    className="flex w-72 flex-col gap-3 rounded-lg border border-border bg-panel-raised p-3 text-fg shadow-popover">
    <header className="flex items-center gap-2">
      <h2 className="text-xs font-semibold">{t('tools.tuner.title')}</h2>
      <span className="text-2xs text-muted">{running ? t('tools.tuner.listening') : t('tools.tuner.stopped')}</span>
      <IconButton label={t('tools.tuner.close')} size="compact" className="ml-auto" onClick={close}><X /></IconButton>
    </header>
    <div className="flex flex-col items-center gap-1 rounded-md bg-lcd-bg px-3 py-2 font-mono text-lcd-fg">
      <span data-testid="tuner-note" className="text-xl font-semibold tabular-nums">{reading?.name ?? (running ? '—' : '')}</span>
      <span className="text-2xs tabular-nums">{reading ? `${reading.frequency.toFixed(2)} Hz · ${cents > 0 ? '+' : ''}${cents.toFixed(0)} cent` : running ? t('tools.tuner.noSignal') : `A4 = ${reference} Hz`}</span>
      <div role="meter" aria-label={t('tools.tuner.deviation')} aria-valuemin={-50} aria-valuemax={50} aria-valuenow={reading ? Math.round(cents) : 0}
        className="relative mt-1 h-2 w-full rounded-sm bg-app/60">
        <span className="absolute inset-y-0 left-1/2 w-px bg-lcd-fg/60" />
        {reading && <span className={cn('absolute inset-y-0 w-1 rounded-sm', inTune ? 'bg-success' : 'bg-warning')}
          style={{ left: `calc(${50 + Math.max(-50, Math.min(50, cents))}% - 2px)` }} />}
      </div>
    </div>
    {error && <p role="alert" className="text-2xs text-danger">{error}</p>}
    <div className="grid grid-cols-2 gap-2">
      <NumberField label={t('tools.tuner.reference')} value={reference} min={415} max={466} unit="Hz" disabled={running} onValueChange={setReference} />
      {qa && <Select value={source} onValueChange={value => { if (value === 'microphone' || value === 'tone') setSource(value); }} disabled={running}>
        <SelectTrigger size="compact" aria-label={t('tools.tuner.source')} data-testid="tuner-source"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="microphone">{t('tools.tuner.microphone')}</SelectItem><SelectItem value="tone">{t('tools.tuner.tone')}</SelectItem></SelectContent>
      </Select>}
      {qa && source === 'tone' && <NumberField label={t('tools.tuner.testHz')} value={toneHz} min={20} max={5000} step={0.01} unit="Hz" disabled={running} onValueChange={setToneHz} />}
    </div>
    <div className="flex justify-end gap-2">
      {running
        ? <Button variant="default" onClick={stop} data-testid="tuner-stop"><MicOff />{t('tools.tuner.stop')}</Button>
        : <Button variant="primary" onClick={() => void start()} data-testid="tuner-start"><Mic />{t('tools.tuner.start')}</Button>}
    </div>
  </section>;
}
