import { FileX2, Pin, PinOff, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { RecentFile } from '../../main/open';
import { cn } from '../lib/cn';
import { IconButton } from '../ui/IconButton';
import { t } from '../i18n';
import type { HomeStore } from './store';

function RecentRow({ file, store, busy }: { readonly file: RecentFile; readonly store: HomeStore; readonly busy: boolean }) {
  const open = (): void => { void store.open(file.token); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  };
  return (
    <div role="listitem" tabIndex={0} data-testid="recent-document" data-recent-name={file.name} data-pinned={file.pinned} data-exists={file.exists}
      onClick={open} onKeyDown={onKeyDown} aria-disabled={busy}
      className={cn('group flex h-control-toolbar cursor-default items-center gap-2 rounded-md px-2 outline-none transition-colors',
        'hover:bg-hover focus-visible:outline-solid focus-visible:outline-(length:--focus-ring-width) focus-visible:-outline-offset-2 focus-visible:outline-focus-ring')}>
      {file.exists
        ? <span aria-hidden className="size-icon-sm shrink-0 rounded-sm border border-border-strong bg-paper" />
        : <FileX2 aria-hidden className="size-icon-sm shrink-0 text-warning" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-fg">{file.name}</span>
        <span className="block truncate text-2xs text-subtle">{file.exists ? file.folder : t('home.recent.missing')}</span>
      </span>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[pinned=true]:opacity-100" data-pinned={file.pinned}>
        <IconButton size="compact" label={t(file.pinned ? 'home.unpin' : 'home.pin')} data-action="pin" disabled={busy}
          onClick={event => { event.stopPropagation(); void store.pin(file.token, !file.pinned); }}>{file.pinned ? <PinOff /> : <Pin />}</IconButton>
        <IconButton size="compact" label={t('home.remove')} data-action="forget" disabled={busy}
          onClick={event => { event.stopPropagation(); void store.forget(file.token); }}><X /></IconButton>
      </span>
    </div>
  );
}

export function RecentDocuments({ store, recent, busy }: {
  readonly store: HomeStore; readonly recent: readonly RecentFile[]; readonly busy: boolean;
}) {
  if (!recent.length) return <p data-testid="recent-empty" className="px-2 py-3 text-xs text-muted">{t('home.recent.empty')}</p>;
  const pinned = recent.filter(file => file.pinned);
  const rest = recent.filter(file => !file.pinned);
  return (
    <div className="flex flex-col gap-3">
      {pinned.length > 0 && <div role="list" aria-label={t('home.pinned')} data-testid="recent-pinned" className="flex flex-col">
        <span className="px-2 pb-1 text-2xs font-medium uppercase tracking-wide text-subtle">{t('home.pinned')}</span>
        {pinned.map(file => <RecentRow key={file.token} file={file} store={store} busy={busy} />)}
      </div>}
      <div role="list" aria-label={t('home.recent')} data-testid="recent-list" className="flex flex-col">
        {rest.map(file => <RecentRow key={file.token} file={file} store={store} busy={busy} />)}
      </div>
    </div>
  );
}
