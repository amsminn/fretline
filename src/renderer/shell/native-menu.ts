import type { MenuBridge } from '../../preload';
import type { CommandContextSource } from '../commands/context-store';
import type { Platform } from '../commands/keymap';
import type { CommandRegistry } from '../commands/registry';

export type NativeMenuOptions = {
  readonly platform: Platform;
  readonly bridge: MenuBridge;
  readonly context: CommandContextSource;
  readonly onSyncError: (error: Error) => void;
};

/** Publishes changed handler availability; menu clicks come back as registry executions. */
export function bindNativeMenu(registry: CommandRegistry, options: NativeMenuOptions): () => void {
  registry.bindContext(options.context, options.platform);
  let context = options.context.getSnapshot();
  let previous: ReturnType<CommandRegistry['menuAvailability']> | undefined;
  const publish = (): void => {
    const nextContext = options.context.getSnapshot();
    const availability = registry.menuAvailability(nextContext);
    const unchanged = nextContext === context && previous?.length === availability.length &&
      previous.every((entry, index) => entry.id === availability[index]?.id && entry.enabled === availability[index]?.enabled);
    context = nextContext;
    if (unchanged) return;
    previous = availability;
    options.bridge.menuSync(availability).catch((error: unknown) => {
      if (error instanceof Error) options.onSyncError(error); else throw error;
    });
  };
  const unsubscribe = registry.subscribe(publish);
  const unsubscribeContext = options.context.subscribe(() => {
    if (options.context.getSnapshot() !== context) publish();
  });
  const release = options.bridge.onMenuCommand(commandId => { registry.execute(commandId); });
  publish();
  return () => { unsubscribe(); unsubscribeContext(); release(); };
}
