import { Circle } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { PresentedCommand } from '../commands/registry';
import { selectionStore } from '../editor/selection-state';
import { useT } from '../i18n/react';
import { useCommands, useDocuments, useServices } from '../shell/services';
import { commandIcons } from '../toolbar/icons';
import { IconButton } from '../ui/IconButton';
import { ScrollArea } from '../ui/ScrollArea';
import { ToggleButton } from '../ui/Toggle';
import { Tooltip } from '../ui/Tooltip';
import { activePaletteCommands, toggleCommandIds } from './active';
import { paletteRegistry } from './registry';
import type { PaletteRegistry, PaletteSection } from './registry';

export const paletteGridClass = 'grid grid-cols-7 gap-0.5';
// Tooltip.Trigger overwrites the toggle's data-state with its own open/closed state, so the on-state is styled from aria-pressed.
export const paletteCellClass = 'size-control-default px-0 aria-pressed:border-border aria-pressed:bg-pressed aria-pressed:text-accent-hover';

function useActiveCommands(): ReadonlySet<string> {
  const documents = useDocuments();
  const { selection } = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
  const score = documents.active?.project.score;
  return score ? activePaletteCommands(score, selection) : new Set();
}

function PaletteCell({ command, pressed }: { readonly command: PresentedCommand; readonly pressed: boolean | undefined }) {
  const { registry } = useServices();
  const Icon = commandIcons[command.id] ?? Circle;
  const shortcut = command.shortcut === undefined ? {} : { shortcut: command.shortcut };
  const execute = (): void => { registry.execute(command.id); };
  if (pressed === undefined) {
    return <IconButton label={command.label} size="default" disabled={!command.enabled} data-command={command.id} {...shortcut} onClick={execute}><Icon /></IconButton>;
  }
  return (
    <Tooltip content={command.label} {...shortcut}>
      <ToggleButton size="default" className={paletteCellClass} aria-label={command.label} pressed={pressed} disabled={!command.enabled}
        data-command={command.id} onPressedChange={execute}><Icon /></ToggleButton>
    </Tooltip>
  );
}

function Section({ section, active }: { readonly section: PaletteSection; readonly active: ReadonlySet<string> }) {
  useT();
  const commands = useCommands('palette', section.commandIds);
  if (commands.length === 0) return null;
  return (
    <section aria-label={section.title} data-palette-section={section.id} className="flex flex-col gap-1 border-b border-border px-2 py-1.5">
      <h3 className="truncate text-2xs font-medium uppercase tracking-wide text-subtle">{section.title}</h3>
      <div className={paletteGridClass}>
        {commands.map(command => (
          <PaletteCell key={command.id} command={command} pressed={toggleCommandIds.has(command.id) ? active.has(command.id) : undefined} />
        ))}
      </div>
    </section>
  );
}

export function EditingPalette({ sections = paletteRegistry }: { readonly sections?: PaletteRegistry }) {
  const t = useT();
  const list = useSyncExternalStore(sections.subscribe, sections.getSnapshot);
  const active = useActiveCommands();
  return (
    <div className="flex h-full flex-col">
      <h2 className="flex h-7 shrink-0 items-center border-b border-border px-2 text-2xs font-medium text-muted">{t('palette.title')}</h2>
      <ScrollArea className="flex-1" tabIndex={-1}>
        {list.map(section => <Section key={section.id} section={section} active={active} />)}
      </ScrollArea>
    </div>
  );
}
