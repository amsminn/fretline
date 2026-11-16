import { Circle, Ellipsis } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useT } from '../i18n/react';
import type { MessageKey } from '../i18n';
import { useCommands, useServices } from '../shell/services';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/DropdownMenu';
import { IconButton } from '../ui/IconButton';
import { Separator } from '../ui/Separator';
import { Backing, backingIds } from './Backing';
import { HistoryPrint, historyPrintIds } from './HistoryPrint';
import { InstrumentViews, instrumentViewsIds } from './InstrumentViews';
import { Lcd } from './Lcd';
import { LoopSpeed } from './LoopSpeed';
import { collapseOrder, fullToolbarPlan, planToolbar, samePlan, toolbarItemOrder } from './overflow';
import type { CollapsibleId, ToolbarItemId, ToolbarPlan } from './overflow';
import { Panels } from './Panels';
import { Tonality, tonalityIds } from './Tonality';
import { Transport } from './Transport';
import { ZoomView, zoomViewIds } from './ZoomView';
import { commandIcons } from './icons';

/**
 * Fallback for hosts that report no layout (every measured width is 0, e.g. happy-dom): below this
 * client width every collapsible group collapses. Browsers always measure, so Electron never uses it.
 */
export const compactToolbarWidth = 1280;

const collapsibleGroups: readonly { readonly id: CollapsibleId; readonly slot: MessageKey; readonly ids: readonly string[] }[] = [
  { id: 'zoom', slot: 'toolbar.slot.zoom', ids: zoomViewIds },
  { id: 'history', slot: 'toolbar.slot.history', ids: historyPrintIds },
  { id: 'tonality', slot: 'toolbar.slot.tonality', ids: tonalityIds },
  { id: 'backing', slot: 'toolbar.slot.backing', ids: backingIds },
  { id: 'instrument', slot: 'toolbar.slot.instrument', ids: instrumentViewsIds },
];

function OverflowGroup({ slot, ids, first }: { readonly slot: MessageKey; readonly ids: readonly string[]; readonly first: boolean }) {
  const t = useT();
  const { registry } = useServices();
  const commands = useCommands('toolbar', ids);
  if (commands.length === 0) return null;
  return (
    <>
      {!first && <DropdownMenuSeparator />}
      <DropdownMenuLabel>{t(slot)}</DropdownMenuLabel>
      {commands.map(command => {
        const Icon = commandIcons[command.id] ?? Circle;
        return <DropdownMenuItem key={command.id} disabled={!command.enabled} data-command={command.id}
          {...(command.shortcut === undefined ? {} : { shortcut: command.shortcut })}
          onSelect={() => { registry.execute(command.id); }}>
          <Icon className="size-icon-sm text-muted" />
          {command.label}
        </DropdownMenuItem>;
      })}
    </>
  );
}

function Overflow({ collapsed }: { readonly collapsed: readonly CollapsibleId[] }) {
  const t = useT();
  const groups = collapsibleGroups.filter(group => collapsed.includes(group.id));
  const ids = groups.flatMap(group => group.ids);
  const commands = useCommands('toolbar', ids);
  if (commands.length === 0) return null;
  const firstVisible = groups.find(group => commands.some(command => group.ids.includes(command.id)));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t('toolbar.more')} size="toolbar" data-testid="toolbar-overflow"><Ellipsis /></IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={t('toolbar.more')}>
        {groups.map(group => <OverflowGroup key={group.id} slot={group.slot} ids={group.ids} first={group === firstVisible} />)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const px = (value: string): number => Number.parseFloat(value) || 0;

function Item({ id, children }: { readonly id: ToolbarItemId | 'menu'; readonly children: ReactNode }) {
  return <div data-toolbar-item={id} className="flex shrink-0 items-center gap-1 empty:hidden">{children}</div>;
}

function useToolbarPlan(toolbar: RefObject<HTMLDivElement | null>): ToolbarPlan {
  const [plan, setPlan] = useState<ToolbarPlan>(fullToolbarPlan);
  const current = useRef(plan);
  const natural = useRef(new Map<string, number>());
  const measure = useCallback((available: number) => {
    const element = toolbar.current;
    if (!element || available <= 0) return;
    for (const item of element.querySelectorAll<HTMLElement>('[data-toolbar-item]')) {
      const id = item.dataset['toolbarItem'] ?? '';
      const key = id === 'lcd' && current.current.lcdCompact ? 'lcd:compact' : id;
      natural.current.set(key, item.getBoundingClientRect().width);
    }
    const items = toolbarItemOrder.map(id => ({ id, width: natural.current.get(id) ?? 0 }));
    const measured = items.some(item => item.width > 0);
    const style = getComputedStyle(element);
    const compactLcd = natural.current.get('lcd:compact');
    const fullLcd = natural.current.get('lcd') ?? 0;
    const next = measured
      ? planToolbar(items, {
        available,
        gap: px(style.columnGap),
        padding: px(style.paddingLeft) + px(style.paddingRight),
        menuWidth: natural.current.get('menu') ?? px(style.getPropertyValue('--control-toolbar')),
        lcdSaving: compactLcd === undefined ? undefined : fullLcd - compactLcd,
      })
      : available < compactToolbarWidth ? { collapsed: [...collapseOrder], lcdCompact: true, compact: true } : fullToolbarPlan;
    if (samePlan(next, current.current)) return;
    current.current = next;
    setPlan(next);
  }, [toolbar]);
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element) return;
    const toolbarObserver = new ResizeObserver(entries => { for (const entry of entries) measure(entry.contentRect.width); });
    const itemObserver = new ResizeObserver(() => { measure(element.getBoundingClientRect().width); });
    toolbarObserver.observe(element);
    for (const item of element.querySelectorAll('[data-toolbar-item]')) itemObserver.observe(item);
    measure(element.getBoundingClientRect().width);
    return () => { toolbarObserver.disconnect(); itemObserver.disconnect(); };
  }, [measure, plan]);
  return plan;
}

export function Toolbar() {
  const t = useT();
  const element = useRef<HTMLDivElement>(null);
  const plan = useToolbarPlan(element);
  const show = (id: CollapsibleId): boolean => !plan.collapsed.includes(id);
  return (
    <div ref={element} role="toolbar" aria-label={t('toolbar.label')} data-area="toolbar" data-compact={plan.compact}
      className="flex h-area-toolbar min-w-0 items-center gap-1 overflow-x-clip border-b border-border bg-toolbar px-1">
      <Item id="panels"><Panels /></Item>
      <Item id="separator-a"><Separator orientation="vertical" className="h-6" /></Item>
      {show('zoom') && <Item id="zoom"><ZoomView /></Item>}
      {show('history') && <Item id="history"><HistoryPrint /></Item>}
      <Item id="separator-b"><Separator orientation="vertical" className="h-6" /></Item>
      <Item id="transport"><Transport /></Item>
      <Item id="lcd"><Lcd compact={plan.lcdCompact} /></Item>
      <Item id="loop"><LoopSpeed /></Item>
      <div className="ml-auto flex items-center gap-1">
        {show('tonality') && <Item id="tonality"><Tonality /></Item>}
        {show('backing') && <Item id="backing"><Backing /></Item>}
        {show('instrument') && <Item id="instrument"><InstrumentViews /></Item>}
        {plan.collapsed.length > 0 && <Item id="menu"><Overflow collapsed={plan.collapsed} /></Item>}
      </div>
    </div>
  );
}
