/**
 * Curated target languages for the "Translate to…" picker — the common
 * intersection supported by both Apple's Translation framework (iOS 18) and
 * ML Kit. Codes are ISO-639 primary subtags, matching how `useTranslatable`
 * normalizes detected/target languages.
 */
export interface TranslateLanguage {
  code: string;
  name: string;
}

export const TRANSLATE_LANGUAGES: TranslateLanguage[] = [
  { code: 'ar', name: 'Arabic' },
  { code: 'zh', name: 'Chinese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'hi', name: 'Hindi' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'es', name: 'Spanish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'vi', name: 'Vietnamese' },
];

/** Human-readable name for a language code, falling back to the code itself. */
export function languageName(code: string): string {
  const primary = code.split('-')[0].toLowerCase();
  return TRANSLATE_LANGUAGES.find((l) => l.code === primary)?.name ?? code;
}
