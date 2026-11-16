import type { Rect } from './overlay';

export type PrintedLabel = { readonly text: string; readonly bounds: Rect };

/** SVG text owns its painted bounds, including effect rows that beat bounds do not expose. */
export function printedLabels(engine: Element | null | undefined): readonly PrintedLabel[] {
  if (!engine) return [];
  const origin = engine.getBoundingClientRect();
  return [...engine.querySelectorAll('text')].map(text => {
    const bounds = text.getBoundingClientRect();
    return { text: text.textContent?.trim() ?? '', bounds: {
      x: bounds.x - origin.x, y: bounds.y - origin.y, width: bounds.width, height: bounds.height,
    } };
  }).filter(label => label.bounds.width > 0 && label.bounds.height > 0);
}

/** Each painted label belongs to one hotspot, even when the score repeats an identical value. */
export function takeNearestLabel(labels: PrintedLabel[], matches: (text: string) => boolean, fallback: Rect): Rect {
  const distance = (bounds: Rect): number => Math.hypot(bounds.x - fallback.x, bounds.y - fallback.y);
  const nearest = labels.filter(label => matches(label.text))
    .sort((a, b) => distance(a.bounds) - distance(b.bounds))[0];
  if (!nearest) return fallback;
  labels.splice(labels.indexOf(nearest), 1);
  return nearest.bounds;
}
