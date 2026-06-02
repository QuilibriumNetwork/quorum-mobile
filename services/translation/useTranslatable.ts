/**
 * useTranslatable — drives the "See translation"/"See original" affordance for
 * a single piece of text (a cast body or a chat message).
 *
 * Flow:
 *  1. Lazily detect the text's language (after mount, length-gated, cached).
 *  2. If it differs from the user's target language (with enough confidence),
 *     expose `showToggle`.
 *  3. On `toggle()` — or a "Translate" request from a context menu — ensure the
 *     model (downloading) then translate (translating) on-device, cache it, and
 *     swap `displayText` in place. Toggling again returns to the original.
 *
 * "Translate anyway" (the menu path) works even when the toggle wasn't auto-
 * shown: it uses the best-guess detected language as the source, so short or
 * misdetected text can still be translated.
 *
 * All work is on-device; the only network use is the one-time model download.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMMKVString } from 'react-native-mmkv';
import {
  translationPrefsStore,
  K_TARGET_LANGUAGE,
  resolveTarget,
} from './translationPrefs';
import {
  detectLanguage,
  ensureModel,
  translate,
  UNDETERMINED,
  type Detection,
} from 'quorum-translation';
import {
  hashText,
  getCachedDetection,
  setCachedDetection,
  getCachedTranslation,
  setCachedTranslation,
} from './translationCache';
import { ensureAvailabilityProbed } from './availability';
import { subscribeForce } from './forceTranslate';

export type TranslateState =
  | 'original'
  | 'downloading'
  | 'translating'
  | 'translated'
  | 'error';

/** Below this length detection is unreliable / not worth a bridge call — for
 *  Latin-script text. Dense scripts (see below) carry a full message in 1–3
 *  characters, so the gate doesn't apply to them. */
const MIN_LENGTH = 8;
/** Confidence floor for *auto*-offering the toggle (forced translate ignores). */
const MIN_CONFIDENCE = 0.55;

/** Scripts where a 1–3 char string is a complete, unambiguously-detectable
 *  message (CJK, Hangul, Kana, Thai, …). The character-count min length is
 *  Latin-centric and would wrongly hide the toggle on e.g. a 2-char 中文 chat. */
const DENSE_SCRIPT_RE =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟᄀ-ᇿ가-힯฀-๿]/;

/** Whether `text` clears the length gate (dense scripts bypass it). */
function longEnough(text: string): boolean {
  return text.length >= MIN_LENGTH || DENSE_SCRIPT_RE.test(text);
}

/** Compare on the primary subtag so "zh-Hans" matches a "zh" target. */
function primary(code: string): string {
  return code.split('-')[0].toLowerCase();
}

export interface Translatable {
  /** Whether to render the toggle beneath the text. */
  showToggle: boolean;
  /** The text to display — translated when toggled on, else the original. */
  displayText: string;
  state: TranslateState;
  /** Link label for the current state. */
  label: string;
  /** Extra error copy (only meaningful when state === 'error'). */
  errorText?: string;
  /** Toggle between original and translated. */
  toggle: () => void;
}

export function useTranslatable(rawText: string, enabled: boolean): Translatable {
  const [storedTarget] = useMMKVString(K_TARGET_LANGUAGE, translationPrefsStore);
  const target = primary(resolveTarget(storedTarget));

  const [state, setState] = useState<TranslateState>('original');
  const [translated, setTranslated] = useState<string | null>(null);
  const [showToggle, setShowToggle] = useState(false);

  const mountedRef = useRef(true);
  const detectedRef = useRef<Detection | null>(null);
  const stateRef = useRef<TranslateState>('original');
  stateRef.current = state;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Resolve detection for `text` (cache-first; de-dupes concurrent identical
  // detections by storing the in-flight promise).
  const detectOnce = useCallback(async (text: string, h: number): Promise<Detection> => {
    const entry = getCachedDetection(h);
    if (entry && !(entry instanceof Promise)) return entry;
    if (entry) return entry; // in-flight promise
    const p = detectLanguage(text).catch(() => ({ language: UNDETERMINED, confidence: 0 }));
    setCachedDetection(h, p);
    const result = await p;
    setCachedDetection(h, result);
    return result;
  }, []);

  // Translate `rawText` now (used by both the toggle and the menu "translate
  // anyway"). Self-contained: detects a source if needed.
  const runTranslate = useCallback(async () => {
    const text = (rawText ?? '').trim();
    if (!text) return;
    if (stateRef.current === 'downloading' || stateRef.current === 'translating') return;

    const h = hashText(text);
    const cached = getCachedTranslation(h, target);
    if (cached != null) {
      setTranslated(cached);
      setShowToggle(true);
      setState('translated');
      return;
    }

    if (!(await ensureAvailabilityProbed())) return;

    let det = detectedRef.current;
    if (!det) {
      det = await detectOnce(text, h);
      detectedRef.current = det;
    }
    const source = det.language && det.language !== UNDETERMINED ? primary(det.language) : '';
    if (!source) {
      setShowToggle(true);
      setState('error');
      return;
    }

    try {
      setShowToggle(true);
      setState('downloading');
      const ready = await ensureModel(source, target);
      if (!mountedRef.current) return;
      if (!ready) {
        setState('error');
        return;
      }
      setState('translating');
      const out = await translate(text, source, target);
      setCachedTranslation(h, target, out);
      if (!mountedRef.current) return;
      setTranslated(out);
      setState('translated');
    } catch {
      if (mountedRef.current) setState('error');
    }
  }, [rawText, target, detectOnce]);

  // Keep a stable ref so the force subscription always calls the latest closure.
  const runTranslateRef = useRef(runTranslate);
  runTranslateRef.current = runTranslate;

  // Lazy auto-detection — decides whether to *offer* the toggle.
  useEffect(() => {
    setState('original');
    setTranslated(null);
    setShowToggle(false);
    detectedRef.current = null;

    const text = (rawText ?? '').trim();
    if (!enabled || !longEnough(text)) return;

    let cancelled = false;
    (async () => {
      if (!(await ensureAvailabilityProbed())) return;
      const h = hashText(text);
      const det = await detectOnce(text, h);
      if (cancelled || !mountedRef.current) return;
      detectedRef.current = det;
      if (
        det.language !== UNDETERMINED &&
        det.confidence >= MIN_CONFIDENCE &&
        primary(det.language) !== target
      ) {
        const cached = getCachedTranslation(h, target);
        if (cached != null) setTranslated(cached);
        setShowToggle(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rawText, target, enabled, detectOnce]);

  // Subscribe to context-menu "Translate" requests for this exact text.
  useEffect(() => {
    if (!enabled) return;
    const text = (rawText ?? '').trim();
    if (!text) return;
    return subscribeForce(hashText(text), () => {
      runTranslateRef.current();
    });
  }, [rawText, enabled]);

  const toggle = useCallback(() => {
    if (stateRef.current === 'translated') {
      setState('original');
      return;
    }
    runTranslateRef.current();
  }, []);

  const displayText = state === 'translated' && translated != null ? translated : rawText;

  let label: string;
  switch (state) {
    case 'downloading':
      label = 'Downloading…';
      break;
    case 'translating':
      label = 'Translating…';
      break;
    case 'translated':
      label = 'See original';
      break;
    case 'error':
      label = 'Translation failed';
      break;
    default:
      label = 'See translation';
  }

  return {
    showToggle,
    displayText,
    state,
    label,
    errorText: state === 'error' ? 'Couldn’t translate. Tap to retry.' : undefined,
    toggle,
  };
}
