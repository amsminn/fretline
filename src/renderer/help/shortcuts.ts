import { commandDefinitions, menuLabel, menus } from '../commands/catalog';
import type { CommandDefinition, MenuName } from '../commands/catalog';
import type { Platform } from '../commands/keymap';
import { displayShortcut } from '../lib/shortcut-format';

export { displayShortcut };

export type ShortcutRow = {
  readonly id: string;
  readonly label: string;
  readonly keys: readonly string[];
};
export type ShortcutGroup = {
  readonly menu: MenuName;
  readonly menuLabel: string;
  readonly rows: readonly ShortcutRow[];
};

/** Every catalog entry grouped by menu; rows without a key stay listed as menu-only so nothing is hand-copied or omitted. */
export function shortcutGroups(platform: Platform, definitions: readonly CommandDefinition[] = commandDefinitions): readonly ShortcutGroup[] {
  return menus.map(([menu, korean]) => ({
    menu, menuLabel: menuLabel(menu, korean),
    rows: definitions.filter(definition => definition.menu === menu)
      .map(definition => ({ id: definition.id, label: definition.label, keys: definition.keys[platform].map(binding => displayShortcut(binding, platform)) })),
  })).filter(group => group.rows.length > 0);
}

/** `docs/shortcuts.md` is this text verbatim; `tests/ui/help.test.tsx` fails when the file and the catalog drift apart. */
export function shortcutsMarkdown(definitions: readonly CommandDefinition[] = commandDefinitions): string {
  const platforms: readonly Platform[] = ['mac', 'windows'];
  const groups = platforms.map(platform => shortcutGroups(platform, definitions));
  const lines = [
    '# Fretline 단축키',
    '',
    '이 표는 `src/renderer/commands/catalog.ts`와 `keymap.ts`에서 `shortcutsMarkdown()`으로 생성한다. 손으로 고치지 말고',
    '`bun -e "import { shortcutsMarkdown } from \'./src/renderer/help/shortcuts\'; await Bun.write(\'docs/shortcuts.md\', shortcutsMarkdown())"`로 다시 만든다.',
    '앱 안의 도움말 > 단축키 탭은 같은 목록을 현재 플랫폼 기준으로 보여 주고, 각 행에서 명령을 바로 실행할 수 있다.',
    '',
    '키가 없는 행은 메뉴·명령 팔레트(⌘E / Ctrl+E)로만 실행한다. 재생 중에는 `playback` 문맥의 키만 듣고, 입력 필드와 대화상자 안에서는 악보 명령 키가 전달되지 않는다.',
    'Windows 열은 키맵 데이터이며 Windows 실행 검증을 뜻하지 않는다.',
    '',
  ];
  const macGroups = groups[0] ?? [];
  const windowsGroups = groups[1] ?? [];
  macGroups.forEach((group, index) => {
    const windowsRows = new Map((windowsGroups[index]?.rows ?? []).map(row => [row.id, row.keys]));
    lines.push(`## ${group.menuLabel} (${group.menu})`, '', '| 명령 | ID | macOS | Windows |', '| --- | --- | --- | --- |');
    for (const row of group.rows) {
      const windowsKeys = windowsRows.get(row.id) ?? [];
      lines.push(`| ${row.label} | \`${row.id}\` | ${row.keys.join(', ') || '메뉴'} | ${windowsKeys.join(', ') || '메뉴'} |`);
    }
    lines.push('');
  });
  return lines.join('\n');
}
