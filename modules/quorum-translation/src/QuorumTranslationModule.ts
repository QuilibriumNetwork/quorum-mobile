import { NativeModule, requireOptionalNativeModule } from 'expo-modules-core';

/**
 * QuorumTranslation native module interface.
 *
 * All operations are fully on-device:
 *  - iOS: NaturalLanguage (NLLanguageRecognizer) for detection; the Apple
 *    Translation framework for translation, gated to iOS 18.0+.
 *  - Android: ML Kit Language Identification + Translation.
 *
 * The ONLY network access is the one-time language-model download inside
 * `ensureModel`. Post/message text never leaves the device.
 */
export interface QuorumTranslationModule extends NativeModule {
  /**
   * Whether on-device translation is usable on this build/OS.
   * iOS: true only on iOS 18.0+. Android: true when ML Kit is present.
   */
  isTranslationAvailable(): Promise<boolean>;

  /**
   * Detect the dominant language of `text`. Returns the best-guess BCP-47 /
   * ISO-639 code plus a 0–1 confidence (or { language: "und", confidence: 0 }
   * when nothing can be guessed). Callers apply their own confidence floor for
   * auto-display, but can still use the best guess for a forced translation.
   */
  detectLanguage(text: string): Promise<{ language: string; confidence: number }>;

  /**
   * Ensure the language pack for source→target is downloaded and ready.
   * Resolves `true` when ready, `false` on failure (e.g. no network on
   * first use). Never rejects for the offline case.
   */
  ensureModel(source: string, target: string): Promise<boolean>;

  /**
   * Translate `text` from `source` to `target`, on-device. Assumes the
   * model is ready (call `ensureModel` first). Returns the translated text.
   */
  translate(text: string, source: string, target: string): Promise<string>;
}

// Optional: returns null on a build/platform without the native module, so
// the feature degrades to "unavailable" instead of throwing at import.
export default requireOptionalNativeModule<QuorumTranslationModule>('QuorumTranslation');
