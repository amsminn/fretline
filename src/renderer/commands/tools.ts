import { MasterBus } from '../audio/master-bus';
import type { ShellServices } from '../shell/services';

export type InstrumentKind = 'fretboard' | 'piano';
export type ChordScaleKind = 'chord' | 'scale';
/** A scale shown on the instrument view; it is a practice aid and never part of the document. */
export type ScaleDisplay = { readonly name: string; readonly root: number; readonly intervals: readonly number[] };
export type ToolsState = {
  readonly instrument: InstrumentKind | null;
  readonly tuner: boolean;
  readonly dialog: ChordScaleKind | null;
  readonly palette: boolean;
  readonly scale: ScaleDisplay | null;
};
export type Audition = { readonly midi: number; readonly audioTime: number };
export type TunerReport = {
  readonly running: boolean;
  readonly source: 'microphone' | 'tone' | null;
  readonly inputTracks: number;
  readonly note: string | null;
  readonly frequency: number | null;
  readonly cents: number | null;
  readonly error: string | null;
};
export type ToolsObservation = ToolsState & {
  readonly auditions: readonly Audition[];
  readonly outputPeak: number;
  readonly tunerReport: TunerReport;
};
declare global { interface Window { readonly fretlineToolsObservation?: () => ToolsObservation } }

export const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export const noteName = (midi: number): string => `${noteNames[((midi % 12) + 12) % 12] ?? ''}${Math.floor(midi / 12) - 1}`;
export const midiFrequency = (midi: number, reference = 440): number => reference * 2 ** ((midi - 69) / 12);

const idleTuner: TunerReport = { running: false, source: null, inputTracks: 0, note: null, frequency: null, cents: null, error: null };

/**
 * Practice tools: instrument views, tuner, chord/scale tool and the command palette (UX20).
 * One lazily created bus serves click audition and the tuner analyser; it is released on unmount.
 */
export class ToolsRuntime {
  private state: ToolsState = { instrument: null, tuner: false, dialog: null, palette: false, scale: null };
  private readonly listeners = new Set<() => void>();
  private mounts = 0;
  private releases: readonly (() => void)[] = [];
  private bus: MasterBus | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly auditions: Audition[] = [];
  private tunerReport: TunerReport = idleTuner;
  constructor(private readonly services: ShellServices) {}
  getSnapshot = (): ToolsState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ToolsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    this.services.registry.changed();
  }
  setInstrument(instrument: InstrumentKind | null): void { if (instrument !== this.state.instrument) this.publish({ instrument }); }
  setTuner(tuner: boolean): void { if (tuner !== this.state.tuner) this.publish({ tuner }); }
  openDialog(dialog: ChordScaleKind): void { this.publish({ dialog }); }
  closeDialog = (): void => { this.publish({ dialog: null }); };
  setPalette(palette: boolean): void { if (palette !== this.state.palette) this.publish({ palette }); }
  /** A scale display implies the fretboard is visible, otherwise the choice would be invisible. */
  setScale(scale: ScaleDisplay | null): void { this.publish({ scale, instrument: scale && !this.state.instrument ? 'fretboard' : this.state.instrument }); }
  reportTuner(report: TunerReport): void { this.tunerReport = report; }

  /** Shared WebAudio graph for audition and the tuner; QA renders it on Chromium's silent sink. */
  audio(): MasterBus {
    if (!this.bus) {
      this.bus = new MasterBus();
      this.analyser = this.bus.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.bus.limiter.connect(this.analyser);
    }
    return this.bus;
  }
  private outputPeak(): number {
    if (!this.analyser) return 0;
    const frame = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(frame);
    return frame.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
  }
  /** Plucked-string audition: a decaying sawtooth through a closing low-pass, real sound on the shared bus. */
  audition(midi: number): void {
    const bus = this.audio();
    const { context } = bus;
    void context.resume();
    const at = context.currentTime + 0.005;
    const oscillator = context.createOscillator();
    oscillator.type = 'sawtooth';
    oscillator.frequency.value = midiFrequency(midi);
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass'; filter.Q.value = 0.5;
    filter.frequency.setValueAtTime(Math.min(12_000, oscillator.frequency.value * 8), at);
    filter.frequency.exponentialRampToValueAtTime(Math.max(200, oscillator.frequency.value * 1.5), at + 1.2);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(0.4, at + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.001, at + 1.4);
    oscillator.connect(filter); filter.connect(envelope); envelope.connect(bus.input);
    oscillator.start(at); oscillator.stop(at + 1.45);
    oscillator.onended = () => { oscillator.disconnect(); filter.disconnect(); envelope.disconnect(); };
    this.auditions.push({ midi, audioTime: at });
    if (this.auditions.length > 1000) this.auditions.shift();
  }
  private releaseAudio(): void {
    this.analyser?.disconnect(); this.analyser = null;
    void this.bus?.destroy(); this.bus = null;
  }
  mount(): () => void {
    this.mounts++;
    if (this.mounts === 1) {
      const { registry, documents } = this.services;
      const open = () => documents.getSnapshot().active !== null;
      const editable = () => documents.getSnapshot().active?.editable === true;
      const handlers: Readonly<Record<string, { readonly execute: () => void; readonly enabled: () => boolean }>> = {
        'tools.instrument': { enabled: open, execute: () => this.setInstrument(this.state.instrument ? null : 'fretboard') },
        'tools.tuner': { enabled: () => true, execute: () => this.setTuner(!this.state.tuner) },
        'tools.chord': { enabled: editable, execute: () => this.openDialog('chord') },
        'tools.scale': { enabled: open, execute: () => this.openDialog('scale') },
        'tools.commandPalette': { enabled: () => true, execute: () => this.setPalette(true) },
      };
      const releases = Object.entries(handlers).map(([id, handler]) => registry.register(id, handler));
      releases.push(documents.subscribe(() => {
        registry.changed();
        if (!documents.getSnapshot().active) this.publish({ instrument: null, dialog: null, scale: null });
      }));
      this.releases = releases;
      if (window.desktop?.qa) Object.defineProperty(window, 'fretlineToolsObservation', { configurable: true, value: (): ToolsObservation =>
        ({ ...this.state, auditions: [...this.auditions], outputPeak: this.outputPeak(), tunerReport: this.tunerReport }) });
    }
    return () => {
      if (--this.mounts === 0) {
        for (const release of this.releases) release();
        this.releases = [];
        this.releaseAudio();
        if (window.desktop?.qa) Reflect.deleteProperty(window, 'fretlineToolsObservation');
      }
    };
  }
}
const runtimes = new WeakMap<ShellServices, ToolsRuntime>();
export function toolsRuntime(services: ShellServices): ToolsRuntime {
  const existing = runtimes.get(services);
  if (existing) return existing;
  const runtime = new ToolsRuntime(services);
  runtimes.set(services, runtime);
  return runtime;
}
