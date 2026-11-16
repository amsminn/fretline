export type PanelId = 'palette' | 'inspector' | 'globalView';
export type InspectorTab = 'song' | 'track';
export type Theme = 'dark' | 'light';
export type PanelState = { readonly visible: boolean; readonly size: number };
export type WorkspaceState = {
  readonly panels: Readonly<Record<PanelId, PanelState>>;
  readonly inspectorTab: InspectorTab;
  readonly activeTrackIndex: number;
  readonly theme: Theme;
};
export const panelLimits: Readonly<Record<PanelId, { readonly min: number; readonly max: number; readonly initial: number }>> = {
  palette: { min: 160, max: 420, initial: 220 },
  inspector: { min: 200, max: 480, initial: 260 },
  globalView: { min: 96, max: 420, initial: 190 },
};
const clamp = (id: PanelId, size: number): number => Math.min(panelLimits[id].max, Math.max(panelLimits[id].min, Math.round(size)));

export class WorkspaceStore {
  private snapshot: WorkspaceState = {
    panels: {
      palette: { visible: true, size: panelLimits.palette.initial },
      inspector: { visible: true, size: panelLimits.inspector.initial },
      globalView: { visible: true, size: panelLimits.globalView.initial },
    },
    inspectorTab: 'song', activeTrackIndex: 0, theme: 'dark',
  };
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): WorkspaceState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<WorkspaceState>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  private patchPanel(id: PanelId, patch: Partial<PanelState>): void {
    this.publish({ panels: { ...this.snapshot.panels, [id]: { ...this.snapshot.panels[id], ...patch } } });
  }
  setPanelVisible(id: PanelId, visible: boolean): void { this.patchPanel(id, { visible }); }
  togglePanel(id: PanelId): void { this.patchPanel(id, { visible: !this.snapshot.panels[id].visible }); }
  resizePanel(id: PanelId, size: number): void { this.patchPanel(id, { size: clamp(id, size) }); }
  /** F5/F6: a second press on the already shown tab hides the inspector. */
  showInspector(tab: InspectorTab): void {
    const { visible } = this.snapshot.panels.inspector;
    if (visible && this.snapshot.inspectorTab === tab) { this.patchPanel('inspector', { visible: false }); return; }
    this.publish({ inspectorTab: tab, panels: { ...this.snapshot.panels, inspector: { ...this.snapshot.panels.inspector, visible: true } } });
  }
  setInspectorTab(tab: InspectorTab): void { this.publish({ inspectorTab: tab }); }
  setActiveTrack(index: number): void { this.publish({ activeTrackIndex: Math.max(0, index) }); }
  setTheme(theme: Theme): void { this.publish({ theme }); }
}
export const workspaceStore = new WorkspaceStore();
