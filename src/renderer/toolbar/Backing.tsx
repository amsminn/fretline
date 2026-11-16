import { useSyncExternalStore } from 'react';
import { backingStore } from '../backing/store';
import { useT } from '../i18n/react';
import { useCommands, useServices } from '../shell/services';
import { CommandButton } from './CommandButton';
import { IconButton } from '../ui/IconButton';
import { commandIcons } from './icons';
import { Link2, Link2Off } from 'lucide-react';

export const backingIds = ['backing.import', 'backing.waveform', 'backing.sync'] as const;

/** UX02 backing group: import, waveform toggle and sync toggle show their pressed state from the session store. */
export function Backing() {
  const t = useT();
  const services = useServices();
  const store = backingStore(services);
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const commands = useCommands('toolbar', backingIds);
  if (commands.length === 0) return null;
  const WaveformIcon = commandIcons['backing.waveform'];
  return (
    <div role="group" aria-label={t('toolbar.slot.backing')} data-slot-id={t('toolbar.slot.backing')} className="flex items-center">
      {commands.map(command => {
        switch (command.id) {
          case 'backing.waveform': return (
            <IconButton key={command.id} label={command.label} size="toolbar" disabled={!command.enabled} data-command={command.id}
              variant={session.waveform ? 'primary' : 'ghost'} aria-pressed={session.waveform}
              {...(command.shortcut === undefined ? {} : { shortcut: command.shortcut })}
              onClick={() => { services.registry.execute(command.id); }}>{WaveformIcon ? <WaveformIcon /> : null}</IconButton>
          );
          case 'backing.sync': return (
            <IconButton key={command.id} label={command.label} size="toolbar" disabled={!command.enabled} data-command={command.id}
              variant={session.syncEnabled && command.enabled ? 'primary' : 'ghost'} aria-pressed={session.syncEnabled}
              {...(command.shortcut === undefined ? {} : { shortcut: command.shortcut })}
              onClick={() => { services.registry.execute(command.id); }}>{session.syncEnabled ? <Link2 /> : <Link2Off />}</IconButton>
          );
          default: return <CommandButton key={command.id} command={command} />;
        }
      })}
    </div>
  );
}
