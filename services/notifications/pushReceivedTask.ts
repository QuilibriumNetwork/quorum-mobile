/**
 * pushReceivedTask — wakes the app to fetch real content when a silent
 * Expo push lands. The server-pushed payload has only generic title/body
 * to preserve E2E; the device decrypts the actual message locally on
 * receipt.
 *
 * Must be imported at app startup (see index.js) BEFORE any React
 * components, otherwise the OS may dispatch the task before the handler
 * is registered. Mirrors backgroundTask.ts.
 */

import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { checkForNewMessages } from './BackgroundMessageService';
import { classifyHubLogEntry, SUPPRESSED_CONTENT_TYPES } from './hubLogClassifier';
import { mmkvStorage } from '@/services/offline/storage';
import {
  getGlobalNotificationsEnabled,
  getSpaceNotificationsEnabled,
  getChannelNotificationsEnabled,
} from './notificationPrefs';
import { getSpaceByHubAddress } from '@/services/config/spaceStorage';
import { isConversationMutedForCurrentUser } from '@/services/config/configService';

// AuthContext stores the user object under this key in MMKV. Inlined
// here to avoid a circular import — the constant is small and stable.
const USER_STORAGE_KEY = 'auth:user';

export const BACKGROUND_NOTIFICATION_TASK = 'quorum-background-notification';

interface PushNotificationData {
  type?: 'hub-log' | 'inbox' | 'farcaster';
  hub_address?: string;
  hub?: string;
  inbox_address?: string;
  inbox?: string;
  seq?: number;
  fid?: number;
}

/**
 * Read the current authenticated user address from MMKV (set by
 * AuthContext on sign-in). Returns null if we can't recover it — in
 * which case the suppression check has to bail out and we fall back
 * to showing the notification.
 */
function getCurrentUserAddress(): string | null {
  try {
    const json = mmkvStorage.getItem(USER_STORAGE_KEY);
    if (!json) return null;
    const u = JSON.parse(json) as { address?: string };
    return u?.address ?? null;
  } catch {
    return null;
  }
}

let taskDefined = false;
if (!taskDefined) {
  taskDefined = true;
  TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
    if (error) return;

    // Expo wraps the payload as { notification: { ... data... } } on iOS
    // and { data: { ... } } on Android. Probe both shapes.
    const raw = data as Record<string, unknown> | undefined;
    const inferred =
      ((raw?.notification as Record<string, unknown> | undefined)?.data as
        | PushNotificationData
        | undefined) ??
      (raw?.data as PushNotificationData | undefined) ??
      (raw as PushNotificationData | undefined) ??
      {};

    // Global mute — if the user turned off notifications in user
    // settings, never present anything regardless of routing. The
    // server may still be pushing if the token-unregister flow has
    // not run; this is the client-side guard.
    if (!getGlobalNotificationsEnabled()) {
      return;
    }

    const hubAddress = inferred.hub_address ?? inferred.hub;

    // Per-DM mute — suppress the native banner for a muted conversation
    // when the app is woken in the background/killed. The foreground path
    // (showMessageNotification) already gates on the same mute state; this
    // closes the background gap. Mirrors the per-space / per-channel gates
    // below: resolve the routing key locally, check the synced mute list,
    // bail before checkForNewMessages renders anything.
    //
    // The push payload carries only the conversation-specific inbox_address
    // (E2E: the server can't know the conversationId). Resolve it the same
    // way the deep-link router does (NotificationService 'inbox' case), via
    // the per-DM inbox keypair record. MMKV-backed and synchronous, so it
    // works in this background task.
    //
    // Fail open: if the inbox can't be resolved (brand-new / never-decrypted
    // conversation) we do NOT suppress — better a stray banner than a
    // silently dropped message.
    const inboxAddress = inferred.inbox_address ?? inferred.inbox;
    if (inferred.type === 'inbox' && inboxAddress) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cryptoMod = require('@/services/crypto/encryption-state-storage');
        const encryptionStateStorage = cryptoMod.encryptionStateStorage as {
          getConversationInboxKeypairByAddress: (
            addr: string,
          ) => { conversationId?: string } | null;
        };
        const kp = encryptionStateStorage.getConversationInboxKeypairByAddress(inboxAddress);
        const conversationId = kp?.conversationId;
        if (conversationId && isConversationMutedForCurrentUser(conversationId)) {
          return;
        }
      } catch {
        // Lookup failed — fall through and let the normal flow render the
        // notification rather than risk swallowing a real one.
      }
    }

    // Per-space mute — anyone can opt out of an entire space.
    // Hub-log pushes carry hub_address; resolve to spaceId locally to
    // check the prefs. Skip when we can't resolve (the push will
    // still surface via the global flow).
    //
    // 'farcaster' and 'inbox' pushes intentionally stay under the
    // global toggle above ONLY: neither carries a space context
    // (farcaster routes by fid, inbox by per-DM inbox address), so
    // there is no spaceId to check a per-space pref against. Per-space
    // mutes simply don't apply to them.
    if (inferred.type === 'hub-log' && hubAddress) {
      const space = getSpaceByHubAddress(hubAddress);
      if (space && !getSpaceNotificationsEnabled(space.spaceId)) {
        return;
      }
    }

    // Decrypt the hub-log entry once and use the result for both
    // content-type suppression (update-profile / edit-message /
    // remove-message) AND per-channel mute. The push payload doesn't
    // carry channelId; the classifier decrypts the actual envelope
    // to read it.
    if (inferred.type === 'hub-log' && hubAddress && typeof inferred.seq === 'number') {
      const userAddress = getCurrentUserAddress();
      if (userAddress) {
        try {
          const cls = await classifyHubLogEntry({
            hubAddress,
            seq: inferred.seq,
            userAddress,
          });
          if (cls) {
            if (cls.contentType && SUPPRESSED_CONTENT_TYPES.has(cls.contentType)) {
              // Control-message suppression. WS catch-up on next
              // foreground will apply state.
              return;
            }
            if (cls.spaceId && cls.channelId) {
              if (!getChannelNotificationsEnabled(cls.spaceId, cls.channelId)) {
                return;
              }
            }
          }
        } catch {
          // Classifier failed — fall through to normal flow so we
          // don't accidentally swallow a real notification.
        }
      }
    }

    // Regardless of which scope the push was for, run the unified
    // catch-up: it fetches new DM/space messages and posts local
    // notifications with real (decrypted) titles/bodies.
    try {
      await checkForNewMessages();
    } catch {
      // Best effort — the in-app reconciler will pick this up on next foreground.
    }
  });
}

/**
 * Register the background-notification task with expo-notifications. Must
 * be called once after permissions are granted; the OS otherwise drops
 * silent pushes on the floor.
 */
export async function registerBackgroundNotificationTask(): Promise<void> {
  try {
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
  } catch {
    // No-op — already registered, or platform doesn't support it.
  }
}
