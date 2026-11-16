import { useSyncExternalStore } from 'react';
import type { Language } from '../../main/settings';
import { getLanguage, subscribeLanguage } from './language';
import { t } from './index';

export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage);
}

export function useT(): typeof t {
  useLanguage();
  return t;
}
