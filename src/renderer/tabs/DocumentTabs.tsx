import { Plus, Save, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { DocumentSession } from '../state/documents';
import { t } from '../i18n';
import { useT } from '../i18n/react';
import { useCommands, useDocuments, useServices } from '../shell/services';
import { cn } from '../lib/cn';
import { IconButton } from '../ui/IconButton';

export const sessionTitle = (session: DocumentSession): string =>
  session.fileName ?? (session.project.score.metadata.title || session.project.source?.name || t('tabs.untitled'));

function Tab({ session, active }: { readonly session: DocumentSession; readonly active: boolean }) {
  const t = useT();
  const { documents, registry } = useServices();
  const [save, close] = [useCommands('toolbar', ['file.save']).at(0), useCommands('toolbar', ['file.close']).at(0)];
  const activate = (): void => documents.activate(session.documentToken);
  const run = (id: string): void => { activate(); registry.execute(id); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
  };
  const title = sessionTitle(session);
  return (
    <div role="tab" tabIndex={active ? 0 : -1} aria-selected={active} data-testid="document-tab" data-dirty={session.dirty}
      data-document={session.documentToken} title={title} onClick={activate} onKeyDown={onKeyDown}
      className={cn('group flex h-[calc(var(--area-tabs)-4px)] max-w-56 min-w-24 shrink items-center gap-1.5 rounded-t-md border border-b-0 border-transparent px-2 text-xs outline-none transition-colors',
        'hover:bg-hover focus-visible:outline-solid focus-visible:outline-(length:--focus-ring-width) focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
        active ? 'border-border bg-panel text-fg' : 'text-muted')}>
      <span aria-label={session.dirty ? t('tabs.dirty') : t('tabs.saved')} data-testid="dirty-dot"
        className={cn('size-1.5 shrink-0 rounded-full', session.dirty ? 'bg-accent' : 'bg-transparent')} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {save && <IconButton label={t('tabs.save', { title })} size="compact" disabled={!save.enabled} data-command="file.save"
          {...(save.shortcut === undefined ? {} : { shortcut: save.shortcut })}
          onClick={event => { event.stopPropagation(); run('file.save'); }}><Save /></IconButton>}
        {close && <IconButton label={t('tabs.close', { title })} size="compact" disabled={!close.enabled} data-command="file.close"
          {...(close.shortcut === undefined ? {} : { shortcut: close.shortcut })}
          onClick={event => { event.stopPropagation(); run('file.close'); }}><X /></IconButton>}
      </span>
    </div>
  );
}

export function DocumentTabs() {
  const t = useT();
  const { registry } = useServices();
  const { sessions, active } = useDocuments();
  const create = useCommands('toolbar', ['file.new']).at(0);
  return (
    <div role="tablist" aria-label={t('tabs.list')} data-area="tabs" className="flex h-area-tabs items-end gap-px border-b border-border bg-toolbar px-1">
      {sessions.map(session => <Tab key={session.documentToken} session={session} active={session === active} />)}
      {create && <IconButton label={create.label} size="compact" className="mb-0.5 ml-1" disabled={!create.enabled} data-command="file.new"
        {...(create.shortcut === undefined ? {} : { shortcut: create.shortcut })}
        onClick={() => { registry.execute('file.new'); }}><Plus /></IconButton>}
      {sessions.length === 0 && <span className="self-center px-2 text-2xs text-subtle">{t('tabs.empty')}</span>}
    </div>
  );
}
