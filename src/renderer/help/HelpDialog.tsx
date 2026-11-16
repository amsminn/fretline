import { useEffect, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { commandDefinitions } from '../commands/catalog';
import type { MessageKey } from '../i18n';
import { useT } from '../i18n/react';
import type { CommandContext } from '../commands/contexts';
import { transportRuntime } from '../commands/transport';
import { cn } from '../lib/cn';
import { useRegistryVersion, useServices } from '../shell/services';
import { Button } from '../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { ScrollArea } from '../ui/ScrollArea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/Tabs';
import { Shortcut } from '../ui/Tooltip';
import { helpContent } from './content';
import type { CompatibilityStatus, HelpInline } from './content';
import { helpRuntime, helpSections } from './runtime';
import type { HelpSection } from './runtime';
import { shortcutGroups } from './shortcuts';

const sectionLabels: Readonly<Record<HelpSection, MessageKey>> = { guide: 'help.section.guide', shortcuts: 'help.section.shortcuts', compatibility: 'help.section.compatibility' };
const statusClass: Readonly<Record<CompatibilityStatus, string>> = {
  supported: 'text-success', unsupported: 'text-danger', unverified: 'text-warning', default: 'text-accent',
};
const catalogLabel = (id: string): string | undefined => commandDefinitions.find(definition => definition.id === id)?.label;
const isSection = (value: string): value is HelpSection => (helpSections as readonly string[]).includes(value);
const sectionViews: Readonly<Record<HelpSection, () => JSX.Element>> = { guide: Guide, shortcuts: Shortcuts, compatibility: Compatibility };

function CommandLink({ id, children }: { readonly id: string; readonly children?: string }) {
  const t = useT();
  const services = useServices();
  const { registry, platform } = services;
  const runtime = helpRuntime(services);
  useRegistryVersion(registry);
  const context: CommandContext = transportRuntime(services).transport.getSnapshot().status === 'playing' ? 'playback' : 'editing';
  const presented = registry.present('palette', { context, platform }).find(command => command.id === id);
  const label = children ?? catalogLabel(id) ?? id;
  return <Button variant="ghost" size="compact" data-help-command={id} disabled={!presented?.enabled}
    title={presented ? presented.enabled ? t('help.link.run', { label }) : t('help.link.unavailable', { label }) : t('help.link.missing', { label })}
    className="h-auto min-w-0 gap-1 px-1 py-0 align-baseline font-medium text-accent hover:text-accent-hover"
    onClick={() => runtime.run(id)}>
    {label}
    {presented?.shortcut && <Shortcut keys={presented.shortcut} className="ml-0" />}
  </Button>;
}

function Paragraph({ inlines }: { readonly inlines: readonly HelpInline[] }) {
  return <p className="text-xs leading-relaxed text-fg">
    {inlines.map((inline, index) => typeof inline === 'string' ? <span key={index}>{inline}</span> : <CommandLink key={index} id={inline.command} />)}
  </p>;
}

function Guide() {
  useT();
  const { intro, guideTopics } = helpContent();
  return <div className="flex flex-col gap-4" data-testid="help-guide">
    <p className="text-xs text-muted">{intro}</p>
    {guideTopics.map(topic => <section key={topic.id} id={`help-${topic.id}`} aria-labelledby={`help-${topic.id}-title`} className="flex flex-col gap-1.5">
      <h3 id={`help-${topic.id}-title`} className="text-sm font-semibold text-fg">{topic.title}</h3>
      {topic.paragraphs.map((paragraph, index) => <Paragraph key={index} inlines={paragraph} />)}
    </section>)}
  </div>;
}

function Shortcuts() {
  const t = useT();
  const { platform } = useServices();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const groups = shortcutGroups(platform).map(group => ({ ...group,
    rows: group.rows.filter(row => needle === '' || row.label.toLowerCase().includes(needle) || row.id.includes(needle) || row.keys.some(key => key.toLowerCase().includes(needle))) }))
    .filter(group => group.rows.length > 0);
  return <div className="flex flex-col gap-3" data-testid="help-shortcuts">
    <Input size="compact" aria-label={t('help.shortcuts.search')} placeholder={t('help.shortcuts.placeholder')} value={query} onChange={event => setQuery(event.currentTarget.value)} />
    <p className="text-2xs text-muted">{t('help.shortcuts.note')}</p>
    {groups.length === 0 && <p className="text-xs text-muted">{t('help.shortcuts.empty')}</p>}
    {groups.map(group => <section key={group.menu} aria-labelledby={`help-shortcuts-${group.menu}`} data-help-menu={group.menu}>
      <h3 id={`help-shortcuts-${group.menu}`} className="mb-1 text-sm font-semibold text-fg">{group.menuLabel}</h3>
      <table className="w-full border-collapse text-xs">
        <tbody>
          {group.rows.map(row => <tr key={row.id} data-help-shortcut={row.id} className="border-b border-border">
            <td className="py-0.5 pr-2"><CommandLink id={row.id}>{row.label}</CommandLink></td>
            <td className="py-0.5 text-right font-mono tabular-nums text-muted">{row.keys.length ? row.keys.join(' / ') : t('help.shortcuts.menuOnly')}</td>
          </tr>)}
        </tbody>
      </table>
    </section>)}
  </div>;
}

function Compatibility() {
  const t = useT();
  const { compatibilityGroups, statusLabels } = helpContent();
  return <div className="flex flex-col gap-4" data-testid="help-compatibility">
    <p className="text-xs text-muted">{t('help.compat.intro')}</p>
    {compatibilityGroups.map(group => <section key={group.id} aria-labelledby={`help-compat-${group.id}`} data-help-compat={group.id}>
      <h3 id={`help-compat-${group.id}`} className="mb-1 text-sm font-semibold text-fg">{group.title}</h3>
      <dl className="grid grid-cols-[minmax(8rem,auto)_4rem_1fr] gap-x-3 gap-y-1 text-xs">
        {group.rows.map(row => <div key={row.area} role="row" data-help-status={row.status} className="contents">
          <dt className="font-medium text-fg">{row.area}</dt>
          <dd className={cn('font-medium', statusClass[row.status])}>{statusLabels[row.status]}</dd>
          <dd className="text-fg"><Paragraph inlines={row.text} /></dd>
        </div>)}
      </dl>
    </section>)}
  </div>;
}

export function HelpDialog() {
  const t = useT();
  const services = useServices();
  const runtime = helpRuntime(services);
  const { section } = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useEffect(() => runtime.mount(), [runtime]);
  if (!section) return null;
  return <Dialog open onOpenChange={open => { if (!open) runtime.close(); }}>
    <DialogContent data-testid="help-dialog" data-section={section} className="h-[min(40rem,calc(100vh-2rem))] w-[44rem] gap-2">
      <DialogHeader>
        <DialogTitle>{t('help.title')}</DialogTitle>
        <DialogDescription>{t('help.description')}</DialogDescription>
      </DialogHeader>
      <Tabs value={section} onValueChange={value => { if (isSection(value)) runtime.open(value); }} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 bg-transparent">
          {helpSections.map(id => <TabsTrigger key={id} value={id} data-help-tab={id}>{t(sectionLabels[id])}</TabsTrigger>)}
        </TabsList>
        {helpSections.map(id => { const View = sectionViews[id]; return <TabsContent key={id} value={id} className="min-h-0 flex-1" asChild>
          <ScrollArea className="h-full pr-2 pt-3"><View /></ScrollArea>
        </TabsContent>; })}
      </Tabs>
    </DialogContent>
  </Dialog>;
}
