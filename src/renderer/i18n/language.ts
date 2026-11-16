import type { Language } from '../../main/settings';

/**
 * The one UI-language cell shared by the renderer and, through its own module instance, the main
 * process. Korean is the default; the preferences store (renderer) and the settings store (main)
 * write the persisted choice here, and every surface reads through `t()` or `useLanguage()`.
 */
let current: Language = 'ko';
const listeners = new Set<() => void>();

export const getLanguage = (): Language => current;
export const languageIndex = (language: Language = current): 0 | 1 => language === 'en' ? 1 : 0;

export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  for (const listener of listeners) listener();
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
