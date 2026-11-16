import { expect, it } from 'vitest';
import { normalizeCommandError } from '../../src/renderer/state/command-errors';
import { DocumentStore } from '../../src/renderer/state/documents';

it.each([
  ["Error invoking remote method 'desktop:save-project': ExternalChangeError: EXTERNAL_CHANGE: 파일이 외부에서 변경되었습니다.", '파일이 외부에서 변경되었습니다.', 'EXTERNAL_CHANGE'],
  ['Error invoking remote method "desktop:save-project": StorageError: DESTINATION: 저장 위치를 선택하세요.', '저장 위치를 선택하세요.', 'DESTINATION'],
  ['StorageError: CHECKSUM: 복구 자료가 손상되었습니다.', '복구 자료가 손상되었습니다.', 'CHECKSUM'],
  ['EACCES: 저장 권한이 없습니다.', '저장 권한이 없습니다.', 'EACCES'],
  ['변경 사항을 유지합니다.', '변경 사항을 유지합니다.', null],
])('presents the reason while retaining diagnostics for %s', (original, message, code) => {
  expect(normalizeCommandError(original)).toEqual({ message, code, original });
});

it('publishes a clean command error and its code, then clears both on dismissal', () => {
  const store = new DocumentStore();
  store.setError("Error invoking remote method 'desktop:save-project': ExternalChangeError: EXTERNAL_CHANGE: 다른 이름으로 저장하세요.");
  expect(store.getSnapshot()).toMatchObject({ error: '다른 이름으로 저장하세요.', errorCode: 'EXTERNAL_CHANGE' });
  store.setError(null);
  expect(store.getSnapshot()).toMatchObject({ error: null, errorCode: null });
});
