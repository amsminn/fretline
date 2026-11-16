import type { Platform } from '../commands/keymap';

const keyNames: Readonly<Record<string, string>> = {
  Meta: '⌘', Ctrl: 'Ctrl', Alt: '⌥', Shift: '⇧', Space: 'Space', Escape: 'Esc', Backspace: '⌫', Enter: '↩', Tab: 'Tab',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
};
const macModifierOrder: readonly string[] = ['Ctrl', 'Alt', 'Shift', 'Meta'];

export const currentPlatform = (userAgentPlatform: string): Platform => (/mac|iphone|ipad/i.test(userAgentPlatform) ? 'mac' : 'windows');

/** Displays a catalog binding (`Meta+Shift+z`) with the platform's glyphs; a trailing `+` is the literal plus key. */
export function displayShortcut(binding: string, platform: Platform): string {
  const parts = binding.split('+');
  const key = parts.pop() ?? '';
  const literal = key === '' ? '+' : key;
  const name = keyNames[literal] ?? (literal.length === 1 ? literal.toUpperCase() : literal);
  const modifiers = parts.filter(Boolean);
  if (platform !== 'mac') return [...modifiers, name].join('+');
  const ordered = [...modifiers].sort((a, b) => macModifierOrder.indexOf(a) - macModifierOrder.indexOf(b));
  return [...ordered.map(modifier => keyNames[modifier] === 'Ctrl' ? '⌃' : keyNames[modifier] ?? modifier), name].join('');
}

export const formatShortcut = (binding: string): string =>
  displayShortcut(binding, currentPlatform(typeof navigator === 'undefined' ? '' : navigator.platform));
