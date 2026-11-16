import { Circle, Search } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useT } from '../i18n/react';
import type { KeyboardEvent } from 'react';
import { menuLabel, menus } from '../commands/catalog';
import type { CommandContext } from '../commands/contexts';
import type { PresentedCommand } from '../commands/registry';
import { toolsRuntime } from '../commands/tools';
import { transportRuntime } from '../commands/transport';
import { cn } from '../lib/cn';
import { commandIcons } from '../toolbar/icons';
import { useRegistryVersion, useServices } from '../shell/services';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Shortcut } from '../ui/Tooltip';

export const paletteCommandId = 'tools.commandPalette';
export const maxResults = 40;
const menuLabels: ReadonlyMap<string, string> = new Map(menus);

/** Rank: label prefix, then label substring, then menu or id match; every id appears once. */
export function searchCommands(commands: readonly PresentedCommand[], query: string): readonly PresentedCommand[] {
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const scored: { readonly command: PresentedCommand; readonly score: number }[] = [];
  for (const command of commands) {
    if (command.id === paletteCommandId || seen.has(command.id)) continue;
    seen.add(command.id);
    const label = command.label.toLowerCase();
    const menu = menuLabel(command.menu, menuLabels.get(command.menu) ?? command.menu).toLowerCase();
    const score = needle === '' ? 1 : label.startsWith(needle) ? 3 : label.includes(needle) ? 2
      : menu.includes(needle) || command.id.toLowerCase().includes(needle) || (command.shortcut ?? '').toLowerCase().includes(needle) ? 1 : 0;
    if (score > 0) scored.push({ command, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, maxResults).map(entry => entry.command);
}

/** Cmd/Ctrl+E command search (UX20): the same registry decides availability, action and the shown shortcut. */
export function CommandPalette() {
  const t = useT();
  const services = useServices();
  const { registry } = services;
  const runtime = toolsRuntime(services);
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useRegistryVersion(registry);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  useEffect(() => runtime.mount(), [runtime]);
  useEffect(() => { if (state.palette) { setQuery(''); setHighlighted(0); } }, [state.palette]);
  // The open palette is itself a dialog; commands are presented and run in the context that holds once it closes.
  const context: CommandContext = transportRuntime(services).transport.getSnapshot().status === 'playing' ? 'playback' : 'editing';
  const results = searchCommands(registry.present('palette', { context }), query);
  if (!state.palette) return null;
  const close = (): void => runtime.setPalette(false);
  const run = (command: PresentedCommand | undefined): void => {
    if (!command?.enabled) return;
    close();
    registry.execute(command.id, context);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); setHighlighted(index => Math.min(results.length - 1, index + 1)); break;
      case 'ArrowUp': event.preventDefault(); setHighlighted(index => Math.max(0, index - 1)); break;
      case 'Enter': event.preventDefault(); run(results[highlighted]); break;
      default: break;
    }
  };
  const current = Math.min(highlighted, Math.max(0, results.length - 1));
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent data-testid="command-palette" className="top-24 w-[32rem] -translate-y-0 gap-2 p-2">
      <DialogTitle className="sr-only">{t('tools.palette.title')}</DialogTitle>
      <DialogDescription className="sr-only">{t('tools.palette.description')}</DialogDescription>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-icon-sm -translate-y-1/2 text-subtle" />
        <Input autoFocus role="combobox" aria-label={t('tools.palette.search')} aria-expanded aria-controls="command-palette-results"
          aria-activedescendant={results[current] ? `command-palette-${results[current].id}` : undefined}
          placeholder={t('tools.palette.search')} value={query} className="pl-7" onKeyDown={onKeyDown}
          onChange={event => { setQuery(event.currentTarget.value); setHighlighted(0); }} />
      </div>
      <ul id="command-palette-results" role="listbox" aria-label={t('tools.palette.list')} data-testid="command-palette-results" className="max-h-80 overflow-y-auto">
        {results.length === 0 && <li className="px-2 py-3 text-center text-xs text-muted">{t('tools.palette.empty')}</li>}
        {results.map((command, index) => { const Icon = commandIcons[command.id] ?? Circle; return <li key={command.id} id={`command-palette-${command.id}`} role="option" aria-selected={index === current}
          aria-disabled={!command.enabled} data-command={command.id}
          className={cn('flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs', index === current ? 'bg-hover text-fg' : 'text-fg',
            !command.enabled && 'opacity-(--disabled-opacity)')}
          onMouseEnter={() => setHighlighted(index)} onClick={() => run(command)}>
          <Icon className="size-icon-sm shrink-0 text-muted" />
          <span className="truncate">{command.label}</span>
          <span className="text-2xs text-subtle">{menuLabel(command.menu, menuLabels.get(command.menu) ?? command.menu)}</span>
          {command.shortcut && <Shortcut keys={command.shortcut} className="ml-auto" />}
        </li>; })}
      </ul>
    </DialogContent>
  </Dialog>;
}
