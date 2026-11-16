import type { Language, RendererSettings, SettingsPatch } from '../../main/settings';
import type { PreferencesBridge } from '../../preload';
import type { CommandRegistry } from '../commands/registry';
import type { PanelId, WorkspaceStore } from '../shell/workspace';
import type { DocumentStore } from '../state/documents';
import { getLanguage, setLanguage } from '../i18n/language';
import { shutdownFor } from '../state/shutdown';

export type PreferencesSnapshot = {
  readonly settings: RendererSettings | null;
  readonly open: boolean;
  readonly language: Language;
};
const panelIds: readonly PanelId[] = ['palette', 'inspector', 'globalView'];

/**
 * Mirrors the durable settings into the workspace at startup and writes workspace layout changes
 * back, debounced. Only theme, language, panel layout and the restore flag flow through here.
 */
export class PreferencesStore {
  private snapshot: PreferencesSnapshot = { settings: null, open: false, language: getLanguage() };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private applying = false;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly workspace: WorkspaceStore, private readonly documents: DocumentStore, private readonly bridge: PreferencesBridge) {}
  getSnapshot = (): PreferencesSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<PreferencesSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  private apply(settings: RendererSettings): void {
    this.applying = true;
    try {
      this.workspace.setTheme(settings.theme);
      for (const id of panelIds) {
        const current = this.workspace.getSnapshot().panels[id];
        if (current.visible !== settings.panels[id].visible) this.workspace.setPanelVisible(id, settings.panels[id].visible);
        if (current.size !== settings.panels[id].size) this.workspace.resizePanel(id, settings.panels[id].size);
      }
    } finally { this.applying = false; }
    document.documentElement.lang = settings.displayLanguage;
    setLanguage(settings.displayLanguage);
    this.publish({ settings, language: settings.displayLanguage });
  }
  private report(error: unknown): void {
    if (!(error instanceof Error)) throw error;
    this.documents.setError(error.message);
  }
  private layoutPatch(): SettingsPatch {
    const { theme, panels } = this.workspace.getSnapshot();
    return { theme, panels: { palette: { ...panels.palette }, inspector: { ...panels.inspector }, globalView: { ...panels.globalView } } };
  }
  private readonly workspaceChanged = (): void => {
    if (this.applying || !this.snapshot.settings) return;
    const stored = { theme: this.snapshot.settings.theme, panels: this.snapshot.settings.panels };
    if (JSON.stringify(this.layoutPatch()) === JSON.stringify(stored)) return;
    clearTimeout(this.timer);
    // The patch is computed when the timer fires, so an explicit write made meanwhile is never overwritten by a stale snapshot.
    this.timer = setTimeout(() => { this.timer = undefined; void this.write(() => this.layoutPatch()); }, 300);
  };
  private write(patch: () => SettingsPatch): Promise<void> {
    const operation = this.writes.then(async () => {
      try { this.apply(await this.bridge.set(patch())); } catch (error) { this.report(error); }
    });
    this.writes = operation;
    return operation;
  }
  set(patch: SettingsPatch): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    return this.write(() => ({ ...this.layoutPatch(), ...patch }));
  }
  openDialog(): void { this.publish({ open: true }); }
  closeDialog(): void { this.publish({ open: false }); }
  bind(registry: CommandRegistry): () => void {
    const release = registry.register('tools.preferences', { execute: () => this.openDialog() });
    const unsubscribe = this.workspace.subscribe(this.workspaceChanged);
    void this.bridge.get().then(settings => this.apply(settings), error => this.report(error));
    const unhook = shutdownFor(this.documents).beforeClose(() => this.flush());
    return () => { release(); unsubscribe(); unhook(); clearTimeout(this.timer); };
  }
  /** Writes a pending debounced layout patch now; awaited by the acknowledged shutdown path. */
  flush(): Promise<void> {
    if (this.timer === undefined) return this.writes;
    clearTimeout(this.timer); this.timer = undefined;
    return this.write(() => this.layoutPatch());
  }
}
