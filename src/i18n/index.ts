/**
 * Global trilingual i18n core.
 *
 * One source of truth for `language`: it lives in useAACStore (Zustand +
 * AsyncStorage persistence, see useAACStore.ts), so the language survives
 * restarts and every subscriber re-renders the instant it changes — no app
 * restart required.
 *
 * Usage:
 *   const { t, language, setLanguage } = useTranslation();
 *   <Text>{t('settings.language')}</Text>
 *   <Text>{t('aac.greeting', { name: nickname })}</Text>
 */
import { useAACStore } from '../store/useAACStore';
import type { AppLanguage } from '../store/useAACStore';
import { id, type TranslationKey } from './locales/id';
import { en } from './locales/en';
import { zh } from './locales/zh';

type LocaleDict = Record<TranslationKey, string>;

const locales: Record<AppLanguage, LocaleDict> = { id, en, zh };

/** Shared selector metadata — used by every language entry point. */
export const LANGUAGES: ReadonlyArray<{ code: AppLanguage; label: string; flag: string }> = [
  { code: 'id', label: 'Indonesia', flag: '🇮🇩' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'zh', label: 'Mandarin (中文)', flag: '🇨🇳' },
];

export type TranslationParams = Record<string, string | number>;

/** Non-hook accessor for imperative code (e.g. outside React render). */
export function translate(
  lang: AppLanguage,
  key: TranslationKey,
  params?: TranslationParams
): string {
  let text = locales[lang][key] ?? id[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
    }
  }
  return text;
}

/** Reactive hook — re-renders on language switch without an app restart. */
export function useTranslation() {
  const language = useAACStore((s) => s.language);
  const setLanguage = useAACStore((s) => s.setLanguage);
  const t = (key: TranslationKey, params?: TranslationParams) =>
    translate(language, key, params);
  return { t, language, setLanguage };
}

export type { AppLanguage, TranslationKey };