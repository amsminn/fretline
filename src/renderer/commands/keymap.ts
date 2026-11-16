export type Platform = 'mac' | 'windows';
export type KeyInput = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat'>;
export type Shortcut = { readonly mac: readonly string[]; readonly windows: readonly string[] };

export function normalizeKey(event: KeyInput): string | undefined {
  if (event.isComposing || event.key === 'Dead' || event.key === 'Unidentified') return undefined;
  const key = event.key === ' ' || event.key === 'Spacebar' ? 'Space' : event.key.toLowerCase();
  // Shift is already represented by printable punctuation (+, _, :, ...).
  const shifted = event.shiftKey && (key.length !== 1 || /[a-z]/.test(key));
  return [event.metaKey ? 'Meta' : '', event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '', shifted ? 'Shift' : '', key].filter(Boolean).join('+');
}

export function normalizeShortcut(shortcut: string): string {
  const parts = shortcut.split('+');
  const key = parts.pop() ?? '';
  // A trailing "+" represents the literal plus key.
  const literal = key === '' ? '+' : key;
  const modifiers = new Set(parts.filter(Boolean));
  return normalizeKey({
    key: literal === 'Space' ? ' ' : literal, metaKey: modifiers.has('Meta'),
    ctrlKey: modifiers.has('Ctrl'), altKey: modifiers.has('Alt'),
    shiftKey: modifiers.has('Shift'), isComposing: false, repeat: false,
  }) ?? '';
}

export function primary(key: string): Shortcut {
  return { mac: [`Meta+${key}`], windows: [`Ctrl+${key}`] };
}
export function shared(...keys: readonly string[]): Shortcut {
  return { mac: keys, windows: keys };
}

// Unambiguous appendix entries for actions whose catalog rows are grouped.
export const additionalShortcuts: Readonly<Record<string, Shortcut>> = {
  'track.add': { mac: ['Meta+Alt+n'], windows: ['Ctrl+Shift+Insert'] },
  'track.delete': { mac: ['Meta+Alt+r'], windows: ['Delete'] },
  'bar.insert': { mac: ['Meta++'], windows: ['Insert'] },
  'bar.delete': { mac: ['Ctrl+-'], windows: ['Ctrl+Delete'] },
  'bar.meter': primary('t'),
  'bar.key': primary('k'),
  'bar.repeatOpen': shared('['),
  'bar.repeatClose': shared(']'),
  'bar.directions': shared('d'),
  'bar.freeTime': shared('|'),
  'section.edit': { mac: ['Meta+Alt++'], windows: ['Shift+Insert'] },
  'section.next': primary('Alt+ArrowRight'),
  'section.previous': primary('Alt+ArrowLeft'),
  'section.text': shared('t'),
  'section.chord': shared('a'),
  'section.automation': shared('F10'),
  'view.lineBreak': primary('Enter'),
  'view.design': { mac: ['Ctrl+Alt+d'], windows: ['Ctrl+Alt+d'] },
  'view.zoomIn': { mac: ['Meta+>'], windows: ['Ctrl++'] },
  'view.zoomOut': { mac: ['Meta+<'], windows: ['Ctrl+-'] },
  'tools.instrument': primary('F6'),
  'tools.scale': shared('Shift+s'),
};
