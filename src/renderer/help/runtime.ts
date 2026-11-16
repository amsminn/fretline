import { transportRuntime } from '../commands/transport';
import type { ShellServices } from '../shell/services';

export const helpSections = ['guide', 'shortcuts', 'compatibility'] as const;
export type HelpSection = typeof helpSections[number];
export type HelpState = { readonly section: HelpSection | null };
export const helpCommandIds: Readonly<Record<HelpSection, string>> = {
  guide: 'help.guide', shortcuts: 'help.shortcuts', compatibility: 'help.compatibility',
};
export type HelpObservation = HelpState & { readonly executed: readonly string[] };
declare global { interface Window { readonly fretlineHelpObservation?: () => HelpObservation } }

export class HelpRuntime {
  private state: HelpState = { section: null };
  private readonly listeners = new Set<() => void>();
  private readonly executed: string[] = [];
  private mounts = 0;
  private releases: readonly (() => void)[] = [];
  constructor(private readonly services: ShellServices) {}
  getSnapshot = (): HelpState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: HelpState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  open(section: HelpSection): void { this.publish({ section }); }
  close = (): void => { if (this.state.section !== null) this.publish({ section: null }); };
  /** The dialog is still mounted when a link runs, so the command takes the context that holds once it closes. */
  run(commandId: string): void {
    this.close();
    const playing = transportRuntime(this.services).transport.getSnapshot().status === 'playing';
    const result = this.services.registry.execute(commandId, playing ? 'playback' : 'editing');
    if (result === 'executed') this.executed.push(commandId);
  }
  mount(): () => void {
    this.mounts++;
    if (this.mounts === 1) {
      const { registry } = this.services;
      this.releases = helpSections.map(section => registry.register(helpCommandIds[section], { execute: () => this.open(section) }));
      if (window.desktop?.qa) Object.defineProperty(window, 'fretlineHelpObservation', { configurable: true,
        value: (): HelpObservation => ({ ...this.state, executed: [...this.executed] }) });
    }
    return () => {
      if (--this.mounts === 0) {
        for (const release of this.releases) release();
        this.releases = [];
        if (window.desktop?.qa) Reflect.deleteProperty(window, 'fretlineHelpObservation');
      }
    };
  }
}
const runtimes = new WeakMap<ShellServices, HelpRuntime>();
export function helpRuntime(services: ShellServices): HelpRuntime {
  const existing = runtimes.get(services);
  if (existing) return existing;
  const runtime = new HelpRuntime(services);
  runtimes.set(services, runtime);
  return runtime;
}
