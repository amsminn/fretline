import { Environment } from '@coderline/alphatab';
import { Drum, FolderOpen, Guitar, Settings } from 'lucide-react';
import type { ComponentType } from 'react';
import { useEffect, useSyncExternalStore } from 'react';
import { cn } from '../lib/cn';
import { t } from '../i18n';
import { useLanguage } from '../i18n/react';
import { useCommands, useServices } from '../shell/services';
import type { ShellServices } from '../shell/services';
import { Button } from '../ui/Button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Dialog';
import { focusRing } from '../ui/control';
import { templateLabel, NewScoreDialog } from './NewScoreDialog';
import { RecentDocuments } from './RecentDocuments';
import { HomeStore } from './store';
import type { HomeBridge } from './store';
import { templates } from './templates';
import type { TemplateKind } from './templates';

const stores = new WeakMap<ShellServices, HomeStore>();
export function homeStore(services: ShellServices, bridge: HomeBridge): HomeStore {
  const existing = stores.get(services);
  if (existing) return existing;
  const store = new HomeStore(services.documents, bridge);
  stores.set(services, store);
  return store;
}
const BassIcon = ({ className }: { readonly className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M4 20a4 4 0 0 1 2-7c2 0 3-1 3-3V5" /><path d="M9 5h4" /><path d="M4 20l3-3" /><circle cx="4" cy="20" r="1" />
  </svg>
);
const icons: Readonly<Record<TemplateKind, ComponentType<{ readonly className?: string }>>> = { guitar: Guitar, bass: BassIcon, drums: Drum };

export function useHome(bridge: HomeBridge) {
  const services = useServices();
  const store = homeStore(services, bridge);
  return { store, snapshot: useSyncExternalStore(store.subscribe, store.getSnapshot), language: useLanguage() };
}

/** Dialog host and command registration; mounted whenever a bridge exists, with or without open documents. */
export function HomeHost({ bridge }: { readonly bridge: HomeBridge }) {
  const { registry } = useServices();
  const { store, snapshot } = useHome(bridge);
  useEffect(() => store.register(registry), [store, registry]);
  useEffect(() => { void store.refresh(); }, [store]);
  switch (snapshot.dialog) {
    case null: return null;
    case 'newScore': return <NewScoreDialog store={store} busy={snapshot.busy} />;
    case 'recent': return (
      <Dialog open onOpenChange={open => { if (!open) store.closeDialog(); }}>
        <DialogContent data-testid="recent-dialog">
          <DialogHeader><DialogTitle>{t('home.recent')}</DialogTitle></DialogHeader>
          <RecentDocuments store={store} recent={snapshot.recent} busy={snapshot.busy} />
        </DialogContent>
      </Dialog>);
    default: { const exhaustive: never = snapshot.dialog; return exhaustive; }
  }
}

export function Home({ bridge }: { readonly bridge: HomeBridge }) {
  const { registry } = useServices();
  const { store, snapshot } = useHome(bridge);
  const open = useCommands('toolbar', ['file.open']).at(0);
  const preferences = useCommands('toolbar', ['tools.preferences']).at(0);
  useEffect(() => { void store.refresh(); }, [store]);
  return (
    <div data-testid="home" className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-app text-fg">
      <div className="mx-auto grid w-full max-w-4xl grid-cols-[18rem_minmax(0,1fr)] gap-10 px-8 py-10">
        <section aria-labelledby="home-new" className="flex flex-col gap-3">
          <h2 id="home-new" className="text-base font-semibold">{t('home.new')}</h2>
          <div className="flex flex-col gap-2" data-testid="home-templates">
            {templates.map((template, index) => {
              const Icon = icons[template.kind];
              return <button key={template.kind} type="button" data-template={template.kind} disabled={snapshot.busy}
                onClick={() => { void store.create(template.kind); }}
                className={cn('flex h-14 items-center gap-3 rounded-lg border px-3 text-left transition-colors outline-none', focusRing,
                  'disabled:pointer-events-none disabled:opacity-(--disabled-opacity)',
                  index === 0 ? 'border-accent bg-accent text-on-accent hover:bg-accent-hover hover:border-accent-hover active:bg-accent-active'
                    : 'border-border bg-panel-raised hover:bg-hover active:bg-pressed')}>
                <Icon className="size-icon-md shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t(templateLabel(template.kind))}</span>
                  <span className={cn('block truncate text-2xs', index === 0 ? 'text-on-accent' : 'text-muted')}>{t(`home.template.${template.kind}.detail`)}</span>
                </span>
              </button>;
            })}
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {open && <Button variant="ghost" className="justify-start gap-2 px-2" disabled={!open.enabled} data-command="file.open" title={open.tooltip}
              onClick={() => { registry.execute('file.open'); }}><FolderOpen className="size-icon-sm" />{t('home.open')}</Button>}
            {preferences && <Button variant="ghost" className="justify-start gap-2 px-2" disabled={!preferences.enabled} data-command="tools.preferences" title={preferences.tooltip}
              onClick={() => { registry.execute('tools.preferences'); }}><Settings className="size-icon-sm" />{t('home.preferences')}</Button>}
          </div>
          <p className="mt-auto pt-6 text-2xs text-subtle">{Environment.isViteBundled ? t('home.engine.bundled') : t('home.engine.missing')} · {location.origin}</p>
        </section>
        <section aria-labelledby="home-recent" className="flex min-w-0 flex-col gap-3">
          <h2 id="home-recent" className="text-base font-semibold">{t('home.recent')}</h2>
          <RecentDocuments store={store} recent={snapshot.recent} busy={snapshot.busy} />
        </section>
      </div>
    </div>
  );
}
