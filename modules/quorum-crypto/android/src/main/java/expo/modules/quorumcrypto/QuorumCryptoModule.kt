package expo.modules.quorumcrypto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import uniffi.channel.*
import org.json.JSONObject
import org.json.JSONArray
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.security.MessageDigest
import com.tencent.mmkv.MMKV
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat

class QuorumCryptoModule : Module() {
    // Coroutine scope for background crypto operations to avoid blocking UI thread
    private val cryptoScope = CoroutineScope(Dispatchers.Default)

    companion object {
        const val CALL_CHANNEL_ID = "incoming_calls"
        const val CALL_NOTIFICATION_ID = 9001
        // Static reference so BroadcastReceiver can reach the module
        @Volatile
        var instance: QuorumCryptoModule? = null
    }

    // Track active call IDs
    private val activeCallIds = mutableSetOf<String>()

    private fun ensureCallNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val context = appContext.reactContext ?: return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CALL_CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CALL_CHANNEL_ID,
                    "Incoming Calls",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Notifications for incoming voice and video calls"
                    setSound(null, null) // We handle ringtone separately
                    enableVibration(true)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                }
                manager.createNotificationChannel(channel)
            }
        }
    }

    private fun showIncomingCallNotification(callId: String, callerName: String, hasVideo: Boolean) {
        val context = appContext.reactContext ?: return
        ensureCallNotificationChannel()

        // Accept intent
        val acceptIntent = Intent(context, QuorumCallActionReceiver::class.java).apply {
            action = "com.quilibrium.quorum.ACCEPT_CALL"
            putExtra("callId", callId)
        }
        val acceptPending = PendingIntent.getBroadcast(
            context, 0, acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Decline intent
        val declineIntent = Intent(context, QuorumCallActionReceiver::class.java).apply {
            action = "com.quilibrium.quorum.DECLINE_CALL"
            putExtra("callId", callId)
        }
        val declinePending = PendingIntent.getBroadcast(
            context, 1, declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Full-screen intent to open app
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val fullScreenPending = if (launchIntent != null) {
            PendingIntent.getActivity(
                context, 2, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        } else null

        val callType = if (hasVideo) "Video" else "Voice"
        val notification = NotificationCompat.Builder(context, CALL_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle("Incoming $callType Call")
            .setContentText(callerName)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(false)
            .addAction(android.R.drawable.ic_menu_call, "Accept", acceptPending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", declinePending)
            .apply {
                if (fullScreenPending != null) {
                    setFullScreenIntent(fullScreenPending, true)
                }
            }
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(CALL_NOTIFICATION_ID, notification)
    }

    private fun dismissCallNotification() {
        val context = appContext.reactContext ?: return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(CALL_NOTIFICATION_ID)
    }

    fun handleCallAction(action: String, callId: String) {
        sendEvent("onCallAction", mapOf(
            "action" to action,
            "callId" to callId
        ))
    }

    override fun definition() = ModuleDefinition {
        Name("QuorumCrypto")

        // Declare events that can be sent from native to JS
        Events("onCallAction")

        // MARK: - Call Integration (Android)
        //
        // Shows incoming call notifications with accept/decline actions.

        AsyncFunction("reportIncomingCall") { callId: String, callerName: String, hasVideo: Boolean, promise: Promise ->
            instance = this@QuorumCryptoModule
            activeCallIds.add(callId)
            showIncomingCallNotification(callId, callerName, hasVideo)
            promise.resolve(true)
        }

        AsyncFunction("reportOutgoingCall") { callId: String, calleeName: String, hasVideo: Boolean, promise: Promise ->
            instance = this@QuorumCryptoModule
            activeCallIds.add(callId)
            // Android doesn't need a special outgoing call notification — the
            // in-app overlay handles it. Just track the call.
            promise.resolve(true)
        }

        AsyncFunction("reportOutgoingCallConnected") { callId: String, promise: Promise ->
            // No-op on Android — the overlay handles the transition
            promise.resolve(activeCallIds.contains(callId))
        }

        AsyncFunction("reportCallConnected") { callId: String, promise: Promise ->
            // Dismiss the incoming call notification now that the call is active
            if (activeCallIds.contains(callId)) {
                dismissCallNotification()
            }
            promise.resolve(activeCallIds.contains(callId))
        }

        AsyncFunction("reportCallEnded") { callId: String, promise: Promise ->
            activeCallIds.remove(callId)
            dismissCallNotification()
            promise.resolve(true)
        }

        // Audio session — iOS uses prepareAudioSession/releaseAudioSession
        // for the AVAudioSession lifecycle around a call; on Android the
        // WebRTC native module owns mode/focus, but the loudspeaker
        // toggle is exposed here for parity with iOS so the call UI's
        // speaker button works on both platforms.
        //
        // setSpeakerphoneOn switches the active audio output between the
        // earpiece (default for voice-call mode) and the loudspeaker.
        // No-op if AudioManager isn't reachable — speaker control is a
        // UX nice-to-have, not load-bearing.
        // Start the foreground call service. JS calls this once the
        // call has been answered/connected so Android keeps the WebRTC
        // pipeline alive when the user backgrounds the app. Without
        // this the OS suspends the process within seconds and the
        // call dies. Safe to call multiple times — the service handles
        // re-issued startForeground correctly.
        AsyncFunction("startCallService") { callId: String, displayName: String, hasVideo: Boolean, promise: Promise ->
            try {
                val ctx = appContext.reactContext ?: run {
                    promise.resolve(false)
                    return@AsyncFunction
                }
                val intent = Intent(ctx, QuorumCallService::class.java).apply {
                    putExtra(QuorumCallService.EXTRA_DISPLAY_NAME, displayName)
                    putExtra(QuorumCallService.EXTRA_HAS_VIDEO, hasVideo)
                    // callId carried for potential future notification action
                    // targeting; not currently used in the service itself.
                    putExtra("callId", callId)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(intent)
                } else {
                    ctx.startService(intent)
                }
                promise.resolve(true)
            } catch (e: Exception) {
                android.util.Log.w("QuorumCrypto", "startCallService failed", e)
                promise.resolve(false)
            }
        }

        // Stop the foreground call service. Idempotent — calling
        // stopService when the service isn't running is a no-op.
        AsyncFunction("stopCallService") { promise: Promise ->
            try {
                val ctx = appContext.reactContext ?: run {
                    promise.resolve(false)
                    return@AsyncFunction
                }
                ctx.stopService(Intent(ctx, QuorumCallService::class.java))
                promise.resolve(true)
            } catch (e: Exception) {
                android.util.Log.w("QuorumCrypto", "stopCallService failed", e)
                promise.resolve(false)
            }
        }

        AsyncFunction("setSpeakerphoneEnabled") { enabled: Boolean, promise: Promise ->
            try {
                val ctx = appContext.reactContext
                val am = ctx?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                if (am == null) {
                    promise.resolve(false)
                    return@AsyncFunction
                }
                // Force IN_COMMUNICATION mode so the speakerphone setting
                // applies to the call audio rather than the (currently
                // possibly NORMAL) system audio profile. WebRTC sets this
                // itself during a call but we set it again defensively —
                // a no-op if already correct.
                am.mode = AudioManager.MODE_IN_COMMUNICATION
                am.isSpeakerphoneOn = enabled
                promise.resolve(true)
            } catch (e: Exception) {
                android.util.Log.w("QuorumCrypto", "setSpeakerphoneEnabled failed", e)
                promise.resolve(false)
            }
        }

        // Key Generation
        AsyncFunction("generateX448") { promise: Promise ->
            cryptoScope.launch {
                val result = generateX448()
                promise.resolve(result)
            }
        }

        AsyncFunction("generateEd448") { promise: Promise ->
            cryptoScope.launch {
                val result = generateEd448()
                promise.resolve(result)
            }
        }

        AsyncFunction("getPublicKeyX448") { privateKey: String, promise: Promise ->
            cryptoScope.launch {
                if (privateKey.isEmpty()) {
                    promise.resolve("error: empty private key")
                } else {
                    promise.resolve(getPubkeyX448(privateKey))
                }
            }
        }

        AsyncFunction("getPublicKeyEd448") { privateKey: String, promise: Promise ->
            cryptoScope.launch {
                if (privateKey.isEmpty()) {
                    promise.resolve("error: empty private key")
                } else {
                    promise.resolve(getPubkeyEd448(privateKey))
                }
            }
        }

        // Signing
        AsyncFunction("signEd448") { privateKey: String, message: String, promise: Promise ->
            cryptoScope.launch {
                if (privateKey.isEmpty()) {
                    promise.resolve("error: empty private key")
                } else {
                    promise.resolve(signEd448(privateKey, message))
                }
            }
        }

        AsyncFunction("verifyEd448") { publicKey: String, message: String, signature: String, promise: Promise ->
            cryptoScope.launch {
                if (publicKey.isEmpty() || signature.isEmpty()) {
                    promise.resolve("error: empty public key or signature")
                } else {
                    promise.resolve(verifyEd448(publicKey, message, signature))
                }
            }
        }

        // Inbox Message Encryption
        AsyncFunction("encryptInboxMessage") { input: String, promise: Promise ->
            cryptoScope.launch {
                if (input.isEmpty()) {
                    promise.resolve("error: empty input")
                } else {
                    promise.resolve(encryptInboxMessage(input))
                }
            }
        }

        AsyncFunction("decryptInboxMessage") { input: String, promise: Promise ->
            cryptoScope.launch {
                if (input.isEmpty()) {
                    promise.resolve("error: empty input")
                } else {
                    promise.resolve(decryptInboxMessage(input))
                }
            }
        }

        // X3DH Key Agreement
        AsyncFunction("senderX3dh") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val sendingIdentityPrivateKey = jsonArrayToUByteList(json.getJSONArray("sending_identity_private_key"))
                    val sendingEphemeralPrivateKey = jsonArrayToUByteList(json.getJSONArray("sending_ephemeral_private_key"))
                    val receivingIdentityKey = jsonArrayToUByteList(json.getJSONArray("receiving_identity_key"))
                    val receivingSignedPreKey = jsonArrayToUByteList(json.getJSONArray("receiving_signed_pre_key"))
                    val sessionKeyLength = json.getLong("session_key_length").toULong()

                    // Validate key lengths
                    if (sendingIdentityPrivateKey.isEmpty() ||
                        sendingEphemeralPrivateKey.isEmpty() ||
                        receivingIdentityKey.isEmpty() ||
                        receivingSignedPreKey.isEmpty() ||
                        sessionKeyLength == 0UL) {
                        promise.resolve("error: invalid key lengths")
                        return@launch
                    }

                    promise.resolve(senderX3dh(
                        sendingIdentityPrivateKey,
                        sendingEphemeralPrivateKey,
                        receivingIdentityKey,
                        receivingSignedPreKey,
                        sessionKeyLength
                    ))
                } catch (e: Exception) {
                    promise.resolve("invalid input")
                }
            }
        }

        AsyncFunction("receiverX3dh") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val sendingIdentityPrivateKey = jsonArrayToUByteList(json.getJSONArray("sending_identity_private_key"))
                    val sendingSignedPrivateKey = jsonArrayToUByteList(json.getJSONArray("sending_signed_private_key"))
                    val receivingIdentityKey = jsonArrayToUByteList(json.getJSONArray("receiving_identity_key"))
                    val receivingEphemeralKey = jsonArrayToUByteList(json.getJSONArray("receiving_ephemeral_key"))
                    val sessionKeyLength = json.getLong("session_key_length").toULong()

                    // Validate key lengths
                    if (sendingIdentityPrivateKey.isEmpty() ||
                        sendingSignedPrivateKey.isEmpty() ||
                        receivingIdentityKey.isEmpty() ||
                        receivingEphemeralKey.isEmpty() ||
                        sessionKeyLength == 0UL) {
                        promise.resolve("error: invalid key lengths")
                        return@launch
                    }

                    promise.resolve(receiverX3dh(
                        sendingIdentityPrivateKey,
                        sendingSignedPrivateKey,
                        receivingIdentityKey,
                        receivingEphemeralKey,
                        sessionKeyLength
                    ))
                } catch (e: Exception) {
                    promise.resolve("invalid input")
                }
            }
        }

        // Double Ratchet
        AsyncFunction("newDoubleRatchet") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val sessionKey = jsonArrayToUByteList(json.getJSONArray("session_key"))
                    val sendingHeaderKey = jsonArrayToUByteList(json.getJSONArray("sending_header_key"))
                    val nextReceivingHeaderKey = jsonArrayToUByteList(json.getJSONArray("next_receiving_header_key"))
                    val isSender = json.getBoolean("is_sender")
                    val sendingEphemeralPrivateKey = jsonArrayToUByteList(json.getJSONArray("sending_ephemeral_private_key"))
                    val receivingEphemeralKey = jsonArrayToUByteList(json.getJSONArray("receiving_ephemeral_key"))

                    // Validate key lengths
                    if (sessionKey.isEmpty() ||
                        sendingHeaderKey.isEmpty() ||
                        nextReceivingHeaderKey.isEmpty() ||
                        sendingEphemeralPrivateKey.isEmpty() ||
                        receivingEphemeralKey.isEmpty()) {
                        promise.resolve("error: invalid key lengths")
                        return@launch
                    }

                    promise.resolve(newDoubleRatchet(
                        sessionKey,
                        sendingHeaderKey,
                        nextReceivingHeaderKey,
                        isSender,
                        sendingEphemeralPrivateKey,
                        receivingEphemeralKey
                    ))
                } catch (e: Exception) {
                    promise.resolve("invalid input")
                }
            }
        }

        AsyncFunction("doubleRatchetEncrypt") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val ratchetState = json.getString("ratchet_state")
                    // Strict JSON-int-array — matches iOS doubleRatchetEncrypt
                    // which reads `message` as `[Int]`. Diverging here while
                    // chasing a regression masks shape mismatches; keep
                    // platforms symmetric and surface failures via the
                    // explicit catches below.
                    val message = jsonArrayToUByteList(json.getJSONArray("message"))

                    // Validate ratchet state is not empty
                    if (ratchetState.isEmpty()) {
                        promise.resolve("{\"ratchet_state\":\"\",\"envelope\":\"error: empty ratchet state\"}")
                        return@launch
                    }

                    val stateAndMessage = DoubleRatchetStateAndMessage(ratchetState, message)
                    val result = doubleRatchetEncrypt(stateAndMessage)

                    promise.resolve(serializeStateAndEnvelope(result.ratchetState, result.envelope))
                } catch (e: CryptoException) {
                    android.util.Log.e("QuorumCrypto", "doubleRatchetEncrypt CryptoException: ${e.message}", e)
                    promise.resolve("{\"ratchet_state\":\"\",\"envelope\":\"\",\"error\":\"${cryptoExceptionMessage(e)}\"}")
                } catch (e: Exception) {
                    // Before this change Kotlin returned `{"ratchet_state":"","envelope":"invalid input"}`
                    // with no `error` field, hiding the actual failure from
                    // both logcat and JS. iOS already includes the error
                    // string via .localizedDescription — match that.
                    android.util.Log.e("QuorumCrypto", "doubleRatchetEncrypt Exception: ${e.message}", e)
                    promise.resolve("{\"ratchet_state\":\"\",\"envelope\":\"\",\"error\":\"encryption failed: ${e.message?.replace("\"", "'")}\"}")
                }
            }
        }

        AsyncFunction("doubleRatchetDecrypt") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val ratchetState = json.getString("ratchet_state")
                    val envelope = json.getString("envelope")

                    // Validate ratchet state and envelope are not empty
                    if (ratchetState.isEmpty()) {
                        promise.resolve("{\"ratchet_state\":\"\",\"message\":[],\"error\":\"empty ratchet state\"}")
                        return@launch
                    }
                    if (envelope.isEmpty()) {
                        promise.resolve("{\"ratchet_state\":\"\",\"message\":[],\"error\":\"empty envelope\"}")
                        return@launch
                    }

                    val stateAndEnvelope = DoubleRatchetStateAndEnvelope(ratchetState, envelope)
                    val result = doubleRatchetDecrypt(stateAndEnvelope)

                    promise.resolve(serializeStateAndMessage(result.ratchetState, result.message))
                } catch (e: CryptoException) {
                    android.util.Log.e("QuorumCrypto", "doubleRatchetDecrypt CryptoException: ${e.message}", e)
                    promise.resolve("{\"ratchet_state\":\"\",\"message\":[],\"error\":\"${cryptoExceptionMessage(e)}\"}")
                } catch (e: Exception) {
                    android.util.Log.e("QuorumCrypto", "doubleRatchetDecrypt Exception: ${e.message}", e)
                    promise.resolve("{\"ratchet_state\":\"\",\"message\":[],\"error\":\"decrypt failed: ${e.message?.replace("\"", "'")}\"}")
                }
            }
        }

        // Triple Ratchet
        AsyncFunction("newTripleRatchet") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val peersArray = json.getJSONArray("peers")
                    val peers = mutableListOf<List<UByte>>()
                    for (i in 0 until peersArray.length()) {
                        peers.add(jsonArrayToUByteList(peersArray.getJSONArray(i)))
                    }
                    val peerKey = jsonArrayToUByteList(json.getJSONArray("peer_key"))
                    val identityKey = jsonArrayToUByteList(json.getJSONArray("identity_key"))
                    val signedPreKey = jsonArrayToUByteList(json.getJSONArray("signed_pre_key"))
                    val threshold = json.getLong("threshold").toULong()
                    val asyncDkgRatchet = json.getBoolean("async_dkg_ratchet")

                    // Validate inputs
                    if (peers.isEmpty() ||
                        peerKey.isEmpty() ||
                        identityKey.isEmpty() ||
                        signedPreKey.isEmpty() ||
                        threshold == 0UL) {
                        promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{},\"error\":\"invalid inputs\"}")
                        return@launch
                    }

                    val result = newTripleRatchet(peers, peerKey, identityKey, signedPreKey, threshold, asyncDkgRatchet)
                    promise.resolve(serializeTripleRatchetStateAndMetadata(result))
                } catch (e: Exception) {
                    promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{}}")
                }
            }
        }

        AsyncFunction("tripleRatchetInitRound1") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val stateAndMetadata = parseTripleRatchetStateAndMetadata(input)
                    if (stateAndMetadata == null) {
                        promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{}}")
                        return@launch
                    }

                    if (stateAndMetadata.ratchetState.isEmpty()) {
                        promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{},\"error\":\"empty ratchet state\"}")
                        return@launch
                    }

                    val result = tripleRatchetInitRound1(stateAndMetadata)
                    promise.resolve(serializeTripleRatchetStateAndMetadata(result))
                } catch (e: CryptoException) {
                    promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{},\"error\":\"${cryptoExceptionMessage(e)}\"}")
                } catch (e: Exception) {
                    promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{}}")
                }
            }
        }

        AsyncFunction("tripleRatchetInitRound2") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val stateAndMetadata = parseTripleRatchetStateAndMetadata(input)
                    if (stateAndMetadata == null) {
                        promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{}}")
                        return@launch
                    }

                    if (stateAndMetadata.ratchetState.isEmpty()) {
                        promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{},\"error\":\"empty ratchet state\"}")
                        return@launch
                    }

                    val result = tripleRatchetInitRound2(stateAndMetadata)
                    promise.resolve(serializeTripleRatchetStateAndMetadata(result))
                } catch (e: CryptoException) {
                    promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{},\"error\":\"${cryptoExceptionMessage(e)}\"}")
                } catch (e: Exception) {
                    promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{}}")
                }
            }
        }

        AsyncFunction("tripleRatchetInitRound3") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val stateAndMetadata = parseTripleRatchetStateAndMetadata(input)
                    if (stateAndMetadata == null) {
                        promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{}}")
                        return@launch
                    }

                    if (stateAndMetadata.ratchetState.isEmpty()) {
                        promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{},\"error\":\"empty ratchet state\"}")
                        return@launch
                    }

                    val result = tripleRatchetInitRound3(stateAndMetadata)
                    promise.resolve(serializeTripleRatchetStateAndMetadata(result))
                } catch (e: CryptoException) {
                    promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{},\"error\":\"${cryptoExceptionMessage(e)}\"}")
                } catch (e: Exception) {
                    promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{}}")
                }
            }
        }

        AsyncFunction("tripleRatchetInitRound4") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val stateAndMetadata = parseTripleRatchetStateAndMetadata(input)
                    if (stateAndMetadata == null) {
                        promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{}}")
                        return@launch
                    }

                    if (stateAndMetadata.ratchetState.isEmpty()) {
                        promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{},\"error\":\"empty ratchet state\"}")
                        return@launch
                    }

                    val result = tripleRatchetInitRound4(stateAndMetadata)
                    promise.resolve(serializeTripleRatchetStateAndMetadata(result))
                } catch (e: CryptoException) {
                    promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{},\"error\":\"${cryptoExceptionMessage(e)}\"}")
                } catch (e: Exception) {
                    promise.resolve("{\"ratchet_state\":\"\",\"metadata\":{}}")
                }
            }
        }

        AsyncFunction("tripleRatchetEncrypt") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val ratchetState = json.getString("ratchet_state")
                    // Strict — matches iOS tripleRatchetEncrypt reading
                    // `message` as `[Int]`. Don't widen this while debugging
                    // a regression; differences here would hide the bug.
                    val message = jsonArrayToUByteList(json.getJSONArray("message"))

                    if (ratchetState.isEmpty()) {
                        promise.resolve("{\"ratchet_state\":\"\",\"envelope\":\"\",\"error\":\"empty ratchet state\"}")
                        return@launch
                    }

                    val stateAndMessage = TripleRatchetStateAndMessage(ratchetState, message)
                    val result = tripleRatchetEncrypt(stateAndMessage)

                    promise.resolve(serializeStateAndEnvelope(result.ratchetState, result.envelope))
                } catch (e: CryptoException) {
                    android.util.Log.e("QuorumCrypto", "tripleRatchetEncrypt CryptoException: ${e.message}", e)
                    promise.resolve("{\"ratchet_state\":\"\",\"envelope\":\"\",\"error\":\"${cryptoExceptionMessage(e)}\"}")
                } catch (e: Exception) {
                    // Before this change the generic Exception catch
                    // returned `{"ratchet_state":"","envelope":""}` with no
                    // error field, which JS treats as a successful decrypt
                    // of an empty envelope. iOS already includes the error
                    // string — match that.
                    android.util.Log.e("QuorumCrypto", "tripleRatchetEncrypt Exception: ${e.message}", e)
                    promise.resolve("{\"ratchet_state\":\"\",\"envelope\":\"\",\"error\":\"encryption failed: ${e.message?.replace("\"", "'")}\"}")
                }
            }
        }

        AsyncFunction("tripleRatchetDecrypt") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val ratchetState = json.getString("ratchet_state")
                    val envelope = json.getString("envelope")

                    if (ratchetState.isEmpty()) {
                        promise.resolve("{\"ratchet_state\":\"\",\"message\":[],\"error\":\"empty ratchet state\"}")
                        return@launch
                    }
                    if (envelope.isEmpty()) {
                        promise.resolve("{\"ratchet_state\":\"\",\"message\":[],\"error\":\"empty envelope\"}")
                        return@launch
                    }

                    val stateAndEnvelope = TripleRatchetStateAndEnvelope(ratchetState, envelope)
                    val result = tripleRatchetDecrypt(stateAndEnvelope)

                    promise.resolve(serializeStateAndMessage(result.ratchetState, result.message))
                } catch (e: CryptoException) {
                    android.util.Log.e("QuorumCrypto", "tripleRatchetDecrypt CryptoException: ${e.message}", e)
                    promise.resolve("{\"ratchet_state\":\"\",\"message\":[],\"error\":\"${cryptoExceptionMessage(e)}\"}")
                } catch (e: Exception) {
                    android.util.Log.e("QuorumCrypto", "tripleRatchetDecrypt Exception: ${e.message}", e)
                    promise.resolve("{\"ratchet_state\":\"\",\"message\":[],\"error\":\"decrypt failed: ${e.message?.replace("\"", "'")}\"}")
                }
            }
        }

        // Batch Unseal Envelopes - processes multiple sealed messages in one native call
        // Eliminates N JS-native bridge crossings for N messages
        AsyncFunction("batchUnsealEnvelopes") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val hubPrivateKeyArray = json.getJSONArray("hub_private_key")
                    val messagesArray = json.getJSONArray("messages")

                    // Derive X448 private key ONCE for the whole batch
                    val x448PrivateKey: ByteArray
                    if (json.has("config_private_key") && !json.isNull("config_private_key")) {
                        val configArray = json.getJSONArray("config_private_key")
                        x448PrivateKey = ByteArray(configArray.length()) { configArray.getInt(it).toByte() }
                    } else {
                        // SHA-512 of hub private key, take first 56 bytes for X448
                        val hubKeyBytes = ByteArray(hubPrivateKeyArray.length()) { hubPrivateKeyArray.getInt(it).toByte() }
                        val sha512 = MessageDigest.getInstance("SHA-512")
                        val hash = sha512.digest(hubKeyBytes)
                        x448PrivateKey = hash.copyOfRange(0, 56)
                    }

                    val x448PrivateKeyInts = x448PrivateKey.map { it.toInt() and 0xFF }

                    // Output-size safety net — mirror batchProcessMessages.
                    // Without it the final `output.toString()` materializes
                    // the entire batch's plaintext as one giant String (plus
                    // a copy during StringBuilder growth) and OOMs the JVM
                    // heap on large catch-up batches — the crash stack showed
                    // JSONStringer failing on a ~144MB allocation.
                    // Oversized messages are dropped to {error:"too_large"};
                    // JS leaves them out of the pre-unseal cache and the
                    // per-message fallback unseals them individually (see the
                    // `'plaintext' in result` gate in WebSocketContext).
                    val batchTextCap = 12 * 1024 * 1024
                    val perMessageCap = 2 * 1024 * 1024
                    var batchTextBytes = 0

                    val results = JSONArray()

                    for (i in 0 until messagesArray.length()) {
                        val msg = messagesArray.getJSONObject(i)
                        try {
                            val ephemeralPubKeyHex = msg.getString("ephemeral_public_key")
                            val envelope = msg.getString("envelope")

                            // Parse ephemeral public key from hex
                            val ephemeralPubKey = hexStringToBytes(ephemeralPubKeyHex)

                            // Parse envelope JSON
                            val envelopeJson = JSONObject(envelope)

                            // Build decryptInboxMessage input
                            val decryptInput = JSONObject().apply {
                                put("inbox_private_key", intListToBase64(x448PrivateKeyInts))
                                put("ephemeral_public_key", bytesToBase64(ephemeralPubKey))
                                put("ciphertext", envelopeJson)
                            }

                            // Call Rust decryptInboxMessage
                            val decryptResult = decryptInboxMessage(decryptInput.toString())

                            // Parse result - it's a JSON array of byte values
                            val resultObj = JSONObject()
                            try {
                                val bytes = decryptInboxBytes(decryptResult)
                                val plaintext = String(bytes, Charsets.UTF_8)
                                if (plaintext.length > perMessageCap ||
                                    batchTextBytes + plaintext.length > batchTextCap) {
                                    // Too large to bundle — drop to an error so
                                    // JS unseals this one individually.
                                    resultObj.put("error", "too_large")
                                } else {
                                    batchTextBytes += plaintext.length
                                    resultObj.put("plaintext", sanitizeForJSON(plaintext))
                                }
                            } catch (e: Exception) {
                                if (decryptResult.contains("error") || decryptResult.contains("invalid") || decryptResult.contains("failed")) {
                                    resultObj.put("error", decryptResult)
                                } else {
                                    resultObj.put("error", "unexpected decrypt result: ${decryptResult.take(100)}")
                                }
                            }
                            results.put(resultObj)
                        } catch (e: Exception) {
                            val errorObj = JSONObject()
                            errorObj.put("error", "message processing failed: ${e.message}")
                            results.put(errorObj)
                        }
                    }

                    val output = JSONObject()
                    output.put("results", results)
                    promise.resolve(output.toString())
                } catch (e: Exception) {
                    promise.resolve("{\"results\":[]}")
                }
            }
        }

        // Batch Process Messages - entire message processing loop in one native call
        AsyncFunction("batchProcessMessages") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val userAddress = json.optString("user_address", "")
                    val spaceGroupsArr = json.optJSONArray("space_groups") ?: JSONArray()
                    val dmGroupsArr = json.optJSONArray("dm_groups") ?: JSONArray()

                    val spaceResults = JSONArray()
                    val dmResultsArr = JSONArray()

                    // Output-size safety net for the batch result. The
                    // final `JSONObject.toString()` materializes the
                    // entire batch as one String + a copy; without a
                    // cap, a 30MB decrypt-batch would need ~120MB
                    // transient on Android's 256MB heap (the previous
                    // OOM stack trace showed JSONStringer.toString
                    // failing on a 62MB allocation).
                    //
                    // Two caps:
                    //   - 12MB total accumulated text. Higher than the
                    //     previous 6MB because the rest of the batch
                    //     overhead (envelope strings, conversation IDs,
                    //     etc.) is now smaller — base64 wire format
                    //     dropped that overhead substantially.
                    //   - 2MB per single message. A pathological 30MB
                    //     plaintext (image embed inline, etc.) won't
                    //     consume the entire budget on its own.
                    //
                    // When either cap is hit, the offending message's
                    // `decrypted_message` / `plaintext` field becomes
                    // "" and `truncated:true` is set on the top-level
                    // output. JS sees the flag and refetches the
                    // affected messages individually via the non-batch
                    // path — see `BatchProcessOutput.truncated` in
                    // native-provider.ts.
                    //
                    // Proper structural fix (eliminate cap entirely):
                    // stream each decrypted message as an Expo event
                    // instead of bundling into a single Promise return.
                    // Tracked in project_rust_binding_bytes_format.md.
                    val batchTextCap = 12 * 1024 * 1024
                    val perMessageCap = 2 * 1024 * 1024
                    var batchTextBytes = 0
                    var batchTruncated = false
                    fun addText(text: String): String {
                        if (text.length > perMessageCap ||
                            batchTextBytes + text.length > batchTextCap) {
                            batchTruncated = true
                            return ""
                        }
                        batchTextBytes += text.length
                        return sanitizeForJSON(text)
                    }

                    // ====== SPACE GROUPS ======
                    for (g in 0 until spaceGroupsArr.length()) {
                        val group = spaceGroupsArr.getJSONObject(g)
                        val spaceId = group.getString("space_id")
                        val hubPrivateKeyArr = group.getJSONArray("hub_private_key")
                        val messagesArr = group.optJSONArray("messages") ?: JSONArray()

                        val sentFingerprints = mutableSetOf<String>()
                        val sentArr = group.optJSONArray("sent_envelope_fingerprints")
                        if (sentArr != null) {
                            for (s in 0 until sentArr.length()) {
                                sentFingerprints.add(sentArr.getString(s))
                            }
                        }

                        // Derive X448 private key ONCE
                        val x448PrivateKey: ByteArray
                        if (group.has("config_private_key") && !group.isNull("config_private_key")) {
                            val configArr = group.getJSONArray("config_private_key")
                            x448PrivateKey = ByteArray(configArr.length()) { configArr.getInt(it).toByte() }
                        } else {
                            val hubKeyBytes = ByteArray(hubPrivateKeyArr.length()) { hubPrivateKeyArr.getInt(it).toByte() }
                            val sha512 = MessageDigest.getInstance("SHA-512")
                            val hash = sha512.digest(hubKeyBytes)
                            x448PrivateKey = hash.copyOfRange(0, 56)
                        }
                        val x448PrivateKeyInts = x448PrivateKey.map { it.toInt() and 0xFF }

                        var currentTRState = group.optString("tr_state", "")
                        val trFallbackState = if (group.has("tr_fallback_state") && !group.isNull("tr_fallback_state")) group.getString("tr_fallback_state") else null
                        var anyTRStateUpdated = false

                        val messageResults = JSONArray()

                        for (m in 0 until messagesArr.length()) {
                            val msg = messagesArr.getJSONObject(m)
                            val timestamp = msg.optInt("timestamp", 0)

                            val ephemeralPubKeyHex = msg.optString("ephemeral_public_key", "")
                            val envelope = msg.optString("envelope", "")

                            if (ephemeralPubKeyHex.isEmpty() || envelope.isEmpty()) {
                                messageResults.put(JSONObject().apply {
                                    put("status", "unseal_failed")
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            // Step 1: Unseal
                            val ephemeralPubKey = hexStringToBytes(ephemeralPubKeyHex)
                            val envelopeJson: JSONObject
                            try {
                                envelopeJson = JSONObject(envelope)
                            } catch (e: Exception) {
                                messageResults.put(JSONObject().apply {
                                    put("status", "unseal_failed")
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            val decryptInput = JSONObject().apply {
                                put("inbox_private_key", intListToBase64(x448PrivateKeyInts))
                                put("ephemeral_public_key", bytesToBase64(ephemeralPubKey))
                                put("ciphertext", envelopeJson)
                            }

                            val decryptResult = decryptInboxMessage(decryptInput.toString())

                            val unsealedPayload: String
                            try {
                                val bytes = decryptInboxBytes(decryptResult)
                                unsealedPayload = String(bytes, Charsets.UTF_8)
                            } catch (e: Exception) {
                                messageResults.put(JSONObject().apply {
                                    put("status", "unseal_failed")
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            // Step 2: Parse unsealed payload
                            val payload: JSONObject
                            try {
                                payload = JSONObject(unsealedPayload)
                            } catch (e: Exception) {
                                messageResults.put(JSONObject().apply {
                                    put("status", "unseal_failed")
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            val payloadType = payload.optString("type", "")

                            // Step 3: Control messages
                            if (payloadType == "control") {
                                messageResults.put(JSONObject().apply {
                                    put("status", "control")
                                    put("control_payload", addText(unsealedPayload))
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            if (payloadType != "message") {
                                messageResults.put(JSONObject().apply {
                                    put("status", "decrypt_failed")
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            // Step 4: Check if already plaintext
                            val msgObj = payload.optJSONObject("message")
                            if (msgObj != null && msgObj.has("messageId") && msgObj.has("channelId") && msgObj.has("content")) {
                                val content = msgObj.optJSONObject("content")
                                val senderId = content?.optString("senderId", "") ?: ""
                                if (senderId == userAddress) {
                                    messageResults.put(JSONObject().apply {
                                        put("status", "self_echo")
                                        put("timestamp", timestamp)
                                    })
                                    continue
                                }
                                messageResults.put(JSONObject().apply {
                                    put("status", "plaintext")
                                    put("decrypted_message", addText(msgObj.toString()))
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            // Step 5: Get TR envelope
                            val trEnvelope: String
                            val msgStr = payload.optString("message", "")
                            if (msgStr.isNotEmpty() && (msgStr.startsWith("{") || msgStr.startsWith("\""))) {
                                trEnvelope = msgStr
                            } else if (msgObj != null) {
                                trEnvelope = msgObj.toString()
                            } else {
                                trEnvelope = msgStr
                            }

                            if (trEnvelope.isEmpty()) {
                                messageResults.put(JSONObject().apply {
                                    put("status", "decrypt_failed")
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            // Self-echo fingerprint check
                            val fingerprint = trEnvelope.take(100)
                            if (sentFingerprints.contains(fingerprint)) {
                                messageResults.put(JSONObject().apply {
                                    put("status", "self_echo")
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            // Step 6: TR decrypt
                            if (currentTRState.isEmpty()) {
                                messageResults.put(JSONObject().apply {
                                    put("status", "decrypt_failed")
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            var usedFallback = false
                            var trDecryptState: String? = null
                            var trDecryptMessage: List<UByte>? = null

                            // Try primary state
                            try {
                                val stateAndEnvelope = TripleRatchetStateAndEnvelope(currentTRState, trEnvelope)
                                val result = tripleRatchetDecrypt(stateAndEnvelope)
                                if (result.ratchetState.contains("invalid") || result.ratchetState.contains("error") || result.message.isEmpty()) {
                                    throw Exception("TR decrypt failed")
                                }
                                trDecryptState = result.ratchetState
                                trDecryptMessage = result.message
                            } catch (e: Exception) {
                                // Try fallback
                                if (trFallbackState != null && trFallbackState.isNotEmpty()) {
                                    try {
                                        val fallbackSE = TripleRatchetStateAndEnvelope(trFallbackState, trEnvelope)
                                        val fallbackResult = tripleRatchetDecrypt(fallbackSE)
                                        val lowerState = fallbackResult.ratchetState.lowercase()
                                        if (lowerState.contains("invalid") || lowerState.contains("error") || lowerState.contains("crypto error") || fallbackResult.message.isEmpty()) {
                                            throw Exception("Fallback TR decrypt failed")
                                        }
                                        trDecryptState = fallbackResult.ratchetState
                                        trDecryptMessage = fallbackResult.message
                                        usedFallback = true
                                    } catch (fe: Exception) {
                                        // Both failed
                                    }
                                }
                            }

                            if (trDecryptMessage == null || trDecryptMessage.isEmpty()) {
                                messageResults.put(JSONObject().apply {
                                    put("status", "decrypt_failed")
                                    put("timestamp", timestamp)
                                })
                                continue
                            }

                            // Update state for next message
                            if (!usedFallback && trDecryptState != null && !trDecryptState.contains("invalid") && trDecryptState.startsWith("{")) {
                                currentTRState = trDecryptState
                                anyTRStateUpdated = true
                            }

                            val decryptedBytes = ByteArray(trDecryptMessage.size) { trDecryptMessage[it].toByte() }
                            val decryptedText = String(decryptedBytes, Charsets.UTF_8)

                            // Self-echo check by senderId
                            try {
                                val decMsg = JSONObject(decryptedText)
                                val content = decMsg.optJSONObject("content")
                                val senderId = content?.optString("senderId", "") ?: ""
                                if (senderId == userAddress) {
                                    messageResults.put(JSONObject().apply {
                                        put("status", "self_echo")
                                        put("timestamp", timestamp)
                                    })
                                    continue
                                }
                            } catch (e: Exception) {
                                // Not valid JSON or missing fields - continue with message
                            }

                            messageResults.put(JSONObject().apply {
                                put("status", "decrypted")
                                put("decrypted_message", addText(decryptedText))
                                put("used_fallback", usedFallback)
                                put("timestamp", timestamp)
                            })
                        }

                        // Write updated TR state to MMKV
                        if (anyTRStateUpdated) {
                            val spaceConversationId = "$spaceId/$spaceId"
                            val existingStates = readAllEncryptionStates(spaceConversationId)
                            if (existingStates.isNotEmpty()) {
                                val first = existingStates[0]
                                val trStateIsNested = group.optBoolean("tr_state_is_nested", false)
                                if (trStateIsNested) {
                                    val origJson = readEncryptionState(spaceConversationId, first.first)
                                    if (origJson != null) {
                                        try {
                                            val origObj = JSONObject(origJson)
                                            origObj.put("state", sanitizeForJSON(currentTRState))
                                            origObj.put("timestamp", System.currentTimeMillis())
                                            writeEncryptionState(spaceConversationId, first.first, origObj.toString(), false)
                                        } catch (e: Exception) { /* ignore */ }
                                    }
                                } else {
                                    writeEncryptionState(
                                        spaceConversationId, first.first,
                                        buildEncryptionStateJson(currentTRState, spaceConversationId, first.first, false, null, null),
                                        false
                                    )
                                }
                            }
                        }

                        val groupResult = JSONObject().apply {
                            put("space_id", spaceId)
                            put("messages", messageResults)
                        }
                        spaceResults.put(groupResult)
                    }

                    // ====== DM GROUPS ======
                    for (g in 0 until dmGroupsArr.length()) {
                        val group = dmGroupsArr.getJSONObject(g)
                        val conversationId = group.getString("conversation_id")
                        val messageType = group.getString("message_type")
                        val messagesArr = group.optJSONArray("messages") ?: JSONArray()
                        val drStatesArr = group.optJSONArray("dr_states") ?: JSONArray()
                        val identityPrivateKey = group.optJSONArray("identity_private_key")
                        val preKeyPrivateKey = group.optJSONArray("pre_key_private_key")
                        val deviceInboxEncPrivateKey = group.optJSONArray("device_inbox_encryption_private_key")

                        data class DREntry(val conversationId: String, val inboxId: String, var state: String)
                        val stateList = mutableListOf<DREntry>()
                        for (s in 0 until drStatesArr.length()) {
                            val sObj = drStatesArr.getJSONObject(s)
                            stateList.add(DREntry(sObj.getString("conversation_id"), sObj.getString("inbox_id"), sObj.getString("state")))
                        }

                        val messageResults = JSONArray()
                        var newConversationInbox: String? = null

                        for (m in 0 until messagesArr.length()) {
                            val msg = messagesArr.getJSONObject(m)
                            val timestamp = msg.optInt("timestamp", 0)
                            val isDREnvelope = msg.optBoolean("is_double_ratchet_envelope", false)
                            val isInitEnvelope = msg.optBoolean("is_init_envelope", false)
                            val encryptedContent = msg.optString("encrypted_content", "")

                            if (encryptedContent.isEmpty()) {
                                messageResults.put(JSONObject().apply { put("status", "decrypt_failed"); put("timestamp", timestamp) })
                                continue
                            }

                            // ====== INIT ENVELOPE HANDLING ======
                            if (messageType == "device_inbox" && isInitEnvelope && deviceInboxEncPrivateKey != null && deviceInboxEncPrivateKey.length() > 0) {
                                val sealed: JSONObject = try { JSONObject(encryptedContent) } catch (e: Exception) {
                                    messageResults.put(JSONObject().apply { put("status", "unseal_failed"); put("timestamp", timestamp) })
                                    continue
                                }
                                val sealedEphPubKeyHex = sealed.optString("ephemeral_public_key", "")
                                val sealedEnvStr = sealed.optString("envelope", "")
                                if (sealedEphPubKeyHex.isEmpty() || sealedEnvStr.isEmpty()) {
                                    messageResults.put(JSONObject().apply { put("status", "unseal_failed"); put("timestamp", timestamp) })
                                    continue
                                }

                                // Unseal with device inbox key
                                val sealedEphPubKey = hexStringToBytes(sealedEphPubKeyHex)
                                val envJson: JSONObject = try { JSONObject(sealedEnvStr) } catch (e: Exception) {
                                    messageResults.put(JSONObject().apply { put("status", "unseal_failed"); put("timestamp", timestamp) })
                                    continue
                                }
                                val devPrivKey = (0 until deviceInboxEncPrivateKey.length()).map { deviceInboxEncPrivateKey.getInt(it) }
                                val unsealInput = JSONObject().apply {
                                    put("inbox_private_key", intListToBase64(devPrivKey))
                                    put("ephemeral_public_key", bytesToBase64(sealedEphPubKey))
                                    put("ciphertext", envJson)
                                }

                                val unsealResultStr = decryptInboxMessage(unsealInput.toString())
                                val envelope: JSONObject
                                try {
                                    val bytes = decryptInboxBytes(unsealResultStr)
                                    envelope = JSONObject(String(bytes, Charsets.UTF_8))
                                } catch (e: Exception) {
                                    messageResults.put(JSONObject().apply { put("status", "unseal_failed"); put("timestamp", timestamp) })
                                    continue
                                }

                                val senderAddress = envelope.optString("user_address", "")
                                val identityPubKeyHex = envelope.optString("identity_public_key", "")
                                val drEnvelopeStr = envelope.optString("message", "")
                                val returnInboxAddr = envelope.optString("return_inbox_address", "")
                                val returnInboxEncKey = envelope.optString("return_inbox_encryption_key", "")
                                val returnInboxPubKey = envelope.optString("return_inbox_public_key", "")
                                val displayName = if (envelope.has("display_name")) envelope.optString("display_name") else null
                                val userIcon = if (envelope.has("user_icon")) envelope.optString("user_icon") else null

                                if (senderAddress.isEmpty() || drEnvelopeStr.isEmpty()) {
                                    messageResults.put(JSONObject().apply { put("status", "unseal_failed"); put("timestamp", timestamp) })
                                    continue
                                }

                                val ephemeralPubKeyHex = sealedEphPubKeyHex
                                val initConversationId = "$senderAddress/$senderAddress"
                                var cleanEnvelope = drEnvelopeStr.replace("\\\"", "\"").replace("\\\\", "\\")

                                var decryptedMessage: String? = null
                                var finalRatchetState: String? = null
                                var usedExistingState = false
                                var existingInboxId: String? = null

                                // Check ephemeral cache
                                val cachedStateJson = readEphemeralCache(initConversationId, ephemeralPubKeyHex)
                                if (cachedStateJson != null) {
                                    try {
                                        val cachedObj = JSONObject(cachedStateJson)
                                        val cachedState = cachedObj.optString("state", "")
                                        if (cachedState.isNotEmpty()) {
                                            val se = DoubleRatchetStateAndEnvelope(cachedState, cleanEnvelope)
                                            val result = doubleRatchetDecrypt(se)
                                            val msgBytes = ByteArray(result.message.size) { result.message[it].toByte() }
                                            val msgText = String(msgBytes, Charsets.UTF_8)
                                            if (!msgText.startsWith("Decryption failed:") && !msgText.contains("aead::Error") && result.message.isNotEmpty()) {
                                                decryptedMessage = msgText
                                                finalRatchetState = result.ratchetState
                                                usedExistingState = true
                                                existingInboxId = cachedObj.optString("inboxId")
                                            }
                                        }
                                    } catch (e: Exception) { /* fall through */ }
                                }

                                // Check existing states
                                if (decryptedMessage == null) {
                                    val existingStates = readAllEncryptionStates(initConversationId)
                                    for ((esInboxId, esStateJson) in existingStates) {
                                        try {
                                            val esObj = JSONObject(esStateJson)
                                            val esState = esObj.optString("state", "")
                                            if (esState.isEmpty()) continue
                                            val se = DoubleRatchetStateAndEnvelope(esState, cleanEnvelope)
                                            val result = doubleRatchetDecrypt(se)
                                            val msgBytes = ByteArray(result.message.size) { result.message[it].toByte() }
                                            val msgText = String(msgBytes, Charsets.UTF_8)
                                            if (!msgText.startsWith("Decryption failed:") && !msgText.contains("aead::Error") && result.message.isNotEmpty()) {
                                                decryptedMessage = msgText
                                                finalRatchetState = result.ratchetState
                                                usedExistingState = true
                                                existingInboxId = esInboxId
                                                break
                                            }
                                        } catch (e: Exception) { continue }
                                    }
                                }

                                // Fresh X3DH
                                if (decryptedMessage == null && identityPrivateKey != null && identityPrivateKey.length() > 0 && preKeyPrivateKey != null && preKeyPrivateKey.length() > 0) {
                                    try {
                                        val idPrivKey = jsonArrayToUByteList(identityPrivateKey)
                                        val pkPrivKey = jsonArrayToUByteList(preKeyPrivateKey)
                                        val senderIdKey = hexStringToBytes(identityPubKeyHex).map { (it.toInt() and 0xFF).toUByte() }
                                        val senderEphKey = hexStringToBytes(ephemeralPubKeyHex).map { (it.toInt() and 0xFF).toUByte() }

                                        val x3dhResult = receiverX3dh(idPrivKey, pkPrivKey, senderIdKey, senderEphKey, 96UL)
                                        val sessionKeyStr = x3dhResult.trim('"')
                                        val sessionKeyBytes = android.util.Base64.decode(sessionKeyStr, android.util.Base64.DEFAULT)

                                        if (sessionKeyBytes.size >= 96) {
                                            val sessionKey = sessionKeyBytes.sliceArray(0 until 32).map { (it.toInt() and 0xFF).toUByte() }
                                            val sendingHeaderKey = sessionKeyBytes.sliceArray(32 until 64).map { (it.toInt() and 0xFF).toUByte() }
                                            val receivingHeaderKey = sessionKeyBytes.sliceArray(64 until 96).map { (it.toInt() and 0xFF).toUByte() }

                                            val ratchetState = newDoubleRatchet(sessionKey, sendingHeaderKey, receivingHeaderKey, false, pkPrivKey, senderEphKey)

                                            if (!ratchetState.contains("invalid") && !ratchetState.contains("error")) {
                                                val se = DoubleRatchetStateAndEnvelope(ratchetState, cleanEnvelope)
                                                val result = doubleRatchetDecrypt(se)
                                                val msgBytes = ByteArray(result.message.size) { result.message[it].toByte() }
                                                val msgText = String(msgBytes, Charsets.UTF_8)

                                                if (!msgText.startsWith("Decryption failed:") && !msgText.contains("aead::Error") && result.message.isNotEmpty()) {
                                                    decryptedMessage = msgText
                                                    finalRatchetState = result.ratchetState

                                                    // Generate keypairs
                                                    val convEncKpJson = generateX448()
                                                    val convSignKpJson = generateEd448()
                                                    val convEncKp = try { JSONObject(convEncKpJson) } catch (e: Exception) { null }
                                                    val convSignKp = try { JSONObject(convSignKpJson) } catch (e: Exception) { null }

                                                    if (convEncKp != null && convSignKp != null) {
                                                        val signPubArr = convSignKp.getJSONArray("public_key")
                                                        val signPubBytes = ByteArray(signPubArr.length()) { signPubArr.getInt(it).toByte() }
                                                        val convInboxAddress = deriveAddress(signPubBytes)

                                                        val sendingInbox = JSONObject().apply {
                                                            put("inbox_address", returnInboxAddr)
                                                            put("inbox_encryption_key", returnInboxEncKey)
                                                            put("inbox_public_key", "")
                                                            put("inbox_private_key", "")
                                                        }

                                                        val stateJson = buildEncryptionStateJson(
                                                            result.ratchetState, initConversationId, convInboxAddress, false, sendingInbox, convInboxAddress
                                                        )
                                                        writeEncryptionState(initConversationId, convInboxAddress, stateJson, true)
                                                        writeEphemeralCache(initConversationId, ephemeralPubKeyHex, stateJson)
                                                        writeInboxMapping(convInboxAddress, initConversationId)
                                                        writeInboxMapping(returnInboxAddr, initConversationId)

                                                        val keypairObj = JSONObject().apply {
                                                            put("conversationId", initConversationId)
                                                            put("inboxAddress", convInboxAddress)
                                                            put("encryptionPublicKey", convEncKp.getJSONArray("public_key"))
                                                            put("encryptionPrivateKey", convEncKp.getJSONArray("private_key"))
                                                            put("signingPublicKey", convSignKp.getJSONArray("public_key"))
                                                            put("signingPrivateKey", convSignKp.getJSONArray("private_key"))
                                                        }
                                                        writeConversationInboxKeypair(keypairObj)
                                                        newConversationInbox = convInboxAddress
                                                    }
                                                }
                                            }
                                        }
                                    } catch (e: Exception) { /* X3DH failed - likely for another device */ }
                                }

                                // Update existing state in MMKV if used
                                if (usedExistingState && finalRatchetState != null && existingInboxId != null) {
                                    val existingJson = readEncryptionState(initConversationId, existingInboxId)
                                    if (existingJson != null) {
                                        try {
                                            val existingObj = JSONObject(existingJson)
                                            existingObj.put("state", sanitizeForJSON(finalRatchetState))
                                            existingObj.put("timestamp", System.currentTimeMillis())
                                            writeEncryptionState(initConversationId, existingInboxId, existingObj.toString(), false)
                                            writeEphemeralCache(initConversationId, ephemeralPubKeyHex, existingObj.toString())
                                        } catch (e: Exception) { /* ignore */ }
                                    }
                                    val convKeypair = readConversationInboxKeypair(initConversationId)
                                    newConversationInbox = convKeypair?.optString("inboxAddress")
                                }

                                if (decryptedMessage != null) {
                                    val resultObj = JSONObject().apply {
                                        put("status", "init_decrypted")
                                        put("decrypted_message", addText(decryptedMessage!!))
                                        put("conversation_id", initConversationId)
                                        put("timestamp", timestamp)
                                        if (displayName != null || userIcon != null) {
                                            put("user_profile", JSONObject().apply {
                                                if (displayName != null) put("display_name", displayName)
                                                if (userIcon != null) put("user_icon", userIcon)
                                            })
                                        }
                                        put("return_inbox", JSONObject().apply {
                                            put("inbox_address", returnInboxAddr)
                                            put("inbox_encryption_key", returnInboxEncKey)
                                            if (returnInboxPubKey.isNotEmpty()) put("inbox_public_key", returnInboxPubKey)
                                        })
                                    }
                                    messageResults.put(resultObj)
                                } else {
                                    messageResults.put(JSONObject().apply { put("status", "decrypt_failed"); put("timestamp", timestamp) })
                                }
                                continue
                            }

                            // ====== SUBSEQUENT DR MESSAGE (device inbox) ======
                            if (messageType == "device_inbox" && isDREnvelope) {
                                val sealed: JSONObject = try { JSONObject(encryptedContent) } catch (e: Exception) {
                                    messageResults.put(JSONObject().apply { put("status", "decrypt_failed"); put("timestamp", timestamp) })
                                    continue
                                }
                                val envelopeStr = sealed.optString("envelope", "")
                                if (envelopeStr.isEmpty()) {
                                    messageResults.put(JSONObject().apply { put("status", "decrypt_failed"); put("timestamp", timestamp) })
                                    continue
                                }

                                var decrypted = false
                                for (i in stateList.indices) {
                                    val entry = stateList[i]
                                    if (entry.state.isEmpty()) continue
                                    try {
                                        val se = DoubleRatchetStateAndEnvelope(entry.state, envelopeStr)
                                        val result = doubleRatchetDecrypt(se)
                                        val msgBytes = ByteArray(result.message.size) { result.message[it].toByte() }
                                        val msgText = String(msgBytes, Charsets.UTF_8)
                                        if (msgText.startsWith("Decryption failed:") || msgText.startsWith("invalid") || msgText.contains("aead::Error") || result.message.isEmpty()) continue

                                        stateList[i] = entry.copy(state = result.ratchetState)

                                        // Write updated DR state to MMKV
                                        val existingJson = readEncryptionState(entry.conversationId, entry.inboxId)
                                        if (existingJson != null) {
                                            try {
                                                val existingObj = JSONObject(existingJson)
                                                existingObj.put("state", sanitizeForJSON(result.ratchetState))
                                                existingObj.put("timestamp", System.currentTimeMillis())
                                                writeEncryptionState(entry.conversationId, entry.inboxId, existingObj.toString(), false)
                                            } catch (e: Exception) { /* ignore */ }
                                        }

                                        messageResults.put(JSONObject().apply {
                                            put("status", "decrypted")
                                            put("decrypted_message", addText(msgText))
                                            put("used_state_inbox_id", entry.inboxId)
                                            put("conversation_id", entry.conversationId)
                                            put("timestamp", timestamp)
                                        })
                                        decrypted = true
                                        break
                                    } catch (e: Exception) { continue }
                                }
                                if (!decrypted) {
                                    messageResults.put(JSONObject().apply { put("status", "decrypt_failed"); put("timestamp", timestamp) })
                                }
                            } else if (messageType == "conversation_inbox" && isDREnvelope) {
                                val convPrivKeyArr = group.optJSONArray("conversation_inbox_private_key")
                                if (convPrivKeyArr == null || convPrivKeyArr.length() == 0) {
                                    messageResults.put(JSONObject().apply { put("status", "unseal_failed"); put("timestamp", timestamp) })
                                    continue
                                }
                                val convPrivKey = (0 until convPrivKeyArr.length()).map { convPrivKeyArr.getInt(it) }

                                val sealed: JSONObject = try { JSONObject(encryptedContent) } catch (e: Exception) {
                                    messageResults.put(JSONObject().apply { put("status", "unseal_failed"); put("timestamp", timestamp) })
                                    continue
                                }
                                val ephPubKeyHex = sealed.optString("ephemeral_public_key", "")
                                val sealedEnvelope = sealed.optString("envelope", "")
                                if (ephPubKeyHex.isEmpty() || sealedEnvelope.isEmpty()) {
                                    messageResults.put(JSONObject().apply { put("status", "unseal_failed"); put("timestamp", timestamp) })
                                    continue
                                }

                                val ephPubKey = hexStringToBytes(ephPubKeyHex)
                                val localEnvJson: JSONObject = try { JSONObject(sealedEnvelope) } catch (e: Exception) {
                                    messageResults.put(JSONObject().apply { put("status", "unseal_failed"); put("timestamp", timestamp) })
                                    continue
                                }
                                val unsealInput = JSONObject().apply {
                                    put("inbox_private_key", intListToBase64(convPrivKey))
                                    put("ephemeral_public_key", bytesToBase64(ephPubKey))
                                    put("ciphertext", localEnvJson)
                                }

                                val unsealResult = decryptInboxMessage(unsealInput.toString())
                                val unsealedStr: String
                                try {
                                    val bytes = decryptInboxBytes(unsealResult)
                                    unsealedStr = String(bytes, Charsets.UTF_8)
                                } catch (e: Exception) {
                                    messageResults.put(JSONObject().apply { put("status", "unseal_failed"); put("timestamp", timestamp) })
                                    continue
                                }

                                val unsealedJson: JSONObject? = try { JSONObject(unsealedStr) } catch (e: Exception) { null }
                                if (unsealedJson != null && unsealedJson.has("protocol_identifier")) {
                                    var decryptedFlag = false
                                    for (i in stateList.indices) {
                                        val entry = stateList[i]
                                        if (entry.state.isEmpty()) continue
                                        try {
                                            val se = DoubleRatchetStateAndEnvelope(entry.state, unsealedStr)
                                            val result = doubleRatchetDecrypt(se)
                                            val msgBytes = ByteArray(result.message.size) { result.message[it].toByte() }
                                            val msgText = String(msgBytes, Charsets.UTF_8)
                                            if (msgText.startsWith("Decryption failed:") || msgText.contains("aead::Error") || result.message.isEmpty()) continue

                                            stateList[i] = entry.copy(state = result.ratchetState)

                                            // Write updated DR state to MMKV
                                            val existingJson = readEncryptionState(entry.conversationId, entry.inboxId)
                                            if (existingJson != null) {
                                                try {
                                                    val existingObj = JSONObject(existingJson)
                                                    existingObj.put("state", sanitizeForJSON(result.ratchetState))
                                                    existingObj.put("timestamp", System.currentTimeMillis())
                                                    writeEncryptionState(entry.conversationId, entry.inboxId, existingObj.toString(), false)
                                                } catch (e: Exception) { /* ignore */ }
                                            }

                                            messageResults.put(JSONObject().apply {
                                                put("status", "decrypted")
                                                put("decrypted_message", addText(msgText))
                                                put("used_state_inbox_id", entry.inboxId)
                                                put("conversation_id", entry.conversationId)
                                                put("timestamp", timestamp)
                                            })
                                            decryptedFlag = true
                                            break
                                        } catch (e: Exception) { continue }
                                    }
                                    if (!decryptedFlag) {
                                        messageResults.put(JSONObject().apply { put("status", "decrypt_failed"); put("timestamp", timestamp) })
                                    }
                                } else {
                                    messageResults.put(JSONObject().apply {
                                        put("status", "unseal_failed")
                                        put("decrypted_message", addText(unsealedStr))
                                        put("timestamp", timestamp)
                                    })
                                }
                            } else {
                                messageResults.put(JSONObject().apply { put("status", "no_state"); put("timestamp", timestamp) })
                            }
                        }

                        dmResultsArr.put(JSONObject().apply {
                            put("conversation_id", conversationId)
                            put("messages", messageResults)
                            if (newConversationInbox != null) put("new_conversation_inbox", newConversationInbox)
                        })
                    }

                    val output = JSONObject().apply {
                        put("space_results", spaceResults)
                        put("dm_results", dmResultsArr)
                        // Signal to JS that the batch hit the text cap
                        // and dropped one or more `decrypted_message` /
                        // `plaintext` field contents. JS detects this
                        // and re-fetches the affected messages
                        // individually via the non-batch path.
                        if (batchTruncated) put("truncated", true)
                    }
                    promise.resolve(output.toString())
                } catch (e: Exception) {
                    promise.resolve("{\"space_results\":[],\"dm_results\":[]}")
                }
            }
        }

        // Triple Ratchet Resize - generates invite evals pool
        AsyncFunction("tripleRatchetResize") { input: String, promise: Promise ->
            cryptoScope.launch {
                try {
                    val json = JSONObject(input)
                    val ratchetState = json.getString("ratchet_state")
                    val other = json.getString("other")
                    val id = json.getLong("id").toULong()
                    val total = json.getLong("total").toULong()

                    if (ratchetState.isEmpty() || other.isEmpty() || total == 0UL) {
                        promise.resolve("[[]]")
                        return@launch
                    }

                    val result = tripleRatchetResize(ratchetState, other, id, total)

                    // Output as a JSON array of base64-encoded byte
                    // arrays — matches the new wire format used by
                    // serializeStateAndMessage. JS side decodes each
                    // inner string with atob() / Buffer.from.
                    val sb = StringBuilder(result.sumOf { it.size } + result.size * 4 + 16)
                    sb.append('[')
                    var first = true
                    for (innerList in result) {
                        if (first) first = false else sb.append(',')
                        val bytes = ByteArray(innerList.size) { innerList[it].toByte() }
                        sb.append('"')
                        sb.append(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                        sb.append('"')
                    }
                    sb.append(']')
                    promise.resolve(sb.toString())
                } catch (e: Exception) {
                    promise.resolve("[[]]")
                }
            }
        }
    }

    // Convert CryptoException to a human-readable message
    private fun cryptoExceptionMessage(e: CryptoException): String {
        return when (e) {
            is CryptoException.InvalidState -> "Invalid state: ${e.message}"
            is CryptoException.InvalidEnvelope -> "Invalid envelope: ${e.message}"
            is CryptoException.DecryptionFailed -> "Decryption failed: ${e.message}"
            is CryptoException.EncryptionFailed -> "Encryption failed: ${e.message}"
            is CryptoException.SerializationFailed -> "Serialization failed: ${e.message}"
            is CryptoException.InvalidInput -> "Invalid input: ${e.message}"
        }
    }

    // Sanitize a string to ensure it's valid for JSON serialization
    // This removes control characters that might cause issues
    private fun sanitizeForJSON(input: String): String {
        val sb = StringBuilder()
        for (char in input) {
            val code = char.code
            // Allow printable characters, tab, newline, carriage return
            if (code >= 0x20 || code == 0x09 || code == 0x0A || code == 0x0D) {
                sb.append(char)
            }
        }
        return sb.toString()
    }

    private fun serializeStateAndEnvelope(ratchetState: String, envelope: String): String {
        val safeRatchetState = sanitizeForJSON(ratchetState)
        val safeEnvelope = sanitizeForJSON(envelope)
        return JSONObject().apply {
            put("ratchet_state", safeRatchetState)
            put("envelope", safeEnvelope)
        }.toString()
    }

    private fun serializeStateAndMessage(ratchetState: String, message: List<UByte>): String {
        // Output the decrypted message bytes as a base64 string. JS
        // side decodes via atob() / Buffer.from(b, 'base64'). The
        // previous JSON int-array format inflated 4x in transit AND
        // forced JS to JSON.parse a million Numbers per MB — both
        // memory and CPU heavy. Base64 is the canonical Rust wire
        // format now (see decrypt_inbox_message), and this matches.
        val safeRatchetState = sanitizeForJSON(ratchetState)
        // Convert List<UByte> to ByteArray once for android.util.Base64.
        // toByte() truncation is fine here — UByte values are 0-255.
        val bytes = ByteArray(message.size) { message[it].toByte() }
        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        val sb = StringBuilder(b64.length + safeRatchetState.length + 64)
        sb.append("{\"ratchet_state\":").append(JSONObject.quote(safeRatchetState))
        sb.append(",\"message\":\"").append(b64).append("\"")
        sb.append('}')
        return sb.toString()
    }

    private fun jsonArrayToUByteList(array: JSONArray): List<UByte> {
        val list = mutableListOf<UByte>()
        for (i in 0 until array.length()) {
            list.add(array.getInt(i).toUByte())
        }
        return list
    }

    // Decoder for the Rust binding's decrypt return. The Rust source
    // returns the bytes as base64 (see monorepo/crates/channel —
    // `decrypt_inbox_message` calls `BASE64_STANDARD.encode`). Errors
    // come back as plain-text strings which aren't valid base64; the
    // call sites catch the IllegalArgumentException and treat the
    // failure as `unseal_failed`.
    private fun decryptInboxBytes(rustResult: String): ByteArray =
        android.util.Base64.decode(rustResult, android.util.Base64.DEFAULT)

    /** Encode bytes for Rust input. Same wire format Rust now accepts
     *  on byte fields (see deserialize_bytes_b64_or_array in the
     *  channel crate). Replaces `JSONArray(...)` constructions that
     *  used to box each byte into a heap Integer. */
    private fun bytesToBase64(bytes: ByteArray): String =
        android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)

    /** Variant for List<Int>-shaped private keys (the existing key
     *  storage format on the Kotlin side). */
    private fun intListToBase64(ints: List<Int>): String {
        val bytes = ByteArray(ints.size) { ints[it].toByte() }
        return bytesToBase64(bytes)
    }

    private fun ubyteListToJsonArray(list: List<UByte>): JSONArray {
        val array = JSONArray()
        list.forEach { array.put(it.toInt()) }
        return array
    }

    private fun hexStringToBytes(hex: String): ByteArray {
        val result = ByteArray(hex.length / 2)
        for (i in result.indices) {
            result[i] = hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
        return result
    }

    private fun parseTripleRatchetStateAndMetadata(input: String): TripleRatchetStateAndMetadata? {
        return try {
            val json = JSONObject(input)
            val ratchetState = json.getString("ratchet_state")
            val metadataJson = json.getJSONObject("metadata")
            val metadata = mutableMapOf<String, String>()
            metadataJson.keys().forEach { key ->
                metadata[key] = metadataJson.getString(key)
            }
            TripleRatchetStateAndMetadata(ratchetState, metadata)
        } catch (e: Exception) {
            null
        }
    }

    private fun serializeTripleRatchetStateAndMetadata(state: TripleRatchetStateAndMetadata): String {
        val safeRatchetState = sanitizeForJSON(state.ratchetState)
        val metadataJson = JSONObject()
        state.metadata.forEach { (key, value) ->
            metadataJson.put(sanitizeForJSON(key), sanitizeForJSON(value))
        }
        return JSONObject().apply {
            put("ratchet_state", safeRatchetState)
            put("metadata", metadataJson)
        }.toString()
    }

    // ====== MMKV Storage Helpers ======

    private val encryptionMMKVId = "quorum-encryption"

    private fun getMMKV(): MMKV? {
        return try {
            MMKV.mmkvWithID(encryptionMMKVId, MMKV.SINGLE_PROCESS_MODE)
        } catch (e: Exception) {
            try {
                MMKV.initialize(appContext.reactContext ?: return null)
                MMKV.mmkvWithID(encryptionMMKVId, MMKV.SINGLE_PROCESS_MODE)
            } catch (e2: Exception) {
                null
            }
        }
    }

    private fun mmkvGetString(key: String): String? {
        return getMMKV()?.decodeString(key)
    }

    private fun mmkvSetString(key: String, value: String) {
        getMMKV()?.encode(key, value)
    }

    // ====== Encryption State Storage Key Patterns ======

    private fun encStateKey(conversationId: String, inboxId: String) = "enc_state:$conversationId:$inboxId"
    private fun ephemeralCacheKey(conversationId: String, ephemeralKey: String) = "ephemeral:$conversationId:$ephemeralKey"
    private fun inboxMappingKey(inboxId: String) = "inbox_map:$inboxId"
    private fun latestStateKey(conversationId: String) = "latest:$conversationId"
    private fun convInboxesKey(conversationId: String) = "conv_inboxes:$conversationId"
    private fun convInboxKeyKey(conversationId: String) = "conv_inbox_key:$conversationId"

    // ====== MMKV Read Helpers ======

    private fun readEncryptionState(conversationId: String, inboxId: String): String? {
        return mmkvGetString(encStateKey(conversationId, inboxId))
    }

    private fun readAllEncryptionStates(conversationId: String): List<Pair<String, String>> {
        val inboxesJson = mmkvGetString(convInboxesKey(conversationId)) ?: return scanEncryptionStates(conversationId)
        return try {
            val arr = JSONArray(inboxesJson)
            val results = mutableListOf<Pair<String, String>>()
            for (i in 0 until arr.length()) {
                val iid = arr.getString(i)
                val state = mmkvGetString(encStateKey(conversationId, iid))
                if (state != null) results.add(Pair(iid, state))
            }
            results
        } catch (e: Exception) {
            scanEncryptionStates(conversationId)
        }
    }

    private fun scanEncryptionStates(conversationId: String): List<Pair<String, String>> {
        val mmkv = getMMKV() ?: return emptyList()
        val prefix = "enc_state:$conversationId:"
        val results = mutableListOf<Pair<String, String>>()
        for (key in mmkv.allKeys() ?: emptyArray()) {
            if (key.startsWith(prefix) && !key.endsWith(":fallback")) {
                val inboxId = key.removePrefix(prefix)
                val state = mmkv.decodeString(key)
                if (state != null) results.add(Pair(inboxId, state))
            }
        }
        return results
    }

    private fun readEphemeralCache(conversationId: String, ephemeralKey: String): String? {
        return mmkvGetString(ephemeralCacheKey(conversationId, ephemeralKey))
    }

    private fun readConversationInboxKeypair(conversationId: String): JSONObject? {
        val json = mmkvGetString(convInboxKeyKey(conversationId)) ?: return null
        return try { JSONObject(json) } catch (e: Exception) { null }
    }

    // ====== MMKV Write Helpers ======

    private fun writeEncryptionState(conversationId: String, inboxId: String, stateJson: String, updateLatest: Boolean) {
        mmkvSetString(encStateKey(conversationId, inboxId), stateJson)
        addToConvInboxes(conversationId, inboxId)
        if (updateLatest) {
            val latestJson = JSONObject().apply {
                put("conversationId", conversationId)
                put("inboxId", inboxId)
                put("timestamp", System.currentTimeMillis())
            }.toString()
            mmkvSetString(latestStateKey(conversationId), latestJson)
        }
    }

    private fun writeEphemeralCache(conversationId: String, ephemeralKey: String, stateJson: String) {
        mmkvSetString(ephemeralCacheKey(conversationId, ephemeralKey), stateJson)
    }

    private fun writeInboxMapping(inboxId: String, conversationId: String) {
        val json = JSONObject().apply {
            put("inboxId", inboxId)
            put("conversationId", conversationId)
        }.toString()
        mmkvSetString(inboxMappingKey(inboxId), json)
    }

    private fun writeConversationInboxKeypair(keypair: JSONObject) {
        val conversationId = keypair.optString("conversationId", "")
        if (conversationId.isNotEmpty()) {
            mmkvSetString(convInboxKeyKey(conversationId), keypair.toString())
        }
    }

    private fun addToConvInboxes(conversationId: String, inboxId: String) {
        val key = convInboxesKey(conversationId)
        val existing = mmkvGetString(key)
        val arr = if (existing != null) try { JSONArray(existing) } catch (e: Exception) { JSONArray() } else JSONArray()
        // Check if already present
        for (i in 0 until arr.length()) {
            if (arr.getString(i) == inboxId) return
        }
        arr.put(inboxId)
        mmkvSetString(key, arr.toString())
    }

    // ====== Base58 Encoding ======

    private val BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

    private fun base58Encode(bytes: ByteArray): String {
        val digits = mutableListOf(0)
        for (b in bytes) {
            var carry = b.toInt() and 0xFF
            for (j in digits.indices) {
                carry += digits[j] shl 8
                digits[j] = carry % 58
                carry /= 58
            }
            while (carry > 0) {
                digits.add(carry % 58)
                carry /= 58
            }
        }
        val sb = StringBuilder()
        for (b in bytes) {
            if (b.toInt() != 0) break
            sb.append(BASE58_ALPHABET[0])
        }
        for (d in digits.reversed()) {
            sb.append(BASE58_ALPHABET[d])
        }
        return sb.toString()
    }

    // ====== Address Derivation ======

    private fun deriveAddress(publicKey: ByteArray): String {
        val sha256 = MessageDigest.getInstance("SHA-256")
        val hash = sha256.digest(publicKey)
        // Multihash: 0x12 = SHA-256, 0x20 = 32 bytes
        val multihash = ByteArray(2 + hash.size)
        multihash[0] = 0x12
        multihash[1] = 0x20
        System.arraycopy(hash, 0, multihash, 2, hash.size)
        return base58Encode(multihash)
    }

    private fun buildEncryptionStateJson(
        state: String,
        conversationId: String,
        inboxId: String,
        sentAccept: Boolean,
        sendingInbox: JSONObject?,
        tag: String?
    ): String {
        return JSONObject().apply {
            put("state", sanitizeForJSON(state))
            put("timestamp", System.currentTimeMillis())
            put("conversationId", conversationId)
            put("inboxId", inboxId)
            put("sentAccept", sentAccept)
            if (sendingInbox != null) put("sendingInbox", sendingInbox)
            if (tag != null) put("tag", tag)
        }.toString()
    }
}
