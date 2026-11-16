import type { BrowserWindow } from 'electron';

export type PlaybackThrottlingPort = {
  readonly setAllowed: (allowed: boolean) => void;
  readonly onDidFinishLoad: (listener: () => void) => void;
  readonly onRendererGone: (listener: () => void) => void;
  readonly onWindowClosed: (listener: () => void) => void;
};

export class PlaybackThrottlingOwner {
  private active = false;
  private allowed: boolean;
  constructor(private readonly port: PlaybackThrottlingPort, private readonly baseline: boolean) {
    this.allowed = baseline;
    port.onDidFinishLoad(this.restore);
    port.onRendererGone(this.restore);
    port.onWindowClosed(this.closed);
  }
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    const allowed = active ? false : this.baseline;
    if (allowed === this.allowed) return;
    this.allowed = allowed;
    this.port.setAllowed(allowed);
  }
  private readonly restore = (): void => { this.setActive(false); };
  private readonly closed = (): void => { this.active = false; this.allowed = this.baseline; };
}

const owners = new WeakMap<BrowserWindow, PlaybackThrottlingOwner>();
export function registerPlaybackThrottling(window: BrowserWindow): void {
  owners.set(window, new PlaybackThrottlingOwner({
    setAllowed: allowed => window.webContents.setBackgroundThrottling(allowed),
    onDidFinishLoad: listener => { window.webContents.on('did-finish-load', listener); },
    onRendererGone: listener => { window.webContents.on('render-process-gone', listener); },
    onWindowClosed: listener => { window.on('closed', listener); },
  }, window.webContents.getBackgroundThrottling()));
}
export function setWindowPlaybackActive(window: BrowserWindow, active: boolean): void {
  const owner = owners.get(window);
  if (!owner) throw new TypeError('Playback throttling owner is unavailable');
  owner.setActive(active);
}
