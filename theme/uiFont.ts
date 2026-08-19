/**
 * Registers the app's bundled UI font (Inter) with the platform font manager.
 *
 * Must be awaited BEFORE the first paint, or text renders in the platform font
 * for a frame and then reflows when Inter arrives — the same constraint the
 * skin font loader documents.
 *
 * Why five separate files rather than one variable font (as desktop uses):
 * React Native cannot drive a variable font's weight axis. Expo's docs state
 * that "variable fonts ... do not have support across all platforms" and to
 * "use static fonts" instead. Each weight is therefore its own family name —
 * see INTER_FACES, which is the single source of those names.
 *
 * Imported from per-weight subpaths on purpose: the package ships 18 faces and
 * Metro only bundles what is reachable, so this keeps the other 13 out of the
 * app.
 */

import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { Inter_900Black } from '@expo-google-fonts/inter/900Black';
import { logger } from '@quilibrium/quorum-shared';
import * as Font from 'expo-font';

import { INTER_FACES } from './fonts';

const FACES: Record<string, number> = {
  [INTER_FACES.regular]: Inter_400Regular,
  [INTER_FACES.medium]: Inter_500Medium,
  [INTER_FACES.semiBold]: Inter_600SemiBold,
  [INTER_FACES.bold]: Inter_700Bold,
  [INTER_FACES.heavy]: Inter_900Black,
};

let loaded = false;

/**
 * Idempotent. Resolves (rather than rejects) on failure: a missing font must
 * never block launch, because React Native falls back to the platform font,
 * which is exactly what shipped before Inter existed here.
 *
 * The timing log is deliberate. Font loading sits on the launch critical path,
 * and the cost is a local file read plus registration — fast in a release build
 * where the faces live in the app bundle, but noticeably slower in dev, where
 * Metro serves them over the network. Without a number in the log those two
 * cases are indistinguishable from "the app got slower".
 */
export async function ensureUiFontLoaded(): Promise<void> {
  if (loaded || Font.isLoaded(INTER_FACES.regular)) {
    loaded = true;
    return;
  }
  const startedAt = Date.now();
  try {
    await Font.loadAsync(FACES);
    loaded = true;
    logger.info(`[uiFont] Inter (5 faces) loaded in ${Date.now() - startedAt}ms`);
  } catch (e) {
    logger.warn('[uiFont] Inter load failed, falling back to the platform font:', e instanceof Error ? e.message : e);
  }
}
