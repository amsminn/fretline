import { Circle, Search } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { toolsRuntime } from '../commands/tools';
import { useT } from '../i18n/react';
import { useCommands, useServices } from '../shell/services';
import { IconButton } from '../ui/IconButton';
import { commandIcons } from './icons';

export const instrumentViewsIds = ['tools.instrument', 'view.multitrack', 'tools.tuner', 'tools.commandPalette'] as const;
const localIcons = { 'tools.commandPalette': Search } as const;

/** Right-most toolbar group (UX02): instrument view, multitrack, tuner and command search; toggles show their open state. */
export function InstrumentViews() {
  const t = useT();
  const services = useServices();
  const runtime = toolsRuntime(services);
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const commands = useCommands('toolbar', instrumentViewsIds);
  if (commands.length === 0) return null;
  const pressed: Readonly<Record<string, boolean | undefined>> = { 'tools.instrument': state.instrument !== null, 'tools.tuner': state.tuner };
  return (
    <div role="group" aria-label={t('toolbar.slot.instrument')} data-slot-id={t('toolbar.slot.instrument')} className="flex items-center">
      {commands.map(command => {
        const Icon = command.id === 'tools.commandPalette' ? localIcons[command.id] : commandIcons[command.id] ?? Circle;
        const toggled = pressed[command.id];
        return <IconButton key={command.id} label={command.label} size={command.id === 'view.multitrack' ? 'toolbarCompact' : 'toolbar'}
          disabled={!command.enabled} data-command={command.id}
          {...(command.shortcut === undefined ? {} : { shortcut: command.shortcut })} {...(toggled === undefined ? {} : { 'aria-pressed': toggled })}
          onClick={() => { services.registry.execute(command.id); }}><Icon /></IconButton>;
      })}
    </div>
  );
}
