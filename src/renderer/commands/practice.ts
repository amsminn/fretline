import { Practice } from '../audio/practice';
import type { PracticeSettings, PracticeState, PracticeEvent } from '../audio/practice';
import type { TransportRuntime } from './transport';

declare global {
  interface Window {
    readonly fretlinePracticeObservation?: () => { readonly state: PracticeState; readonly events: readonly PracticeEvent[] };
  }
}
export function createPractice(): Practice {
  const events: PracticeEvent[] = [];
  const practice = new Practice(window.desktop?.qa ? event => {
    events.push(event); if (events.length > 10000) events.shift();
  } : undefined);
  if (window.desktop?.qa) Object.defineProperty(window, 'fretlinePracticeObservation', { configurable: true,
    value: () => ({ state: practice.getSnapshot(), events: [...events] }) });
  return practice;
}

export function applyPractice(runtime: TransportRuntime, settings: PracticeSettings): void {
  runtime.practice.configure(settings);
  runtime.loop.rate = runtime.practice.tempo().rate;
  runtime.transport.refreshTempo();
  runtime.services.registry.changed();
}

export function bindPractice(runtime: TransportRuntime, open: () => void): () => void {
  const { registry, documents } = runtime.services;
  const nudge = (direction: -1 | 1): void => {
    runtime.practice.nudge(direction);
    runtime.loop.rate = runtime.practice.tempo().rate;
    runtime.transport.refreshTempo();
    registry.changed();
  };
  const toggle = (field: 'audible' | 'countIn'): void => {
    const state = runtime.practice.getSnapshot();
    runtime.practice.setClicks({ audible: state.audible, visual: state.visual, countIn: state.countIn, [field]: !state[field] });
    runtime.transport.refreshTempo();
  };
  const actions = {
    'practice.relativeSpeed': open,
    'practice.fixedBpm': open,
    'practice.trainer': open,
    'practice.metronome': () => toggle('audible'),
    'practice.countIn': () => toggle('countIn'),
    'sound.speedUp': () => nudge(1),
    'sound.speedDown': () => nudge(-1),
  };
  const dispose = Object.entries(actions).map(([id, execute]) => registry.register(id, {
    execute, enabled: () => documents.getSnapshot().active !== null,
  }));
  dispose.push(runtime.practice.subscribe(() => {
    const state = runtime.practice.getSnapshot();
    runtime.loop.rate = state.mode === 'relative' ? state.value / 100 : 1;
    registry.changed();
  }));
  return () => { for (const unregister of dispose) unregister(); };
}
