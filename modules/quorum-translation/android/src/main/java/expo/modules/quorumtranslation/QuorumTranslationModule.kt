package expo.modules.quorumtranslation

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import com.google.mlkit.nl.languageid.LanguageIdentification
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import com.google.mlkit.common.model.DownloadConditions

/**
 * On-device language detection + translation via ML Kit.
 *
 * Privacy: detection and translation run fully on-device. The only network
 * access is the one-time per-language model download in `ensureModel`.
 * Detection works back to minSdk; translation models are cached by ML Kit
 * (offline after first download).
 */
class QuorumTranslationModule : Module() {
    private val scope = CoroutineScope(Dispatchers.Default)

    /** Reuse translators per source→target so repeated translations are cheap. */
    private val translators = HashMap<String, Translator>()

    private fun translatorFor(source: String, target: String): Translator? {
        val src = TranslateLanguage.fromLanguageTag(source) ?: return null
        val tgt = TranslateLanguage.fromLanguageTag(target) ?: return null
        val key = "$src:$tgt"
        return translators.getOrPut(key) {
            Translation.getClient(
                TranslatorOptions.Builder()
                    .setSourceLanguage(src)
                    .setTargetLanguage(tgt)
                    .build()
            )
        }
    }

    override fun definition() = ModuleDefinition {
        Name("QuorumTranslation")

        // ML Kit translation is available on Android (models download on demand).
        AsyncFunction("isTranslationAvailable") { promise: Promise ->
            promise.resolve(true)
        }

        // On-device language detection. Returns the best-guess BCP-47 code +
        // confidence (JS applies its own floor for auto-display but can use the
        // guess for a forced translation).
        AsyncFunction("detectLanguage") { text: String, promise: Promise ->
            scope.launch {
                try {
                    val client = LanguageIdentification.getClient()
                    val possible = client.identifyPossibleLanguages(text).await()
                    val top = possible.firstOrNull { it.languageTag != "und" }
                    if (top == null) {
                        promise.resolve(mapOf("language" to "und", "confidence" to 0.0))
                    } else {
                        promise.resolve(
                            mapOf("language" to top.languageTag, "confidence" to top.confidence.toDouble())
                        )
                    }
                } catch (e: Exception) {
                    promise.resolve(mapOf("language" to "und", "confidence" to 0.0))
                }
            }
        }

        // Download/prepare the model for source→target. Resolves false on
        // failure (e.g. offline first-use) rather than rejecting.
        AsyncFunction("ensureModel") { source: String, target: String, promise: Promise ->
            scope.launch {
                try {
                    val translator = translatorFor(source, target)
                    if (translator == null) {
                        promise.resolve(false)
                        return@launch
                    }
                    translator.downloadModelIfNeeded(DownloadConditions.Builder().build()).await()
                    promise.resolve(true)
                } catch (e: Exception) {
                    promise.resolve(false)
                }
            }
        }

        // Translate on-device. Ensures the model is present first (no-op if
        // already downloaded), then translates.
        AsyncFunction("translate") { text: String, source: String, target: String, promise: Promise ->
            scope.launch {
                try {
                    val translator = translatorFor(source, target)
                    if (translator == null) {
                        promise.reject("translate_unavailable", "Unsupported language pair.", null)
                        return@launch
                    }
                    translator.downloadModelIfNeeded(DownloadConditions.Builder().build()).await()
                    val result = translator.translate(text).await()
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("translate_failed", e.localizedMessage ?: "Translation failed.", e)
                }
            }
        }
    }
}
