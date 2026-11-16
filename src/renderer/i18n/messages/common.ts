import type { MessageTable } from '../index';

export const commonMessages = {
  'common.cancel': ['취소', 'Cancel'],
  'common.close': ['닫기', 'Close'],
  'common.apply': ['적용', 'Apply'],
  'common.ok': ['확인', 'OK'],
  'common.untitled': ['제목 없음', 'Untitled'],
  'common.none': ['없음', 'None'],
  'common.menu': ['메뉴', 'Menu'],
} as const satisfies MessageTable;
