import type { PlaybackTransport } from '../audio/transport';
import type { CommandContext } from './contexts';
import { resolveContext } from './contexts';

export type CommandContextSource = {
  readonly getSnapshot: () => CommandContext;
  readonly subscribe: (listener: () => void) => () => void;
};

/** One observer per shell, shared by keyboard, command surfaces and the native menu. */
export class CommandContextStore implements CommandContextSource {
  private readonly listeners = new Set<() => void>();
  private release: (() => void) | undefined;
  private current: CommandContext;

  constructor(private readonly target: Document, private readonly transport: Pick<PlaybackTransport, 'getSnapshot' | 'subscribe'>) {
    this.current = this.getSnapshot();
  }

  // Read live DOM state as well: a command can arrive before the observer's microtask.
  getSnapshot = (): CommandContext => resolveContext({
    dialog: this.target.querySelector('[role="dialog"][data-state="open"], dialog[open], [role="alertdialog"][data-state="open"]') !== null,
    playing: this.transport.getSnapshot().status === 'playing',
    target: this.target.activeElement,
  });
  /** Render subscribers read the observed value; execution still checks live DOM above. */
  getRenderSnapshot = (): CommandContext => this.current;

  private refresh = (): void => {
    const next = this.getSnapshot();
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener();
  };

  // focusout fires before activeElement changes; focusin handles the new target immediately.
  private blur = (): void => { queueMicrotask(this.refresh); };

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) {
      this.current = this.getSnapshot();
      const observer = new MutationObserver(this.refresh);
      observer.observe(this.target.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['role', 'aria-modal', 'data-state', 'open', 'contenteditable'] });
      const unsubscribe = this.transport.subscribe(this.refresh);
      this.target.addEventListener('focusin', this.refresh);
      this.target.addEventListener('focusout', this.blur);
      this.release = () => {
        observer.disconnect(); unsubscribe();
        this.target.removeEventListener('focusin', this.refresh);
        this.target.removeEventListener('focusout', this.blur);
      };
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) { this.release?.(); this.release = undefined; }
    };
  };
}
