/**
 * pushReceivedTask — runs when a silent Expo push lands. The server-pushed
 * payload has only generic title/body to preserve E2E; for a Farcaster push
 * it runs the background direct-cast check. Quorum message pushes are shown
 * as they arrive and their content is fetched when the app next opens.
 *
 * Must be imported at app startup (see index.js) BEFORE any React
 * components, otherwise the OS may dispatch the task before the handler
 * is registered. Mirrors backgroundTask.ts.
 */

import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { checkForNewMessages } from './BackgroundMessageService';
import { pushWarrantsFarcasterDmCheck } from './pushKind';
import { getGlobalNotificationsEnabled } from './notificationPrefs';

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

    // Everything below this point is the Farcaster direct-cast check, so a
    // Quorum push (hub-log / inbox) has nothing to gain from it: the push is
    // the notification, and the message itself is fetched when the app next
    // opens.
    //
    // The per-DM, per-space and per-channel mute gates that used to sit here
    // only ever decided whether that check ran — returning from this task is
    // its only effect, it cannot withdraw a banner the OS (or the iOS NSE)
    // already shows. With Quorum pushes stopping here they had nothing left
    // to gate, and the per-channel one cost a REST fetch and a decrypt of the
    // hub-log entry on every space message.
    if (!pushWarrantsFarcasterDmCheck(inferred.type)) {
      return;
    }

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
