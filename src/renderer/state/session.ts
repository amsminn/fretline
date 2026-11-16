import type { DocumentToken } from '../../domain/project';
import type { WrittenRange } from '../../domain/selection';
import type { DocumentStore } from './documents';
import type { MixerStore } from './mixer';

export type LoopSession = { enabled: boolean; range: WrittenRange | null; followRepeats: boolean };
export type DocumentSessionState = { readonly loop: Readonly<LoopSession>; readonly masterVolume: number };
export type SessionBindings = {
  readonly documents: DocumentStore;
  readonly loop: LoopSession;
  readonly mixer: MixerStore;
  readonly onRestored: () => void;
};
const restingLoop: Readonly<LoopSession> = { enabled: false, range: null, followRepeats: false };

/**
 * Loop and master mix are session state of one document (the selection is parked per document by
 * DocumentEdits, the single owner of selection history). Switching tabs parks the outgoing document's
 * state and restores the incoming one's, so a loop set on document A never applies to document B.
 * Nothing here is persisted; a restart begins every document at rest.
 */
export class DocumentSessions {
  private readonly parked = new Map<DocumentToken, DocumentSessionState>();
  private current: DocumentToken | null;
  private readonly unsubscribe: () => void;
  constructor(private readonly bindings: SessionBindings) {
    this.current = this.activeKey();
    this.syncMixer();
    this.unsubscribe = bindings.documents.subscribe(this.sync);
  }
  private activeKey(): DocumentToken | null {
    const active = this.bindings.documents.getSnapshot().active;
    return active ? this.bindings.documents.sessionToken(active.documentToken) : null;
  }
  private syncMixer(): void {
    const { active, sessions } = this.bindings.documents.getSnapshot();
    const open = new Set(sessions.map(session => this.bindings.documents.sessionToken(session.documentToken)));
    this.bindings.mixer.activateDocument(this.activeKey(), active?.project.score ?? null, open);
  }
  private capture(): DocumentSessionState {
    return { loop: { ...this.bindings.loop }, masterVolume: this.bindings.mixer.getSnapshot().master.volume };
  }
  private restore(state: DocumentSessionState | undefined): void {
    const { loop, mixer } = this.bindings;
    const next = state ?? { loop: restingLoop, masterVolume: mixer.getSnapshot().master.volume };
    loop.enabled = next.loop.enabled; loop.range = next.loop.range; loop.followRepeats = next.loop.followRepeats;
    mixer.setMasterVolume(next.masterVolume);
    this.bindings.onRestored();
  }
  private readonly sync = (): void => {
    const open = new Set(this.bindings.documents.getSnapshot().sessions.map(session => this.bindings.documents.sessionToken(session.documentToken)));
    for (const key of this.parked.keys()) if (!open.has(key)) this.parked.delete(key);
    const next = this.activeKey();
    this.syncMixer();
    if (next === this.current) return;
    if (this.current !== null && open.has(this.current)) this.parked.set(this.current, this.capture());
    this.current = next;
    this.restore(next === null ? undefined : this.parked.get(next));
  };
  state(token: DocumentToken): DocumentSessionState | undefined {
    const key = this.bindings.documents.sessionToken(token);
    return key === this.current ? this.capture() : this.parked.get(key);
  }
  destroy(): void { this.unsubscribe(); this.parked.clear(); }
}
