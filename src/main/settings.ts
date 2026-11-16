import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { checkSchema } from '../domain/schema/check';
import type { Schema } from '../domain/schema/check';

/**
 * Durable application settings. Only state that is safe to restore after a restart lives here:
 * theme, language, panel layout, window bounds and the recent-file list. Per-document session
 * state (selection, loop, mixer) is deliberately not persisted.
 */
export type Theme = 'dark' | 'light';
export type Language = 'ko' | 'en';
/** What the user chose: one language, or the language macOS lists first. */
export type LanguageSetting = 'system' | Language;
export type PanelSetting = { readonly visible: boolean; readonly size: number };
export type PanelSettings = { readonly palette: PanelSetting; readonly inspector: PanelSetting; readonly globalView: PanelSetting };
export type WindowBounds = { readonly width: number; readonly height: number; readonly x?: number; readonly y?: number };
export type RecentEntry = { readonly path: string; readonly pinned: boolean; readonly openedAt: string };
export type Settings = {
  readonly version: 2;
  readonly theme: Theme;
  readonly language: LanguageSetting;
  readonly panels: PanelSettings;
  readonly window: WindowBounds | null;
  readonly restoreWindow: boolean;
  readonly recent: readonly RecentEntry[];
};
export type SettingsPatch = Partial<Pick<Settings, 'theme' | 'language' | 'panels' | 'restoreWindow'>>;
export type RendererSettings = Pick<Settings, 'version' | 'theme' | 'language' | 'panels' | 'restoreWindow'> & { readonly displayLanguage: Language };

export const recentLimit = 20;
const panelLimits = { palette: [160, 420, 220], inspector: [200, 480, 260], globalView: [96, 420, 190] } as const;
export const defaultSettings: Settings = {
  version: 2, theme: 'dark', language: 'system',
  panels: { palette: { visible: true, size: 220 }, inspector: { visible: true, size: 260 }, globalView: { visible: true, size: 190 } },
  window: null, restoreWindow: true, recent: [],
};

const panelSchema = (id: keyof typeof panelLimits): Schema => ({
  type: 'object', required: ['visible', 'size'], additionalProperties: false,
  properties: { visible: { type: 'boolean' }, size: { type: 'integer', minimum: panelLimits[id][0], maximum: panelLimits[id][1] } },
});
const windowSchema: Schema = {
  oneOf: [{ type: 'null' }, {
    type: 'object', required: ['width', 'height'], additionalProperties: false,
    properties: { width: { type: 'integer', minimum: 640, maximum: 16384 }, height: { type: 'integer', minimum: 480, maximum: 16384 },
      x: { type: 'integer', minimum: -16384, maximum: 16384 }, y: { type: 'integer', minimum: -16384, maximum: 16384 } },
  }],
};
export const settingsSchema: Schema = {
  type: 'object', additionalProperties: false,
  required: ['version', 'theme', 'language', 'panels', 'window', 'restoreWindow', 'recent'],
  properties: {
    version: { const: 2 },
    theme: { enum: ['dark', 'light'] },
    language: { enum: ['system', 'ko', 'en'] },
    panels: { type: 'object', required: ['palette', 'inspector', 'globalView'], additionalProperties: false,
      properties: { palette: panelSchema('palette'), inspector: panelSchema('inspector'), globalView: panelSchema('globalView') } },
    window: windowSchema,
    restoreWindow: { type: 'boolean' },
    recent: { type: 'array', maxItems: recentLimit, items: {
      type: 'object', required: ['path', 'pinned', 'openedAt'], additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1, maxLength: 4096 }, pinned: { type: 'boolean' }, openedAt: { type: 'string', maxLength: 64 } },
    } },
  },
};
export const isSettings = (input: unknown): input is Settings => checkSchema(input, settingsSchema).length === 0;

const record = (input: unknown): Readonly<Record<string, unknown>> =>
  typeof input === 'object' && input !== null && !Array.isArray(input) ? Object.fromEntries(Object.entries(input)) : {};
const pickEnum = <T extends string>(input: unknown, allowed: readonly T[], fallback: T): T =>
  typeof input === 'string' && (allowed as readonly string[]).includes(input) ? input as T : fallback;
function pickPanel(input: unknown, id: keyof typeof panelLimits): PanelSetting {
  const value = record(input);
  const [min, max, initial] = panelLimits[id];
  const size = typeof value['size'] === 'number' && Number.isFinite(value['size']) ? Math.min(max, Math.max(min, Math.round(value['size']))) : initial;
  return { visible: typeof value['visible'] === 'boolean' ? value['visible'] : true, size };
}
function pickWindow(input: unknown): WindowBounds | null {
  const value = record(input);
  const integer = (key: string): number | undefined =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) ? Math.round(value[key]) : undefined;
  const width = integer('width'); const height = integer('height');
  if (width === undefined || height === undefined || width < 640 || height < 480 || width > 16384 || height > 16384) return null;
  const x = integer('x'); const y = integer('y');
  return { width, height, ...(x !== undefined && Math.abs(x) <= 16384 ? { x } : {}), ...(y !== undefined && Math.abs(y) <= 16384 ? { y } : {}) };
}
function pickRecent(input: unknown): readonly RecentEntry[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const entries: RecentEntry[] = [];
  for (const item of input) {
    // Version 0 stored bare path strings; version 1 stores entries with pin state and time.
    const value = typeof item === 'string' ? { path: item } : record(item);
    const path = value['path'];
    if (typeof path !== 'string' || !path.length || path.length > 4096 || seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, pinned: value['pinned'] === true,
      openedAt: typeof value['openedAt'] === 'string' && !Number.isNaN(Date.parse(value['openedAt'])) ? value['openedAt'] : new Date(0).toISOString() });
  }
  return entries.slice(0, recentLimit);
}
/**
 * Any stored shape (an older file, a damaged file, a future version) migrates to a valid version-2
 * document by keeping each recognised safe value and defaulting the rest. It never throws.
 * Version 1 wrote Korean into every file as its default, so there a stored Korean was not a choice
 * and becomes the system language; a stored English was chosen and is kept.
 */
export function migrateSettings(input: unknown): Settings {
  if (isSettings(input)) return input;
  const raw = record(input);
  const panels = record(raw['panels']);
  const migrated: Settings = {
    version: 2,
    theme: pickEnum(raw['theme'], ['dark', 'light'], defaultSettings.theme),
    language: raw['version'] === 2 ? pickEnum(raw['language'], ['system', 'ko', 'en'], defaultSettings.language)
      : raw['language'] === 'en' ? 'en' : defaultSettings.language,
    panels: { palette: pickPanel(panels['palette'], 'palette'), inspector: pickPanel(panels['inspector'], 'inspector'), globalView: pickPanel(panels['globalView'], 'globalView') },
    window: pickWindow(raw['window']),
    restoreWindow: typeof raw['restoreWindow'] === 'boolean' ? raw['restoreWindow'] : defaultSettings.restoreWindow,
    recent: pickRecent(raw['recent']),
  };
  if (!isSettings(migrated)) throw new TypeError('Settings migration produced an invalid document');
  return migrated;
}
export function applyPatch(current: Settings, patch: unknown): Settings {
  const value = record(patch);
  const allowed = ['theme', 'language', 'panels', 'restoreWindow'] as const;
  const unknown = Object.keys(value).filter(key => !(allowed as readonly string[]).includes(key));
  if (unknown.length) throw new TypeError(`Unknown settings keys: ${unknown.join(', ')}`);
  const next = migrateSettings({ ...current, ...Object.fromEntries(allowed.filter(key => key in value).map(key => [key, value[key]])) });
  if (allowed.some(key => key in value && JSON.stringify(next[key]) !== JSON.stringify(value[key]))) throw new TypeError('Settings patch contains invalid values');
  return next;
}
/** English unless the chosen language, or the first language macOS lists, is Korean. */
export const displayLanguage = (setting: LanguageSetting, systemLanguages: readonly string[]): Language =>
  setting !== 'system' ? setting : systemLanguages[0]?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
export const rendererSettings = ({ version, theme, language, panels, restoreWindow }: Settings, systemLanguages: readonly string[]): RendererSettings =>
  ({ version, theme, language, panels, restoreWindow, displayLanguage: displayLanguage(language, systemLanguages) });

export function rememberRecent(current: Settings, path: string, now = new Date()): Settings {
  const existing = current.recent.find(entry => entry.path === path);
  const entry: RecentEntry = { path, pinned: existing?.pinned ?? false, openedAt: now.toISOString() };
  const rest = current.recent.filter(item => item.path !== path);
  // Pinned entries are never evicted by newer unpinned opens.
  const unpinned = rest.filter(item => !item.pinned);
  const pinned = rest.filter(item => item.pinned);
  const kept = [entry, ...unpinned].slice(0, Math.max(1, recentLimit - pinned.length));
  return { ...current, recent: [...pinned, ...kept].slice(0, recentLimit) };
}
export const forgetRecent = (current: Settings, path: string): Settings =>
  ({ ...current, recent: current.recent.filter(entry => entry.path !== path) });
export const pinRecent = (current: Settings, path: string, pinned: boolean): Settings =>
  ({ ...current, recent: current.recent.map(entry => entry.path === path ? { ...entry, pinned } : entry) });
export const orderedRecent = (settings: Settings): readonly RecentEntry[] =>
  [...settings.recent].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.openedAt.localeCompare(a.openedAt));
export const recentDisplayName = (entry: RecentEntry): { readonly name: string; readonly folder: string } =>
  ({ name: basename(entry.path), folder: basename(dirname(entry.path)) });

export class SettingsStore {
  private current: Settings;
  constructor(private readonly path: string) {
    let parsed: unknown = undefined;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      parsed = undefined;
    }
    this.current = migrateSettings(parsed);
  }
  get(): Settings { return this.current; }
  update(next: Settings): Settings {
    if (next === this.current) return next;
    this.current = next;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify(next, null, 2));
    renameSync(temporary, this.path);
    return next;
  }
  patch(input: unknown): Settings { return this.update(applyPatch(this.current, input)); }
  remember(path: string): Settings { return this.update(rememberRecent(this.current, path)); }
  forget(path: string): Settings { return this.update(forgetRecent(this.current, path)); }
  pin(path: string, pinned: boolean): Settings { return this.update(pinRecent(this.current, path, pinned)); }
  setWindow(window: WindowBounds | null): Settings { return this.update(migrateSettings({ ...this.current, window })); }
  /** Entries whose file still exists keep their position; missing files stay listed so the user can see and remove them. */
  recentWithExistence(): readonly (RecentEntry & { readonly exists: boolean })[] {
    return orderedRecent(this.current).map(entry => ({ ...entry, exists: existsSync(entry.path) }));
  }
}
export const settingsFile = (userData: string): string => join(userData, 'settings.json');
