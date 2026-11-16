import type { PlaybackTransport, TransportState } from './transport';

/** React consumes at most one clock publication per display frame; cursor and audio retain the fine clock. */
export class DisplayTransport {
  private snapshot: TransportState;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private frame = 0;
  constructor(private readonly transport: PlaybackTransport) { this.snapshot = transport.getSnapshot(); }
  getSnapshot = (): TransportState => this.listeners.size ? this.snapshot : this.transport.getSnapshot();
  subscribe = (listener: () => void): (() => void) => {
    if (!this.listeners.size) {
      this.snapshot = this.transport.getSnapshot();
      this.unsubscribe = this.transport.subscribe(this.changed);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.unsubscribe?.(); this.unsubscribe = null;
        cancelAnimationFrame(this.frame); this.frame = 0;
      }
    };
  };
  private readonly publish = (): void => {
    this.frame = 0; this.snapshot = this.transport.getSnapshot();
    for (const listener of this.listeners) listener();
  };
  private readonly changed = (): void => {
    const next = this.transport.getSnapshot();
    if (next.status !== this.snapshot.status || next.revision !== this.snapshot.revision ||
      next.generation !== this.snapshot.generation || next.follow !== this.snapshot.follow ||
      next.error !== this.snapshot.error || next.buffering !== this.snapshot.buffering) {
      cancelAnimationFrame(this.frame); this.publish();
    } else if (!this.frame) this.frame = requestAnimationFrame(this.publish);
  };
}
