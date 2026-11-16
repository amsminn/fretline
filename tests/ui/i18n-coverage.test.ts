import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandDefinitions, menus } from '../../src/renderer/commands/catalog';
import { CommandRegistry } from '../../src/renderer/commands/registry';
import { helpContent } from '../../src/renderer/help/content';
import { isLocalizedMessage, localize, messageModules, messages, t } from '../../src/renderer/i18n';
import { diagnosticMessages } from '../../src/renderer/i18n/messages/diagnostics';
import { getLanguage, setLanguage } from '../../src/renderer/i18n/language';

const hangul = /[\u3131-\uD7A3]/;
const placeholders = (template: string): readonly string[] => [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort();
const snapshot = JSON.parse(readFileSync(resolve('tests/ui/fixtures/catalog-labels.ko.json'), 'utf8')) as {
  readonly menus: Readonly<Record<string, string>>; readonly commands: Readonly<Record<string, string>>;
};

const sourceFiles = (dir: string): readonly string[] => readdirSync(dir).flatMap(name => {
  const path = resolve(dir, name);
  return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
});
/** Korean literals below the renderer, with every `${…}` interpolation normalised to a numbered slot. */
const lowerLayerTemplates = (): readonly string[] => {
  const seen = new Set<string>();
  for (const file of ['src/adapters', 'src/domain', 'src/workers', 'src/renderer/audio'].flatMap(sourceFiles)) {
    const code = readFileSync(file, 'utf8').split('\n').filter(line => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');
    for (const match of code.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
      const raw = match[1] ?? match[2] ?? '';
      if (!hangul.test(raw)) continue;
      let slot = 0;
      seen.add((match[2] === undefined ? raw : raw.replace(/\$\{[^}]*\}/g, () => `{${slot++}}`)).replace(/\\'/g, "'"));
    }
  }
  return [...seen];
};

afterEach(() => setLanguage('ko'));

describe('command catalog languages', () => {
  it('keeps every Korean label byte-identical to the recorded default and gives every command an English label', () => {
    expect(getLanguage()).toBe('ko');
    expect(Object.fromEntries(commandDefinitions.map(definition => [definition.id, definition.label]))).toEqual(snapshot.commands);
    expect(Object.fromEntries(menus)).toEqual(snapshot.menus);
    const english = commandDefinitions.filter(definition => definition.labels[1].trim() === '' || hangul.test(definition.labels[1]));
    expect(english.map(definition => definition.id)).toEqual([]);
  });
  it('resolves labels, menu titles and tooltips from the current language and restores Korean', () => {
    const registry = new CommandRegistry();
    registry.register('file.save', { execute: () => undefined });
    setLanguage('en');
    expect(commandDefinitions.find(definition => definition.id === 'sound.loop')?.label).toBe('Loop');
    const menu = registry.menu({ context: 'editing', platform: 'mac' });
    expect(menu.map(group => group.label)).toEqual(menus.map(([id]) => id));
    expect(menu.find(group => group.id === 'File')?.commands[0]?.tooltip).toBe('Save (Meta+s)');
    setLanguage('ko');
    expect(commandDefinitions.find(definition => definition.id === 'sound.loop')?.label).toBe('구간 반복');
    expect(registry.menu({ context: 'editing', platform: 'mac' }).find(group => group.id === 'File')?.commands[0]?.tooltip).toBe('저장 (Meta+s)');
  });
});

describe('message tables', () => {
  it('has one English value without Hangul and one Korean value per key, with matching placeholders and no duplicate keys across modules', () => {
    const entries = Object.entries(messages);
    expect(entries.length).toBeGreaterThan(400);
    const total = Object.values(messageModules).reduce((count: number, table) => count + Object.keys(table).length, 0);
    expect(total).toBe(entries.length);
    const defects = entries.flatMap(([key, [ko, en]]) => {
      const problems: string[] = [];
      if (ko.trim() === '') problems.push('empty ko');
      if (en.trim() === '') problems.push('empty en');
      if (hangul.test(en)) problems.push('hangul in en');
      if (placeholders(ko).join() !== placeholders(en).join()) problems.push('placeholder mismatch');
      return problems.map(problem => `${key}: ${problem}`);
    });
    expect(defects).toEqual([]);
  });
  it('formats placeholders in both languages and recognises its own templates as user-facing messages', () => {
    expect(t('tabs.save', { title: 'Song' })).toBe('Song 저장');
    setLanguage('en');
    expect(t('tabs.save', { title: 'Song' })).toBe('Save Song');
    expect(t('tabs.save', { title: 'Song' }, 'ko')).toBe('Song 저장');
    expect(isLocalizedMessage(t('main.print.pageCount', { max: 500 }))).toBe(true);
    expect(isLocalizedMessage(t('main.export.noData', undefined, 'ko'))).toBe(true);
    expect(isLocalizedMessage('Expected a bounded menu availability list')).toBe(false);
  });
  it('covers every Korean template produced below the renderer and resolves it at the display boundary', () => {
    const table = new Map(diagnosticMessages);
    expect(lowerLayerTemplates().filter(template => !table.has(template))).toEqual([]);
    expect(diagnosticMessages.filter(([ko, en]) => hangul.test(en) || en.trim() === '' || placeholders(ko).join() !== placeholders(en).join()).map(([ko]) => ko)).toEqual([]);
    expect(localize('악보 정보: tab')).toBe('악보 정보: tab');
    setLanguage('en');
    expect(localize('악보 정보: tab')).toBe('Score data: tab');
    expect(localize('3번째 마디')).toBe('Bar #3');
    expect(localize('손상된 WAV: WAV 청크가 잘렸습니다.')).toBe('Corrupt WAV: A WAV chunk is truncated.');
    expect(localize('음표를 선택하세요.\n보표를 선택하세요.')).toBe('Select notes.\nSelect a staff.');
    expect(localize('FORMAT: GP 파일 헤더를 인식할 수 없습니다.')).toBe('FORMAT: The GP file header is not recognised.');
    expect(localize('Lead Guitar')).toBe('Lead Guitar');
  });
  it('renders the built-in help in English without Hangul and in Korean by default', () => {
    const korean = helpContent();
    expect(korean.intro).toMatch(hangul);
    setLanguage('en');
    const english = helpContent();
    const prose = [english.intro, ...Object.values(english.statusLabels),
      ...english.guideTopics.flatMap(topic => [topic.title, ...topic.paragraphs.flat().filter((inline): inline is string => typeof inline === 'string')]),
      ...english.compatibilityGroups.flatMap(group => [group.title, ...group.rows.flatMap(row => [row.area, ...row.text.filter((inline): inline is string => typeof inline === 'string')])])];
    expect(prose.filter(text => hangul.test(text))).toEqual([]);
    expect(english.guideTopics.map(topic => topic.id)).toEqual(korean.guideTopics.map(topic => topic.id));
  });
});
