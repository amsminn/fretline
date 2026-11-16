import { commandDefinitions, menuLabel, menus } from './catalog';
import type { CommandDefinition } from './catalog';
import type { CommandContext, ContextState } from './contexts';
import { isTextTarget, resolveContext } from './contexts';
import type { CommandContextSource } from './context-store';
import { normalizeKey, normalizeShortcut } from './keymap';
import type { KeyInput, Platform } from './keymap';
import { getLanguage } from '../i18n/language';

export type Execution = 'executed' | 'pending' | 'disabled' | 'context-blocked' | 'unmatched';
export type CommandHandler = {
  readonly execute: () => void;
  readonly enabled?: () => boolean;
};
export class CommandContractError extends Error {
  constructor(readonly commandId: string, readonly reason: 'duplicate' | 'unknown' | 'conflict') {
    super(`${reason}: ${commandId}`);
    this.name = 'CommandContractError';
  }
}
export type Surface = CommandDefinition['surfaces'][number];
export type PresentedCommand = CommandDefinition & {
  readonly enabled: boolean;
  readonly shortcut: string | undefined;
  readonly tooltip: string;
};

export class CommandRegistry {
  private readonly definitions = new Map<string, CommandDefinition>();
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly listeners = new Set<() => void>();
  private readonly localized = new Map<string, CommandDefinition>();
  private language = getLanguage();
  private context: CommandContextSource | undefined;
  private platform: Platform = 'mac';

  bindContext(context: CommandContextSource, platform: Platform): void {
    this.context = context;
    this.platform = platform;
  }

  getContext(): CommandContext { return this.context?.getSnapshot() ?? 'editing'; }

  constructor(definitions: readonly CommandDefinition[] = commandDefinitions) {
    const occupied = new Map<string, string>();
    for (const definition of definitions) {
      if (this.definitions.has(definition.id)) throw new CommandContractError(definition.id, 'duplicate');
      this.definitions.set(definition.id, definition);
      for (const platform of ['mac', 'windows'] as const) {
        for (const context of definition.contexts) {
          for (const key of new Set(definition.keys[platform].map(normalizeShortcut))) {
            const slot = `${platform}/${context}/${key}`;
            if (occupied.has(slot)) throw new CommandContractError(definition.id, 'conflict');
            occupied.set(slot, definition.id);
          }
        }
      }
    }
  }

  register(id: string, handler: CommandHandler): () => void {
    if (!this.definitions.has(id)) throw new CommandContractError(id, 'unknown');
    if (this.handlers.has(id)) throw new CommandContractError(id, 'duplicate');
    this.handlers.set(id, handler);
    this.changed();
    return () => { this.handlers.delete(id); this.changed(); };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // Feature state changes call this to refresh availability in every surface.
  changed(): void { for (const listener of this.listeners) listener(); }

  status(id: string, context: CommandContext): Exclude<Execution, 'executed' | 'unmatched'> | 'ready' {
    const definition = this.definitions.get(id);
    const handler = this.handlers.get(id);
    if (!definition || !handler) return 'pending';
    if (!definition.contexts.includes(context)) return 'context-blocked';
    return handler.enabled && !handler.enabled() ? 'disabled' : 'ready';
  }

  execute(id: string, context: CommandContext = this.getContext()): Execution {
    const status = this.status(id, context);
    if (status !== 'ready') return status;
    this.handlers.get(id)?.execute();
    return 'executed';
  }

  route(event: KeyInput, state: { readonly platform: Platform } & Partial<ContextState>): Execution {
    const key = normalizeKey(event);
    if (!key || isTextTarget(state.target)) return 'unmatched';
    const context = state.playing === undefined ? this.getContext()
      : resolveContext({ playing: state.playing, dialog: state.dialog ?? false, target: state.target });
    const definition = [...this.definitions.values()].find(candidate =>
      candidate.contexts.includes(context) && candidate.keys[state.platform].some(binding => normalizeShortcut(binding) === key));
    if (!definition) return 'unmatched';
    return this.execute(definition.id, context);
  }

  present(surface: Surface, state: { readonly context?: CommandContext; readonly platform?: Platform } = {}): readonly PresentedCommand[] {
    const context = state.context ?? this.getContext();
    const language = getLanguage();
    if (language !== this.language) { this.language = language; this.localized.clear(); }
    return [...this.definitions.values()]
      .filter(definition => this.handlers.has(definition.id) && definition.surfaces.includes(surface))
      .map(definition => {
        let resolved = this.localized.get(definition.id);
        if (!resolved) {
          resolved = { ...definition };
          this.localized.set(definition.id, resolved);
        }
        const shortcut = resolved.keys[state.platform ?? this.platform][0];
        return { ...resolved, enabled: this.status(definition.id, context) === 'ready',
          shortcut, tooltip: shortcut ? `${resolved.label} (${shortcut})` : resolved.label };
      });
  }

  menuAvailability(context: CommandContext = this.getContext()): readonly { readonly id: string; readonly enabled: boolean }[] {
    return [...this.definitions.values()]
      .filter(definition => this.handlers.has(definition.id) && definition.surfaces.includes('menu'))
      .map(definition => ({ id: definition.id, enabled: this.status(definition.id, context) === 'ready' }));
  }

  menu(state: { readonly context?: CommandContext; readonly platform?: Platform } = {}) {
    const commands = this.present('menu', state);
    return menus.map(([id, korean]) => ({ id, label: menuLabel(id, korean), commands: commands.filter(command => command.menu === id) }));
  }
}

// One DOM listener routes every feature through the same context and availability checks.
export function bindCommandKeys(registry: CommandRegistry, options: {
  readonly target: Document;
  readonly platform: Platform;
  readonly state?: () => Pick<ContextState, 'playing' | 'dialog'>;
}): () => void {
  const listener = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const result = registry.route(event, { ...options.state?.(), target: event.target, platform: options.platform });
    if (result === 'executed') event.preventDefault();
  };
  options.target.addEventListener('keydown', listener);
  return () => options.target.removeEventListener('keydown', listener);
}
