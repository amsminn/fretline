import { app, BrowserWindow, Menu } from 'electron';
import type { MenuItemConstructorOptions, WebContents } from 'electron';
import { commandDefinitions } from '../renderer/commands/catalog';
import { CommandRegistry } from '../renderer/commands/registry';
import type { CommandContext } from '../renderer/commands/contexts';
import { parseMenuAvailability } from './menu-sync';
import type { MenuAvailability } from './menu-sync';

export const menuCommandChannel = 'desktop:menu-command';
const knownCommands = new Set(commandDefinitions.map(definition => definition.id));
const availabilityBySender = new Map<number, MenuAvailability>();
const proxies = new Map<string, () => void>();
let installed: { readonly registry: CommandRegistry; readonly refresh: () => void } | undefined;

// Exported for feature composition; clicks and keyboard input share execute().
export function buildCommandMenu(registry: CommandRegistry, context: () => CommandContext = () => 'editing'): MenuItemConstructorOptions[] {
  return registry.menu({ context: context(), platform: process.platform === 'darwin' ? 'mac' : 'windows' })
    .map(group => ({
      id: group.id, label: group.label,
      submenu: group.commands.map(command => ({
        id: command.id, label: command.label, enabled: command.enabled,
        toolTip: command.tooltip,
        ...(command.owner === 4 && command.shortcut
          ? { accelerator: command.shortcut.replace('Meta+', 'Command+') } : {}),
        // Score accelerators are owned by renderer routing, which knows focus.
        // Native interception would bypass text-input/dialog isolation on macOS.
        click: () => { registry.execute(command.id, context()); },
      })),
    }));
}

const focusedContents = (): WebContents | undefined => (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents;

/**
 * Mirrors the focused renderer's handler availability as proxy handlers, so a menu item exists only
 * while the renderer can execute it; a click is sent back to the renderer, which applies its own context.
 */
function applyFocusedAvailability(registry: CommandRegistry): void {
  const contents = focusedContents();
  const availability = contents ? availabilityBySender.get(contents.id) ?? [] : [];
  const wanted = new Map(availability.map(entry => [entry.id, entry.enabled]));
  for (const [id, release] of proxies) if (!wanted.has(id)) { release(); proxies.delete(id); }
  for (const id of wanted.keys()) {
    if (proxies.has(id)) continue;
    proxies.set(id, registry.register(id, {
      execute: () => { focusedContents()?.send(menuCommandChannel, id); },
      enabled: () => {
        const current = focusedContents();
        return current ? availabilityBySender.get(current.id)?.some(entry => entry.id === id && entry.enabled) ?? false : false;
      },
    }));
  }
}

/** Rebuilds the native menu, e.g. after the UI language changed. */
export function refreshApplicationMenu(): void { installed?.refresh(); }

export function syncRendererCommands(sender: WebContents, input: unknown): void {
  const availability = parseMenuAvailability(input, knownCommands);
  if (!availabilityBySender.has(sender.id)) sender.once('destroyed', () => { availabilityBySender.delete(sender.id); installed?.refresh(); });
  availabilityBySender.set(sender.id, availability);
  installed?.refresh();
}

export function installApplicationMenu(): void {
  const registry = new CommandRegistry();
  registry.register('file.quit', { execute: () => app.quit() });
  registry.register('help.about', { execute: () => app.showAboutPanel() });
  registry.register('window.minimize', {
    execute: () => BrowserWindow.getFocusedWindow()?.minimize(),
    enabled: () => BrowserWindow.getFocusedWindow() !== null,
  });
  registry.register('window.fullscreen', {
    execute: () => {
      const window = BrowserWindow.getFocusedWindow();
      if (window) window.setFullScreen(!window.isFullScreen());
    },
    enabled: () => BrowserWindow.getFocusedWindow() !== null,
  });
  const refresh = (): void => {
    applyFocusedAvailability(registry);
    const template = buildCommandMenu(registry);
    if (process.platform === 'darwin') template.unshift({ role: 'appMenu' });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };
  installed = { registry, refresh };
  app.on('browser-window-focus', refresh);
  app.on('browser-window-blur', refresh);
  app.on('browser-window-created', refresh);
  refresh();
}
