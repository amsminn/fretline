import type { Language } from '../../main/settings';
import { getLanguage, languageIndex } from './language';
import { commonMessages } from './messages/common';
import { diagnosticMessages } from './messages/diagnostics';
import { dialogEditMessages } from './messages/dialogs-edit';
import { dialogIoMessages } from './messages/dialogs-io';
import { helpMessages } from './messages/help';
import { homeMessages } from './messages/home';
import { inspectorMessages } from './messages/inspector';
import { mainMessages } from './messages/main';
import { paletteMessages } from './messages/palette';
import { prefsMessages } from './messages/prefs';
import { printMessages } from './messages/print';
import { shellMessages } from './messages/shell';
import { stateMessages } from './messages/state';
import { toolbarMessages } from './messages/toolbar';
import { toolsMessages } from './messages/tools';

export type MessagePair = readonly [ko: string, en: string];
export type MessageTable = Readonly<Record<string, MessagePair>>;
export type MessageParams = Readonly<Record<string, string | number>>;

export const messageModules = {
  common: commonMessages, dialogsEdit: dialogEditMessages, dialogsIo: dialogIoMessages,
  help: helpMessages, home: homeMessages, inspector: inspectorMessages, main: mainMessages, palette: paletteMessages,
  prefs: prefsMessages, print: printMessages, shell: shellMessages, state: stateMessages, toolbar: toolbarMessages, tools: toolsMessages,
} as const satisfies Readonly<Record<string, MessageTable>>;

export const messages = {
  ...commonMessages, ...dialogEditMessages, ...dialogIoMessages, ...helpMessages, ...homeMessages,
  ...inspectorMessages, ...mainMessages, ...paletteMessages, ...prefsMessages, ...printMessages, ...shellMessages,
  ...stateMessages, ...toolbarMessages, ...toolsMessages,
} as const;
export type MessageKey = keyof typeof messages;

const placeholder = /\{(\w+)\}/g;
export function format(template: string, params: MessageParams): string {
  return template.replace(placeholder, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function t(key: MessageKey, params?: MessageParams, language: Language = getLanguage()): string {
  const template: string = messages[key][languageIndex(language)];
  return params ? format(template, params) : template;
}

export const pick = (pair: MessagePair, language: Language = getLanguage()): string => pair[languageIndex(language)];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toPattern = (template: string): RegExp => new RegExp(`^${escape(template).replace(/\\\{\w+\\\}/g, '([\\s\\S]+?)')}$`);

let templatePatterns: readonly RegExp[] | undefined;
export function isLocalizedMessage(text: string): boolean {
  templatePatterns ??= [...Object.values(messages), ...diagnosticMessages].flatMap(pair => pair.map(toPattern));
  return templatePatterns.some(pattern => pattern.test(text));
}

const hangul = /[\u3131-\uD7A3]/;
type DiagnosticTemplate = { readonly pattern: RegExp; readonly en: string; readonly slots: readonly string[] };
let diagnosticExact: ReadonlyMap<string, string> | undefined;
let diagnosticTemplates: readonly DiagnosticTemplate[] | undefined;
/**
 * Resolves text produced below the renderer (adapter reports, domain rejections, worker errors), whose Korean
 * wording is the lookup key; parameters captured from a template are localized recursively.
 */
export function localize(text: string, language: Language = getLanguage()): string {
  if (language !== 'en' || !hangul.test(text)) return text;
  diagnosticExact ??= new Map(diagnosticMessages.filter(([ko]) => ko.search(placeholder) < 0).map(([ko, en]) => [ko, en]));
  diagnosticTemplates ??= diagnosticMessages.filter(([ko]) => ko.search(placeholder) >= 0)
    .map(([ko, en]) => ({ pattern: toPattern(ko), en, slots: [...ko.matchAll(placeholder)].map(match => match[1] ?? '') }));
  const exact = diagnosticExact.get(text);
  if (exact !== undefined) return exact;
  for (const template of diagnosticTemplates) {
    const match = template.pattern.exec(text);
    if (!match) continue;
    const values = Object.fromEntries(template.slots.map((slot, index) => [slot, localize(match[index + 1] ?? '', language)]));
    return format(template.en, values);
  }
  if (text.includes('\n')) return text.split('\n').map(line => localize(line, language)).join('\n');
  const coded = /^([A-Z][A-Z0-9_]*: )([\s\S]+)$/.exec(text);
  if (coded) return `${coded[1] ?? ''}${localize(coded[2] ?? '', language)}`;
  return text;
}
