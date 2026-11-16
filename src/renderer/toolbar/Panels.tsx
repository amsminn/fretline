import { PanelBottom, PanelLeft, PanelRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { MessageKey } from '../i18n';
import { useT } from '../i18n/react';
import { useServices, useWorkspace } from '../shell/services';
import type { PanelId } from '../shell/workspace';
import { ToggleButton } from '../ui/Toggle';
import { Tooltip } from '../ui/Tooltip';
import { CommandSlot } from './CommandButton';

export const panelToggles: readonly { readonly id: PanelId; readonly label: MessageKey; readonly shortcut: string; readonly icon: LucideIcon }[] = [
  { id: 'palette', label: 'toolbar.panel.palette', shortcut: 'F2', icon: PanelLeft },
  { id: 'globalView', label: 'prefs.panel.globalView', shortcut: 'F8', icon: PanelBottom },
  { id: 'inspector', label: 'toolbar.panel.inspector', shortcut: 'F5', icon: PanelRight },
];

export function Panels() {
  const t = useT();
  const { workspace } = useServices();
  const { panels } = useWorkspace();
  return (
    <>
      <CommandSlot slot={t('toolbar.slot.home')} ids={['file.templates']} />
      <div role="group" aria-label={t('toolbar.slot.panels')} data-slot-id={t('toolbar.slot.panels')} className="flex items-center">
        {panelToggles.map(({ id, label, shortcut, icon: Icon }) => (
          <Tooltip key={id} content={t(label)} shortcut={shortcut}>
            <ToggleButton size="toolbar" className="w-control-toolbar px-0" aria-label={t(label)} data-panel-toggle={id} pressed={panels[id].visible}
              onPressedChange={visible => workspace.setPanelVisible(id, visible)}>
              <Icon />
            </ToggleButton>
          </Tooltip>
        ))}
      </div>
    </>
  );
}
