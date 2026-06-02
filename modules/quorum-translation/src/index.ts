/**
 * QuorumTranslation — on-device language detection + translation.
 *
 * Privacy: detection and translation run entirely on-device. The only network
 * access is the one-time language-model download in `ensureModel`. Post and
 * message text never leaves the device.
 *
 * All wrappers are null-safe: if the native module isn't present (e.g. an
 * older OS or a build without it), they degrade quietly — `isTranslationAvailable`
 * resolves false and the UI hides the affordance.
 */

import QuorumTranslation from './QuorumTranslationModule';

export type { QuorumTranslationModule } from './QuorumTranslationModule';

/** "und" = undetermined; matches both NL and ML Kit conventions. */
export const UNDETERMINED = 'und';

export interface Detection {
  /** Best-guess BCP-47/ISO-639 code, or "und". */
  language: string;
  /** 0–1 confidence in the guess. */
  confidence: number;
}

export async function isTranslationAvailable(): Promise<boolean> {
  if (!QuorumTranslation) return false;
  try {
    return await QuorumTranslation.isTranslationAvailable();
  } catch {
    return false;
  }
}

export async function detectLanguage(text: string): Promise<Detection> {
  if (!QuorumTranslation) return { language: UNDETERMINED, confidence: 0 };
  try {
    const r = await QuorumTranslation.detectLanguage(text);
    return { language: r?.language ?? UNDETERMINED, confidence: r?.confidence ?? 0 };
  } catch {
    return { language: UNDETERMINED, confidence: 0 };
  }
}

export async function ensureModel(source: string, target: string): Promise<boolean> {
  if (!QuorumTranslation) return false;
  try {
    return await QuorumTranslation.ensureModel(source, target);
  } catch {
    return false;
  }
}

/**
 * Translate on-device. Throws if the native call fails so callers can show a
 * retryable error state (the model-download path is handled separately by
 * `ensureModel`, which never throws).
 */
export async function translate(text: string, source: string, target: string): Promise<string> {
  if (!QuorumTranslation) throw new Error('translation_unavailable');
  return QuorumTranslation.translate(text, source, target);
}

export default QuorumTranslation;
