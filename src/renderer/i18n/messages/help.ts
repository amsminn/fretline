import type { MessageTable } from '../index';

export const helpMessages = {
  'help.section.guide': ['사용 설명서', 'User Guide'],
  'help.section.shortcuts': ['단축키', 'Shortcuts'],
  'help.section.compatibility': ['호환성', 'Compatibility'],
  'help.link.run': ['{label} 실행', 'Run {label}'],
  'help.link.unavailable': ['{label}: 지금은 실행할 수 없습니다', '{label}: cannot run right now'],
  'help.link.missing': ['{label}: 이 빌드에 없는 명령', '{label}: command not in this build'],
  'help.shortcuts.search': ['단축키 검색', 'Search shortcuts'],
  'help.shortcuts.placeholder': ['명령 이름 또는 키', 'Command name or key'],
  'help.shortcuts.note': ['명령 목록과 키는 앱의 명령 카탈로그에서 그대로 가져옵니다. 명령 이름을 누르면 실행됩니다. 키가 없는 명령은 메뉴와 명령 팔레트에서 실행합니다.', 'The command list and keys come straight from the app\'s command catalog. Click a command name to run it. Commands without a key run from the menu or the command palette.'],
  'help.shortcuts.empty': ['일치하는 명령이 없습니다.', 'No matching commands.'],
  'help.shortcuts.menuOnly': ['메뉴', 'Menu'],
  'help.compat.intro': ['아래 표는 이 앱이 지원하는 범위와 보장하지 않는 것을 적습니다. 열린 파일의 실제 상태는 악보 위 호환성 배지에서 확인합니다.', 'The table below lists what this app supports and what it does not guarantee. The actual state of an open file is shown by the compatibility badge above the score.'],
  'help.title': ['도움말', 'Help'],
  'help.description': ['앱에 내장된 설명서입니다. 네트워크가 필요 없습니다.', 'The manual built into the app. No network needed.'],
} as const satisfies MessageTable;
