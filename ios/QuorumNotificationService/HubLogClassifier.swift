//
//  HubLogClassifier.swift
//  QuorumNotificationService
//
//  Fetches a hub-log entry by seq via REST, decrypts it using TR state
//  the main app mirrors into the App Group MMKV, and returns the
//  inner Message.content.type. The Notification Service Extension
//  uses this to suppress notifications for control-type messages
//  that shouldn't surface to the user — currently update-profile,
//  edit-message, and remove-message.
//
//  Status: DRAFT. This file is written without an Xcode build loop;
//  expect to iterate when wiring it into the build. See
//  README-NSE-LINKING.md in this folder for the linking work
//  required to make this compile.
//
//  Threading: the entry point is synchronous-looking but the REST
//  call uses a semaphore so the NSE's 30s budget governs it. Do NOT
//  call from the main thread of the host app (it's only invoked
//  inside didReceive, which runs on the NSE's own thread).
//
//  Failure mode: ANY failure returns nil ("don't know"), and the
//  caller falls through to the normal catalog-rewrite path. The
//  extension never crashes — the worst case is showing a
//  notification we'd have preferred to hide.
//

import Foundation
import MMKV
import CryptoKit
// The uniffi-generated channel.swift is shipped as its own pod
// (QuorumChannelFFI) so the NSE can link it without dragging in
// ExpoModulesCore. Importing the pod exposes `decryptInboxMessage`,
// `tripleRatchetDecrypt`, and the TripleRatchetStateAndEnvelope type.
import QuorumChannelFFI

/// Content types whose notifications should be suppressed.
private let SuppressedContentTypes: Set<String> = [
    "update-profile",
    "edit-message",
    "remove-message",
]

private let appGroupId = "group.com.quilibrium.quorum-mobile.shared"
private let encryptionMMKVId = "quorum-encryption"
private let spacesMMKVId = "quorum-spaces"
// Same mmapID the JS side uses in services/notifications/notificationPrefs.ts.
// The store is mirrored into App Group via createMirroredMMKV, so this is
// the only place the NSE reads user mute preferences from.
private let prefsMMKVId = "quorum-notification-prefs"
private let prefsGlobalKey = "global:enabled"
private let prefsSpacePrefix = "space:"
private let prefsChannelPrefix = "channel:"

// API base URL is now passed in by the caller (NotificationService),
// read from the shared notification catalog's `api_base_url` field
// written by the JS side via writeNotificationCatalog. This keeps the
// NSE in sync with the JS dev/prod toggle automatically — no
// Info.plist entry needed.

/// Open the App Group mirror for an MMKV store. Returns nil if the
/// App Group container isn't reachable (entitlement missing in a
/// build, etc.).
private func openAppGroupMMKV(_ mmapID: String) -> MMKV? {
    guard let containerURL = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    else { return nil }
    let rootPath = containerURL.appendingPathComponent("mmkv").path
    // Ensure MMKV is initialized once per process. NSE has its own
    // process so this runs independently of the host app.
    MMKVInitializer.initialize(rootDir: rootPath)
    return MMKV(mmapID: mmapID, cryptKey: nil, rootPath: rootPath)
}

private enum MMKVInitializer {
    private static var didInit = false
    private static let lock = NSLock()
    static func initialize(rootDir: String) {
        lock.lock()
        defer { lock.unlock() }
        guard !didInit else { return }
        MMKV.initialize(rootDir: rootDir)
        didInit = true
    }
}

// MARK: - Public entry point

/// Returns the inner Message.content.type for the hub-log entry at
/// `(hubAddress, seq)`, or nil if any step fails. Wrapper around
/// `classifyHubLogEntryFull` for callers that don't need
/// space/channel IDs.
public func classifyHubLogEntry(apiBase: URL, hubAddress: String, seq: UInt64) -> String? {
    return classifyHubLogEntryFull(apiBase: apiBase, hubAddress: hubAddress, seq: seq)?.contentType
}

/// Full classification: decrypts the entry and extracts contentType,
/// channelId, and spaceId so the NSE can apply content-type
/// suppression AND per-space / per-channel mute in a single pass.
/// Returns nil on any failure.
public func classifyHubLogEntryFull(apiBase: URL, hubAddress: String, seq: UInt64) -> HubLogClassification? {
    // 1. Find the spaceId for this hub by scanning the spaces store.
    //    The main app maintains a hub→space mapping via the
    //    quorum-spaces MMKV; we look it up here so the NSE doesn't
    //    have to talk to the main app.
    guard let spaceId = lookupSpaceIdForHub(hubAddress: hubAddress) else { return nil }

    // 2. Read the hub private key + config private key from the
    //    spaces MMKV. These are stored as part of the SpaceKey
    //    structure keyed by spaceId.
    guard let hubKey = lookupSpaceKey(spaceId: spaceId, kind: "hub") else { return nil }
    let configKey = lookupSpaceKey(spaceId: spaceId, kind: "config")

    // 3. Read the per-space TR state from the encryption MMKV.
    guard let (trState, _) = lookupTRState(spaceId: spaceId) else { return nil }

    // 4. Fetch the sealed entry over REST.
    guard let entry = fetchHubLogEntry(apiBase: apiBase, hubAddress: hubAddress, seq: seq) else {
        return nil
    }

    // 5. Parse the sealed envelope.
    guard let sealedData = entry.payload.data(using: .utf8),
          let sealed = (try? JSONSerialization.jsonObject(with: sealedData)) as? [String: Any],
          let ephemeralPubKeyHex = sealed["ephemeral_public_key"] as? String,
          let envelopeStr = sealed["envelope"] as? String
    else { return nil }

    // 6. Derive the X448 private key the same way the main app does:
    //    if configPrivateKey is present, use it directly; otherwise
    //    SHA-512(hubPrivateKey) and take the first 56 bytes.
    let x448PrivateKey: [UInt8]
    if let cfg = configKey, !cfg.isEmpty {
        x448PrivateKey = cfg
    } else {
        x448PrivateKey = Array(sha512(hubKey).prefix(56))
    }

    // 7. Unseal the hub envelope via the Rust binding's
    //    decryptInboxMessage (same primitive used for inbox seals —
    //    X448 ECDH + AES-GCM). Input is a JSON string the Rust side
    //    accepts.
    let ephemeralPubKey = hexToBytes(ephemeralPubKeyHex)
    guard let envelopeData = envelopeStr.data(using: .utf8),
          let envelopeJson = (try? JSONSerialization.jsonObject(with: envelopeData)) as? [String: Any]
    else { return nil }

    let unsealInput: [String: Any] = [
        "inbox_private_key": bytesToBase64(x448PrivateKey),
        "ephemeral_public_key": bytesToBase64(ephemeralPubKey),
        "ciphertext": envelopeJson,
    ]
    guard let unsealInputData = try? JSONSerialization.data(withJSONObject: unsealInput),
          let unsealInputStr = String(data: unsealInputData, encoding: .utf8)
    else { return nil }

    let unsealResult = decryptInboxMessage(input: unsealInputStr)
    guard let unsealedBytes = decodeBase64BytesField(unsealResult),
          let unsealedPayload = String(data: unsealedBytes, encoding: .utf8),
          let payloadData = unsealedPayload.data(using: .utf8),
          let payload = (try? JSONSerialization.jsonObject(with: payloadData)) as? [String: Any],
          let payloadType = payload["type"] as? String
    else { return nil }

    // 8. Two shapes: "message" wraps a TR envelope, "control" is
    //    plaintext control content. For our suppression use we only
    //    care about the "message" path (control messages aren't
    //    user-facing anyway).
    guard payloadType == "message" else { return nil }

    // Pre-TR shortcut: if the message field is already a parsed
    // Message object (envelope-only encryption, no TR layer), pull
    // content.type directly.
    if let msgObj = payload["message"] as? [String: Any],
       let content = msgObj["content"] as? [String: Any] {
        let typ = content["type"] as? String
        let channelId = msgObj["channelId"] as? String
        return HubLogClassification(contentType: typ, channelId: channelId, spaceId: spaceId)
    }

    // 9. Extract the TR envelope string and decrypt with the current
    //    TR state.
    let trEnvelope: String
    if let s = payload["message"] as? String {
        trEnvelope = s
    } else if let o = payload["message"],
              let d = try? JSONSerialization.data(withJSONObject: o),
              let s = String(data: d, encoding: .utf8) {
        trEnvelope = s
    } else {
        return nil
    }

    do {
        let stateAndEnvelope = TripleRatchetStateAndEnvelope(
            ratchetState: trState,
            envelope: trEnvelope
        )
        let result = try tripleRatchetDecrypt(ratchetStateAndEnvelope: stateAndEnvelope)
        guard let plaintext = String(data: Data(result.message), encoding: .utf8),
              let plaintextData = plaintext.data(using: .utf8),
              let parsed = (try? JSONSerialization.jsonObject(with: plaintextData)) as? [String: Any]
        else { return nil }
        let typ = (parsed["content"] as? [String: Any])?["type"] as? String
        let channelId = parsed["channelId"] as? String
        return HubLogClassification(contentType: typ, channelId: channelId, spaceId: spaceId)
    } catch {
        return nil
    }
}

/// Decrypt + classify result mirroring the TS HubLogClassification.
public struct HubLogClassification {
    public let contentType: String?
    public let channelId: String?
    public let spaceId: String?
}

/// Global notifications enabled? Defaults to true when unset.
/// Cheap to call from didReceive before any other work — short-circuits
/// the whole NSE path when the user has turned notifications off.
public func isGloballyMuted() -> Bool {
    guard let mmkv = openAppGroupMMKV(prefsMMKVId) else { return false }
    if !mmkv.contains(key: prefsGlobalKey) { return false }
    return !mmkv.bool(forKey: prefsGlobalKey)
}

/// True iff this push corresponds to a content type we should hide,
/// OR the user has muted this space/channel in prefs.
///
/// The space-level mute is checked FIRST and from the hub address
/// alone — it needs only the local hub→space lookup, no decryption —
/// so a muted space suppresses even when classification (REST fetch +
/// decrypt) fails. Channel-level mute and content-type suppression
/// need the decrypted entry and share a single classify pass.
public func shouldSuppressHubLogPush(apiBase: URL, hubAddress: String, seq: UInt64) -> Bool {
    let prefs = openAppGroupMMKV(prefsMMKVId)

    if let prefs = prefs, let spaceId = lookupSpaceIdForHub(hubAddress: hubAddress) {
        let k = prefsSpacePrefix + spaceId
        if prefs.contains(key: k) && !prefs.bool(forKey: k) { return true }
    }

    guard let cls = classifyHubLogEntryFull(apiBase: apiBase, hubAddress: hubAddress, seq: seq) else {
        return false
    }
    if let t = cls.contentType, SuppressedContentTypes.contains(t) {
        return true
    }
    if let prefs = prefs, let s = cls.spaceId, let c = cls.channelId {
        let k = prefsChannelPrefix + s + ":" + c
        if prefs.contains(key: k) && !prefs.bool(forKey: k) {
            return true
        }
    }
    return false
}

// MARK: - MMKV lookups

/// Iterate the spaces MMKV to find which space has a hub matching
/// the given address. The main app's spaceStorage.ts stores each
/// SpaceKey as a flat JSON record under "space_key:<spaceId>:<keyId>"
/// (the Space record itself, under "space:<spaceId>", carries no
/// keys), so we scan the hub-key records and compare their `address`.
private func lookupSpaceIdForHub(hubAddress: String) -> String? {
    guard let mmkv = openAppGroupMMKV(spacesMMKVId) else { return nil }
    let keys = (mmkv.allKeys() as? [String]) ?? []
    let prefix = "space_key:"
    let suffix = ":hub"
    for k in keys {
        guard k.hasPrefix(prefix), k.hasSuffix(suffix) else { continue }
        guard let recordStr = mmkv.string(forKey: k),
              let data = recordStr.data(using: .utf8),
              let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let addr = record["address"] as? String
        else { continue }
        if addr == hubAddress {
            return String(k.dropFirst(prefix.count).dropLast(suffix.count))
        }
    }
    return nil
}

/// Read a SpaceKey (hub / config / inbox) for the given space from
/// its "space_key:<spaceId>:<keyId>" record. Returns the private key
/// bytes, or nil if missing.
private func lookupSpaceKey(spaceId: String, kind: String) -> [UInt8]? {
    guard let mmkv = openAppGroupMMKV(spacesMMKVId) else { return nil }
    guard let recordStr = mmkv.string(forKey: "space_key:\(spaceId):\(kind)"),
          let data = recordStr.data(using: .utf8),
          let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let privHex = record["privateKey"] as? String,
          !privHex.isEmpty
    else { return nil }
    return hexToBytes(privHex)
}

/// Read the per-space TR state from the encryption MMKV.
/// Conversation ID for a space is "<spaceId>/<spaceId>"; we read the
/// first encryption state and unwrap any nested template/evals
/// wrapper.
private func lookupTRState(spaceId: String) -> (state: String, isNested: Bool)? {
    guard let mmkv = openAppGroupMMKV(encryptionMMKVId) else { return nil }
    let convId = "\(spaceId)/\(spaceId)"
    // Try the conv_inboxes index first; fall back to scanning.
    let inboxIds: [String]
    if let listJson = mmkv.string(forKey: "conv_inboxes:\(convId)"),
       let listData = listJson.data(using: .utf8),
       let arr = (try? JSONSerialization.jsonObject(with: listData)) as? [String] {
        inboxIds = arr
    } else {
        // Scan
        let prefix = "enc_state:\(convId):"
        let all = (mmkv.allKeys() as? [String]) ?? []
        inboxIds = all.compactMap { k -> String? in
            guard k.hasPrefix(prefix), !k.hasSuffix(":fallback") else { return nil }
            return String(k.dropFirst(prefix.count))
        }
    }
    guard let inboxId = inboxIds.first else { return nil }
    guard let stored = mmkv.string(forKey: "enc_state:\(convId):\(inboxId)") else { return nil }
    // The state may be wrapped in {state: "...", template: ..., evals: ...}.
    if let data = stored.data(using: .utf8),
       let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
        if let inner = parsed["state"] as? String {
            return (inner, true)
        }
    }
    return (stored, false)
}

// MARK: - REST fetch

private struct HubLogEntry {
    let seq: UInt64
    let ts: Int64
    let payload: String
}

/// Synchronous-via-semaphore GET of the hub log entry. Uses a 10s
/// timeout to stay well under the NSE's 30s execution budget.
private func fetchHubLogEntry(apiBase: URL, hubAddress: String, seq: UInt64) -> HubLogEntry? {
    let after = seq > 0 ? seq - 1 : 0
    var components = URLComponents(
        url: apiBase.appendingPathComponent("/hub/\(hubAddress)/log"),
        resolvingAgainstBaseURL: false
    )
    components?.queryItems = [
        URLQueryItem(name: "after", value: String(after)),
        URLQueryItem(name: "limit", value: "1"),
    ]
    guard let url = components?.url else { return nil }

    var req = URLRequest(url: url)
    req.timeoutInterval = 10
    req.httpMethod = "GET"

    let sem = DispatchSemaphore(value: 0)
    var outEntry: HubLogEntry?
    let task = URLSession.shared.dataTask(with: req) { data, _, _ in
        defer { sem.signal() }
        guard let data = data,
              let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]],
              let first = arr.first
        else { return }
        // Server returns payload as raw JSON (HubSealedMessage marshaled
        // by the Go side); the field may be a string or a nested
        // dictionary depending on encoding. Normalize to a string.
        let payloadStr: String
        if let s = first["payload"] as? String {
            payloadStr = s
        } else if let o = first["payload"],
                  let d = try? JSONSerialization.data(withJSONObject: o),
                  let s = String(data: d, encoding: .utf8) {
            payloadStr = s
        } else {
            return
        }
        let seq = (first["seq"] as? UInt64) ?? UInt64((first["seq"] as? NSNumber)?.uint64Value ?? 0)
        let ts = (first["ts"] as? Int64) ?? Int64((first["ts"] as? NSNumber)?.int64Value ?? 0)
        outEntry = HubLogEntry(seq: seq, ts: ts, payload: payloadStr)
    }
    task.resume()
    _ = sem.wait(timeout: .now() + 10)
    return outEntry
}

// MARK: - Small helpers

private func sha512(_ bytes: [UInt8]) -> [UInt8] {
    return Array(CryptoKit.SHA512.hash(data: Data(bytes)))
}

private func hexToBytes(_ hex: String) -> [UInt8] {
    var bytes: [UInt8] = []
    bytes.reserveCapacity(hex.count / 2)
    var idx = hex.startIndex
    while idx < hex.endIndex {
        let next = hex.index(idx, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
        guard let byte = UInt8(hex[idx..<next], radix: 16) else { return [] }
        bytes.append(byte)
        idx = next
    }
    return bytes
}

private func bytesToBase64(_ bytes: [UInt8]) -> String {
    return Data(bytes).base64EncodedString()
}

/// The Rust decryptInboxMessage returns a JSON string with either a
/// base64 `message` field (new format) or an int-array field (legacy).
/// Decode either into raw bytes.
private func decodeBase64BytesField(_ jsonStr: String) -> Data? {
    guard let data = jsonStr.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return nil }
    if let s = obj["message"] as? String, let decoded = Data(base64Encoded: s) {
        return decoded
    }
    if let arr = obj["message"] as? [Int] {
        return Data(arr.map { UInt8($0) })
    }
    return nil
}

