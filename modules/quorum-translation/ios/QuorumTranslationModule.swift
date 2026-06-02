import ExpoModulesCore
import NaturalLanguage
import UIKit
import SwiftUI
#if canImport(Translation)
import Translation
#endif

// MARK: - Headless translation host (iOS 18+)
//
// Apple's `TranslationSession` is only delivered through SwiftUI's
// `.translationTask` modifier. To use it from a headless native module we
// mount a 1×1, fully-transparent SwiftUI view carrying that modifier into the
// key window; when the task fires we run the work and resume a continuation,
// then tear the host down.
#if canImport(Translation)
@available(iOS 18.0, *)
private struct TranslatorHostView: View {
    let configuration: TranslationSession.Configuration
    let action: (TranslationSession) async -> Void

    var body: some View {
        Color.clear
            .translationTask(configuration) { session in
                await action(session)
            }
    }
}
#endif

public class QuorumTranslationModule: Module {
    /// Retains hosting controllers while their async work is in flight
    /// (main-thread only). Keyed by an incrementing token.
    private var retainedHosts: [Int: UIViewController] = [:]
    private var hostToken = 0

    public func definition() -> ModuleDefinition {
        Name("QuorumTranslation")

        // Apple's programmatic translation API is iOS 18.0+. Detection works
        // earlier, but without translation the affordance is pointless, so we
        // report availability on the translation capability.
        AsyncFunction("isTranslationAvailable") { (promise: Promise) in
            if #available(iOS 18.0, *) {
                promise.resolve(true)
            } else {
                promise.resolve(false)
            }
        }

        // On-device language detection — NaturalLanguage, iOS 12+. Headless.
        // Returns the best guess + confidence; the JS layer applies its own
        // floor for auto-display but can still use the guess for a forced
        // translation.
        AsyncFunction("detectLanguage") { (text: String, promise: Promise) in
            let recognizer = NLLanguageRecognizer()
            recognizer.processString(text)
            guard let language = recognizer.dominantLanguage else {
                promise.resolve(["language": "und", "confidence": 0.0])
                return
            }
            let hypotheses = recognizer.languageHypotheses(withMaximum: 1)
            let confidence = hypotheses[language] ?? 0
            promise.resolve(["language": language.rawValue, "confidence": confidence])
        }

        // Download/prepare the language assets for source→target.
        AsyncFunction("ensureModel") { (source: String, target: String, promise: Promise) in
            if #available(iOS 18.0, *) {
                self.runTranslation(source: source, target: target, texts: [], prepareOnly: true) { result in
                    switch result {
                    case .success:
                        promise.resolve(true)
                    case .failure:
                        // Offline-on-first-use etc. — never reject for this.
                        promise.resolve(false)
                    }
                }
            } else {
                promise.resolve(false)
            }
        }

        // Translate a single string on-device.
        AsyncFunction("translate") { (text: String, source: String, target: String, promise: Promise) in
            if #available(iOS 18.0, *) {
                self.runTranslation(source: source, target: target, texts: [text], prepareOnly: false) { result in
                    switch result {
                    case .success(let outputs):
                        promise.resolve(outputs.first ?? text)
                    case .failure(let error):
                        promise.reject("translate_failed", error.localizedDescription)
                    }
                }
            } else {
                promise.reject("translate_unavailable", "On-device translation requires iOS 18 or later.")
            }
        }
    }

    // MARK: - Translation driver

    #if canImport(Translation)
    @available(iOS 18.0, *)
    private func runTranslation(
        source: String,
        target: String,
        texts: [String],
        prepareOnly: Bool,
        completion: @escaping (Result<[String], Error>) -> Void
    ) {
        DispatchQueue.main.async {
            guard let window = Self.keyWindow(), let root = window.rootViewController else {
                completion(.failure(NSError(domain: "QuorumTranslation", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "No window to host translation."])))
                return
            }

            let token = self.hostToken
            self.hostToken += 1

            // Resolve exactly once, then tear down the host.
            var settled = false
            let finish: (Result<[String], Error>) -> Void = { [weak self] result in
                DispatchQueue.main.async {
                    guard let self = self, !settled else { return }
                    settled = true
                    if let host = self.retainedHosts.removeValue(forKey: token) {
                        host.willMove(toParent: nil)
                        host.view.removeFromSuperview()
                        host.removeFromParent()
                    }
                    completion(result)
                }
            }

            let sourceLang = Locale.Language(identifier: source)
            let targetLang = Locale.Language(identifier: target)
            let config = TranslationSession.Configuration(source: sourceLang, target: targetLang)

            let view = TranslatorHostView(configuration: config) { session in
                do {
                    if prepareOnly {
                        try await session.prepareTranslation()
                        finish(.success([]))
                    } else {
                        let requests = texts.enumerated().map { (index, value) in
                            TranslationSession.Request(sourceText: value, clientIdentifier: String(index))
                        }
                        let responses = try await session.translations(from: requests)
                        // Response order isn't guaranteed — restore input order.
                        let ordered = responses
                            .sorted { (Int($0.clientIdentifier ?? "0") ?? 0) < (Int($1.clientIdentifier ?? "0") ?? 0) }
                            .map { $0.targetText }
                        finish(.success(ordered))
                    }
                } catch {
                    finish(.failure(error))
                }
            }

            let host = UIHostingController(rootView: view)
            host.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
            host.view.alpha = 0.0
            host.view.isUserInteractionEnabled = false
            self.retainedHosts[token] = host
            root.addChild(host)
            root.view.addSubview(host.view)
            host.didMove(toParent: root)

            // Safety net: if the translation task never fires (e.g. assets
            // unavailable and no callback), don't leak the host forever.
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                finish(.failure(NSError(domain: "QuorumTranslation", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Translation timed out."])))
            }
        }
    }
    #else
    @available(iOS 18.0, *)
    private func runTranslation(
        source: String,
        target: String,
        texts: [String],
        prepareOnly: Bool,
        completion: @escaping (Result<[String], Error>) -> Void
    ) {
        completion(.failure(NSError(domain: "QuorumTranslation", code: 3,
            userInfo: [NSLocalizedDescriptionKey: "Translation framework unavailable."])))
    }
    #endif

    private static func keyWindow() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first { $0.isKeyWindow } ?? windows.first
    }
}
