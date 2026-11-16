import { useEffect, useSyncExternalStore } from 'react';
import type { LanguageSetting, Theme } from '../../main/settings';
import type { DesktopBridge } from '../../preload';
import { useServices } from '../shell/services';
import type { ShellServices } from '../shell/services';
import type { PanelId } from '../shell/workspace';
import { Checkbox } from '../ui/Checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { Switch } from '../ui/Switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/Tabs';
import { t } from '../i18n';
import { useLanguage } from '../i18n/react';
import { PreferencesStore } from './store';
import type { PreferencesSnapshot } from './store';

const stores = new WeakMap<ShellServices, PreferencesStore>();
const resting: PreferencesSnapshot = { settings: null, open: false, language: 'ko' };
const restingStore = { subscribe: (): (() => void) => () => {}, getSnapshot: (): PreferencesSnapshot => resting };
export function preferencesStore(services: ShellServices, bridge: DesktopBridge | null): PreferencesStore | undefined {
  const existing = stores.get(services);
  if (existing || !bridge) return existing;
  const store = new PreferencesStore(services.workspace, services.documents, bridge.preferences);
  stores.set(services, store);
  return store;
}

const isTheme = (value: string): value is Theme => value === 'dark' || value === 'light';
const isLanguage = (value: string): value is LanguageSetting => value === 'system' || value === 'ko' || value === 'en';
const panelIds: readonly PanelId[] = ['palette', 'inspector', 'globalView'];

export function Preferences({ bridge }: { readonly bridge: DesktopBridge }) {
  const services = useServices();
  const store = preferencesStore(services, bridge) ?? restingStore;
  const { settings, open } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useLanguage();
  useEffect(() => store instanceof PreferencesStore ? store.bind(services.registry) : undefined, [store, services.registry]);
  if (!open || !settings || !(store instanceof PreferencesStore)) return null;
  return (
    <Dialog open onOpenChange={next => { if (!next) store.closeDialog(); }}>
      <DialogContent data-testid="preferences-dialog" className="w-[32rem]">
        <DialogHeader>
          <DialogTitle>{t('prefs.title')}</DialogTitle>
          <DialogDescription>{t('prefs.description')}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="general">
          <TabsList className="bg-transparent px-0">
            <TabsTrigger value="general">{t('prefs.general')}</TabsTrigger>
            <TabsTrigger value="window">{t('prefs.window')}</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="flex flex-col gap-3 pt-3">
            <label className="flex items-center justify-between gap-3 text-xs">{t('prefs.theme')}
              <Select value={settings.theme} onValueChange={value => { if (isTheme(value)) void store.set({ theme: value }); }}>
                <SelectTrigger aria-label={t('prefs.theme')} data-testid="theme-select" className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">{t('prefs.theme.dark')}</SelectItem>
                  <SelectItem value="light">{t('prefs.theme.light')}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center justify-between gap-3 text-xs">{t('prefs.language')}
              <Select value={settings.language} onValueChange={value => { if (isLanguage(value)) void store.set({ language: value }); }}>
                <SelectTrigger aria-label={t('prefs.language')} data-testid="language-select" className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">{t('prefs.language.system')}</SelectItem>
                  <SelectItem value="ko">{t('prefs.language.ko')}</SelectItem>
                  <SelectItem value="en">{t('prefs.language.en')}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </TabsContent>
          <TabsContent value="window" className="flex flex-col gap-3 pt-3">
            <label className="flex items-center justify-between gap-3 text-xs">{t('prefs.restoreWindow')}
              <Switch checked={settings.restoreWindow} data-testid="restore-window" onCheckedChange={checked => { void store.set({ restoreWindow: checked }); }} />
            </label>
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-1 text-xs text-muted">{t('prefs.panels')}</legend>
              {panelIds.map(id => <label key={id} className="flex items-center gap-2 text-xs">
                <Checkbox checked={settings.panels[id].visible} data-panel={id}
                  onCheckedChange={checked => { void store.set({ panels: { ...settings.panels, [id]: { ...settings.panels[id], visible: checked === true } } }); }} />
                {t(`prefs.panel.${id}`)}
              </label>)}
            </fieldset>
          </TabsContent>
        </Tabs>
        <p className="text-2xs text-subtle">{t('prefs.saved')}</p>
      </DialogContent>
    </Dialog>
  );
}
