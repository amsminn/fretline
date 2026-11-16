import { Circle } from 'lucide-react';
import type { PresentedCommand } from '../commands/registry';
import { useCommands, useServices } from '../shell/services';
import { IconButton } from '../ui/IconButton';
import { commandIcons } from './icons';

export function CommandButton({ command, size = 'toolbar' }: { readonly command: PresentedCommand; readonly size?: 'toolbar' | 'default' | 'compact' }) {
  const { registry } = useServices();
  const Icon = commandIcons[command.id] ?? Circle;
  return (
    <IconButton label={command.label} size={size} disabled={!command.enabled} data-command={command.id}
      {...(command.shortcut === undefined ? {} : { shortcut: command.shortcut })}
      onClick={() => { registry.execute(command.id); }}>
      <Icon />
    </IconButton>
  );
}

/** A toolbar group renders only commands whose handlers exist; an empty group leaves no gap. */
export function CommandSlot({ ids, slot }: { readonly ids: readonly string[]; readonly slot: string }) {
  const commands = useCommands('toolbar', ids);
  if (commands.length === 0) return null;
  return (
    <div role="group" aria-label={slot} data-slot-id={slot} className="flex items-center">
      {commands.map(command => <CommandButton key={command.id} command={command} />)}
    </div>
  );
}
