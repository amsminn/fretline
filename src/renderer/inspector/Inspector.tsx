import { useSyncExternalStore } from 'react';
import { useT } from '../i18n/react';
import { useDocuments, useServices, useWorkspace } from '../shell/services';
import type { InspectorTab } from '../shell/workspace';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/Tabs';
import { inspectorRegistry } from './registry';
import type { InspectorRegistry } from './registry';

const tabs: readonly { readonly id: InspectorTab; readonly label: 'inspector.song' | 'inspector.track'; readonly shortcut: string }[] = [
  { id: 'song', label: 'inspector.song', shortcut: 'F5' }, { id: 'track', label: 'inspector.track', shortcut: 'F6' },
];

export function Inspector({ sections = inspectorRegistry }: { readonly sections?: InspectorRegistry }) {
  const t = useT();
  const { workspace } = useServices();
  const { inspectorTab, activeTrackIndex } = useWorkspace();
  const { active } = useDocuments();
  const list = useSyncExternalStore(sections.subscribe, sections.getSnapshot);
  const track = active?.project.score.tracks[Math.min(activeTrackIndex, (active?.project.score.tracks.length ?? 1) - 1)];
  return (
    <Tabs value={inspectorTab} onValueChange={value => { if (value === 'song' || value === 'track') workspace.setInspectorTab(value); }} className="flex h-full flex-col">
      <TabsList aria-label={t('inspector.tabs')} className="shrink-0">
        {tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id} data-inspector-tab={tab.id} title={`${t(tab.label)} (${tab.shortcut})`} className="flex-1 justify-center">{t(tab.label)}</TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => (
        <TabsContent key={tab.id} value={tab.id} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {!active && <p className="p-3 text-xs text-muted">{t('inspector.noDocument')}</p>}
          {active && list.filter(section => section.tab === tab.id).map(section => (
            <section key={section.id} aria-label={section.title} data-inspector-section={section.id} className="flex flex-col gap-2 border-b border-border p-3">
              <h3 className="text-2xs font-medium uppercase tracking-wide text-subtle">{section.title}</h3>
              <section.Component session={active} track={track} />
            </section>
          ))}
        </TabsContent>
      ))}
    </Tabs>
  );
}
