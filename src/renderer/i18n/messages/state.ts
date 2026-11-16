import type { MessageTable } from '../index';

export const stateMessages = {
  'audio.soundFontFailed': ['사운드폰트를 불러오지 못했습니다.', 'Could not load the SoundFont.'],
  'state.inspectOnly': ['새 프로젝트 버전 {version}: 읽기 전용 검사만 가능합니다.', 'Newer project version {version}: inspection only, read-only.'],
  'state.editableCopyDetail': ['사용자가 누락 보고서를 확인하고 별도 편집 사본으로 변환했습니다. 원본 덮어쓰기는 허용되지 않습니다.', 'The user reviewed the omission report and converted to a separate editable copy. Overwriting the original is not allowed.'],
  'state.saveMismatch': ['저장 확인이 요청한 문서 상태와 일치하지 않습니다. 변경 사항을 유지합니다.', 'The save acknowledgement does not match the requested document state. Your changes are kept.'],
  'state.shutdownFailed': ['문서 정리에 실패해 종료를 중단했습니다: {reasons}', 'Document cleanup failed, so quitting was stopped: {reasons}'],
  'state.documentChanged': ['악보가 변경되었습니다. 대화상자를 다시 여세요.', 'The score changed. Open the dialog again.'],
  'command.closeChanged': ['닫기 확인 중 문서가 변경되었습니다. 다시 닫기를 선택하세요.', 'The document changed while confirming close. Choose Close again.'],
  'command.tieSelect': ['붙임줄로 연결할 음표를 선택하세요.', 'Select the notes to tie.'],
  'command.voiceSelect': ['이동할 성부를 선택하세요.', 'Select the voice to move to.'],
  'command.nextNoteSameString': ['같은 현의 다음 음표가 필요합니다.', 'A following note on the same string is required.'],
  'command.pedalSelect': ['페달 위치를 선택하세요.', 'Select the pedal position.'],
  'home.store.untitled': ['제목 없음 {index}', 'Untitled {index}'],
  'home.template.track.guitar': ['기타', 'Guitar'],
  'home.template.track.bass': ['베이스', 'Bass'],
  'home.template.track.drums': ['드럼', 'Drums'],
  'home.engine.bundled': ['alphaTab 로컬 번들', 'alphaTab local bundle'],
  'home.engine.missing': ['alphaTab 번들 없음', 'alphaTab bundle missing'],
} as const satisfies MessageTable;
