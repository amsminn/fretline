export const commandContexts = ['editing', 'playback', 'text-input', 'dialog'] as const;
export type CommandContext = typeof commandContexts[number];
export type ContextState = {
  readonly playing: boolean;
  readonly dialog: boolean;
  readonly target: unknown;
};

// Structural DOM access also accepts targets from another window's realm.
export function isTextTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null || !('nodeType' in target) || target.nodeType !== 1 ||
    !('closest' in target) || typeof target.closest !== 'function') return false;
  return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') !== null;
}

export function resolveContext(state: ContextState): CommandContext {
  if (state.dialog) return 'dialog';
  if (state.playing) return 'playback';
  return isTextTarget(state.target) ? 'text-input' : commandContexts[0];
}
