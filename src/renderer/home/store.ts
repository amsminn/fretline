import type { RecentFile } from '../../main/open';
import type { DesktopBridge } from '../../preload';
import { t } from '../i18n';
import type { CommandRegistry } from '../commands/registry';
import type { DocumentStore } from '../state/documents';
import { templateProject } from './templates';
import type { TemplateKind } from './templates';

export type HomeDialog = 'newScore' | 'recent' | null;
export type HomeSnapshot = {
  readonly recent: readonly RecentFile[];
  readonly dialog: HomeDialog;
  readonly busy: boolean;
};
export type HomeBridge = Pick<DesktopBridge, 'recentFiles' | 'recentForget' | 'recentPin' | 'openSelectedFile' | 'createProject' | 'readAsset'>;

export class HomeStore {
  private snapshot: HomeSnapshot = { recent: [], dialog: null, busy: false };
  private readonly listeners = new Set<() => void>();
  private untitled = 0;
  constructor(private readonly documents: DocumentStore, private readonly bridge: HomeBridge) {}
  getSnapshot = (): HomeSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<HomeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  private async guarded(operation: () => Promise<void>): Promise<void> {
    this.publish({ busy: true });
    try { await operation(); }
    catch (error) { if (error instanceof Error) this.documents.setError(error.message); else throw error; }
    finally { this.publish({ busy: false }); }
  }
  openDialog(dialog: Exclude<HomeDialog, null>): void { this.publish({ dialog }); if (dialog === 'recent') void this.refresh(); }
  closeDialog(): void { this.publish({ dialog: null }); }
  refresh(): Promise<void> { return this.guarded(async () => { this.publish({ recent: await this.bridge.recentFiles() }); }); }
  /** A vanished file reports through the document error line; open documents and their sessions are untouched. */
  open(token: string): Promise<void> {
    return this.guarded(async () => {
      await this.documents.open(await this.bridge.openSelectedFile(token), this.bridge);
      this.publish({ recent: await this.bridge.recentFiles(), dialog: null });
    });
  }
  pin(token: string, pinned: boolean): Promise<void> {
    return this.guarded(async () => { this.publish({ recent: await this.bridge.recentPin(token, pinned) }); });
  }
  forget(token: string): Promise<void> {
    return this.guarded(async () => { this.publish({ recent: await this.bridge.recentForget(token) }); });
  }
  create(kind: TemplateKind, title?: string): Promise<void> {
    return this.guarded(async () => {
      this.untitled++;
      await this.documents.create(templateProject(kind, title?.trim() || t('home.store.untitled', { index: this.untitled })), this.bridge);
      this.publish({ dialog: null });
    });
  }
  register(registry: CommandRegistry): () => void {
    const releases = [
      registry.register('file.new', { execute: () => this.openDialog('newScore') }),
      registry.register('file.templates', { execute: () => this.openDialog('newScore') }),
      registry.register('file.recent', { execute: () => this.openDialog('recent') }),
    ];
    return () => { for (const release of releases) release(); };
  }
}
