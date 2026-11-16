import { File, MoveHorizontal, Ruler } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { viewRuntime } from '../commands/view';
import { useT } from '../i18n/react';
import { useCommands, useDocuments, useServices } from '../shell/services';
import { ToggleButton } from '../ui/Toggle';
import { Tooltip } from '../ui/Tooltip';
import { CommandSlot } from './CommandButton';

export const zoomViewIds = ['view.zoomOut', 'view.zoomIn', 'view.page', 'view.horizontal', 'view.design'] as const;
const toggles = [
  { id: 'view.page', icon: File, pressed: (view: 'page' | 'horizontal', design: boolean): boolean => view === 'page' && !design },
  { id: 'view.horizontal', icon: MoveHorizontal, pressed: (view: 'page' | 'horizontal'): boolean => view === 'horizontal' },
  { id: 'view.design', icon: Ruler, pressed: (_view: 'page' | 'horizontal', design: boolean): boolean => design },
] as const;

export function ZoomView() {
  const t = useT();
  const services = useServices();
  const { active } = useDocuments();
  const runtime = viewRuntime(services);
  const { design } = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const commands = useCommands('toolbar', toggles.map(toggle => toggle.id));
  const view = active?.project.score.layout.view ?? 'page';
  return (
    <div role="group" aria-label={t('toolbar.slot.zoom')} data-slot-id={t('toolbar.slot.zoom')} className="flex items-center">
      <output aria-label={t('toolbar.zoomReadout')} data-testid="zoom-readout" className="min-w-10 px-1 text-center font-mono text-xs tabular-nums text-muted">
        {active ? `${Math.round(runtime.scale(active) * 100)}%` : '—'}
      </output>
      <CommandSlot slot={t('toolbar.slot.zoomCommands')} ids={['view.zoomOut', 'view.zoomIn']} />
      {commands.length > 0 && <div role="group" aria-label={t('toolbar.slot.viewMode')} data-slot-id={t('toolbar.slot.viewMode')} className="flex items-center">
        {toggles.flatMap(toggle => {
          const command = commands.find(candidate => candidate.id === toggle.id);
          if (!command) return [];
          const Icon = toggle.icon;
          return [<Tooltip key={toggle.id} content={command.label} {...(command.shortcut === undefined ? {} : { shortcut: command.shortcut })}>
            <ToggleButton size="toolbar" className="w-control-toolbar px-0" aria-label={command.label} data-command={command.id} disabled={!command.enabled}
              pressed={toggle.pressed(view, design)} onPressedChange={() => { services.registry.execute(command.id); }}>
              <Icon />
            </ToggleButton>
          </Tooltip>];
        })}
      </div>}
    </div>
  );
}
