/**
 * Toolbar overflow planning (UX02). The toolbar measures its groups and, when they do not fit,
 * first shrinks the LCD to its token minimum and then moves the lowest-priority groups, right to
 * left, into one "더 보기" menu. Transport, LCD, panel toggles and loop/practice never collapse:
 * practice is the primary workflow (IS-3/IS-8) and its controls are popovers, not commands.
 */

/** Toolbar items in UX02 order; separators are measured like any other item. */
export const toolbarItemOrder = ['panels', 'separator-a', 'zoom', 'history', 'separator-b', 'transport', 'lcd', 'loop', 'tonality', 'backing', 'instrument'] as const;
export type ToolbarItemId = typeof toolbarItemOrder[number];

/** Collapse order: the first entry leaves the toolbar first and returns last. */
export const collapseOrder = ['instrument', 'backing', 'tonality', 'zoom', 'history'] as const;
export type CollapsibleId = typeof collapseOrder[number];

export type ToolbarMeasurement = { readonly id: ToolbarItemId; readonly width: number };
export type ToolbarMetrics = {
  readonly available: number;
  /** Flex gap between items and the toolbar's horizontal padding, both from computed style. */
  readonly gap: number;
  readonly padding: number;
  /** Width the overflow menu button adds once any group collapses. */
  readonly menuWidth: number;
  /** Width the LCD gives back in its compact density; undefined until compact has been measured. */
  readonly lcdSaving: number | undefined;
};
export type ToolbarPlan = { readonly collapsed: readonly CollapsibleId[]; readonly lcdCompact: boolean; readonly compact: boolean };

export const fullToolbarPlan: ToolbarPlan = { collapsed: [], lcdCompact: false, compact: false };

const isCollapsible = (id: ToolbarItemId): id is CollapsibleId => (collapseOrder as readonly string[]).includes(id);

/** Natural widths come from measurement; an item with width 0 is not rendered and never costs a gap. */
export function planToolbar(items: readonly ToolbarMeasurement[], metrics: ToolbarMetrics): ToolbarPlan {
  const present = items.filter(item => item.width > 0);
  let total = present.reduce((sum, item) => sum + item.width, 0) + metrics.gap * Math.max(0, present.length - 1) + metrics.padding;
  if (total <= metrics.available) return fullToolbarPlan;
  total -= metrics.lcdSaving ?? 0;
  if (total <= metrics.available) return { collapsed: [], lcdCompact: true, compact: true };
  total += metrics.menuWidth + metrics.gap;
  const collapsed: CollapsibleId[] = [];
  for (const id of collapseOrder) {
    const item = present.find(candidate => candidate.id === id);
    if (!item || !isCollapsible(item.id)) continue;
    collapsed.push(id);
    total -= item.width + metrics.gap;
    if (total <= metrics.available) break;
  }
  return { collapsed, lcdCompact: true, compact: true };
}

export const samePlan = (a: ToolbarPlan, b: ToolbarPlan): boolean =>
  a.lcdCompact === b.lcdCompact && a.collapsed.length === b.collapsed.length && a.collapsed.every((id, index) => b.collapsed[index] === id);
