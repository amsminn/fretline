import { commandDefinitions } from '../commands/catalog';
import { paletteCellClass, paletteGridClass } from '../palette/EditingPalette';
import { paletteIcons } from '../palette/glyphs';
import { builtInPaletteSections } from '../palette/sections';
import { noteSection } from '../palette/sections/note';
import { rhythmSection } from '../palette/sections/rhythm';
import { IconButton, ToggleButton } from '../ui';

const commandLabels = new Map(commandDefinitions.map(definition => [definition.id, definition.label]));
const paletteSections = [...builtInPaletteSections, noteSection, rhythmSection].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, 'en'));
const label = (id: string): string => commandLabels.get(id) ?? id;

function PaletteGrid() {
  return (
    <div data-testid="specimen-palette" className="flex w-area-palette shrink-0 flex-col rounded-md border border-border bg-panel">
      <h3 className="flex h-7 items-center border-b border-border px-2 text-2xs font-medium text-muted">편집 팔레트</h3>
      {paletteSections.map(section => (
        <section key={section.id} aria-label={section.title} className="flex flex-col gap-1 border-b border-border px-2 py-1.5">
          <h4 className="text-2xs font-medium uppercase tracking-wide text-subtle">{section.title}</h4>
          <div className={paletteGridClass}>
            {section.commandIds.map((id, index) => {
              const Icon = paletteIcons[id];
              if (!Icon) return null;
              const last = index === section.commandIds.length - 1;
              return section.id === 'effects' && index === 0
                ? <ToggleButton key={id} size="default" className={paletteCellClass} aria-label={label(id)} pressed><Icon /></ToggleButton>
                : <IconButton key={id} label={label(id)} size="default" disabled={section.id === 'effects' && last}><Icon /></IconButton>;
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function PaletteSpecimen() {
  return (
    <div className="flex items-start gap-6">
      <PaletteGrid />
      <div className="grid grid-cols-5 gap-1">
        {Object.entries(paletteIcons).map(([id, Icon]) => (
          <div key={id} data-palette-icon={id} className="flex items-center gap-2 rounded-md border border-border bg-panel-raised px-2 py-1">
            <Icon className="size-icon-sm shrink-0" /><span className="truncate text-2xs text-muted">{label(id)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
