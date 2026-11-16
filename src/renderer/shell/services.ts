import { currentPlatform } from '../lib/shortcut-format';
import { createContext, useContext, useSyncExternalStore } from 'react';
import { subscribeLanguage } from '../i18n/language';
import { CommandRegistry } from '../commands/registry';
import { CommandContextStore } from '../commands/context-store';
import { transportRuntime } from '../commands/transport';
import type { PresentedCommand, Surface } from '../commands/registry';
import type { Platform } from '../commands/keymap';
import { documentStore } from '../state/documents';
import type { DocumentStore } from '../state/documents';
import { mixerStore } from '../state/mixer';
import type { MixerStore } from '../state/mixer';
import { globalViewStore } from '../global-view/store';
import type { GlobalViewStore } from '../global-view/store';
import { workspaceStore } from './workspace';
import type { WorkspaceStore } from './workspace';

export type ShellServices = {
  readonly registry: CommandRegistry;
  readonly platform: Platform;
  readonly documents: DocumentStore;
  readonly workspace: WorkspaceStore;
  readonly mixer: MixerStore;
  readonly globalView: GlobalViewStore;
};
export const detectPlatform = currentPlatform;
export const shellRegistry = new CommandRegistry();
export const productionServices: ShellServices = {
  registry: shellRegistry, platform: detectPlatform(navigator.platform),
  documents: documentStore, workspace: workspaceStore, mixer: mixerStore, globalView: globalViewStore,
};
export const ServicesContext = createContext<ShellServices>(productionServices);
const contexts = new WeakMap<ShellServices, CommandContextStore>();
export function commandContextStore(services: ShellServices): CommandContextStore {
  const existing = contexts.get(services);
  if (existing) return existing;
  const store = new CommandContextStore(document, transportRuntime(services).transport);
  contexts.set(services, store);
  services.registry.bindContext(store, services.platform);
  return store;
}
export const useServices = (): ShellServices => {
  const services = useContext(ServicesContext);
  commandContextStore(services);
  return services;
};

type RegistryVersion = { value: number; readonly subscribe: (listener: () => void) => () => void };
const versions = new WeakMap<CommandRegistry, RegistryVersion>();
// CommandRegistry.subscribe is a prototype method; useSyncExternalStore needs a stable bound function.
function version(registry: CommandRegistry): RegistryVersion {
  let counter = versions.get(registry);
  if (!counter) {
    const created: RegistryVersion = { value: 0, subscribe: listener => {
      const release = registry.subscribe(listener);
      const releaseLanguage = subscribeLanguage(listener);
      return () => { release(); releaseLanguage(); };
    } };
    registry.subscribe(() => { created.value++; });
    subscribeLanguage(() => { created.value++; });
    versions.set(registry, created);
    counter = created;
  }
  return counter;
}
/** Re-renders the caller whenever handler availability changes; read `registry.present(...)` afterwards. */
export function useRegistryVersion(registry: CommandRegistry): number {
  const counter = version(registry);
  return useSyncExternalStore(counter.subscribe, () => counter.value);
}
export function useCommands(surface: Surface, ids: readonly string[]): readonly PresentedCommand[] {
  const services = useServices();
  const { registry } = services;
  const context = commandContextStore(services);
  const commandContext = useSyncExternalStore(context.subscribe, context.getRenderSnapshot);
  useRegistryVersion(registry);
  const presented = registry.present(surface, { context: commandContext });
  return ids.flatMap(id => presented.filter(command => command.id === id));
}
export function useDocuments() {
  const { documents } = useServices();
  return useSyncExternalStore(documents.subscribe, documents.getSnapshot);
}
export function useWorkspace() {
  const { workspace } = useServices();
  return useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
}
export function useMixer() {
  const { mixer } = useServices();
  return useSyncExternalStore(mixer.subscribe, mixer.getSnapshot);
}
export function useGlobalView() {
  const { globalView } = useServices();
  return useSyncExternalStore(globalView.subscribe, globalView.getSnapshot);
}
