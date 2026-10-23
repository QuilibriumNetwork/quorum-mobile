/**
 * BackgroundMessageService - Checks for new messages in background
 *
 * This service is designed to run in background fetch tasks.
 * It checks for new Farcaster direct casts and shows local notifications
 * for any new ones found.
 *
 * Quorum messages are NOT checked here. This used to open a socket, `listen`
 * on every inbox the device owns and wait 5 s, on every push and every 15
 * minutes. The relay answers a listen by re-sending every envelope still
 * pending on those inboxes, and nothing here acked or deleted them, so each
 * wake-up downloaded the whole backlog again. It also never raised anything:
 * it counted frames with `type === 'message'` and an `encrypted_content`
 * field, and the relay sends neither — an inbox frame is
 * `{ encryptedContent, inboxAddress, timestamp }` with no `type` at all
 * (quorum-api server/client.go, `EncryptedMessage`). Quorum pushes already
 * reach the user as the push itself; full message handling happens when the
 * app opens.
 *
 * Limitations:
 * - Background execution time is limited (~30 seconds on iOS)
 */

import { getDeviceKeyset } from '../onboarding/secureStorage';
import { getDirectCastToken } from '../farcaster/directCastAuth';
import { showMessageNotification } from './NotificationService';
import { getDirectCastConversations } from '../farcasterClient';
import { planFarcasterPings, rewoundWatermark } from './farcasterPingPlan';
import { mmkvStorage } from '../offline/storage';

export interface BackgroundCheckResult {
  newMessageCount: number;
  success: boolean;
  error?: string;
}

// Storage key for tracking last seen Farcaster message timestamp
const LAST_FC_MESSAGE_KEY = 'background.lastFarcasterMessageTimestamp';

/**
 * Check for new messages in background: Farcaster direct casts only. See the
 * header for why Quorum inboxes are not polled from here.
 */
export async function checkForNewMessages(): Promise<BackgroundCheckResult> {
  setLastBackgroundCheckTime(Date.now());

  try {
    const farcasterResult = await checkFarcasterDirectCasts();
    return {
      newMessageCount: farcasterResult.newMessageCount,
      success: farcasterResult.success,
      error: farcasterResult.error,
    };
  } catch (error) {
    return {
      newMessageCount: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export interface FarcasterCheckResult extends BackgroundCheckResult {
  /**
   * True when the run collapsed into ONE generic digest ping instead of raising
   * one per conversation. Surfaced (rather than inferred from the count)
   * because the two produce visibly different rows — per-conversation rows are
   * tappable and name their sender, the digest row does neither — and "which
   * did I just get?" is otherwise a guess.
   */
  digest: boolean;
  /** False when there is no direct-cast token (none could be minted), so nothing was fetched. */
  hasToken: boolean;
  /** Conversations the API returned. 0 means the fetch, not the logic, is why
   *  nothing happened. Note the fetch is the inbox (`category: 'default'`) only — a
   *  message from someone you have never replied to sits in `request` and is
   *  invisible here. */
  conversationsFetched: number;
  /**
   * Pings that actually reached the OS and the in-app log, as opposed to
   * `newMessageCount`, which is what the run DECIDED to send.
   *
   * These differ whenever `showMessageNotification` suppresses one — global
   * notifications off, or the conversation muted. Reporting only the decision
   * would let a fully-suppressed run read as a success while nothing appeared
   * on screen, which is the single most misleading thing this instrument
   * could do.
   */
  delivered: number;
}

/** The last-seen watermark the Farcaster check compares against. Dev instrument. */
export function getFarcasterCheckWatermark(): number {
  const raw = mmkvStorage.getItem(LAST_FC_MESSAGE_KEY);
  return raw ? parseInt(raw, 10) : 0;
}

/**
 * Move the Farcaster watermark BACKWARDS so recent conversations count as new
 * again on the next check. Dev instrument only.
 *
 * Without it, testing the background check on a device is a one-shot: the first
 * run advances the watermark past everything, and a second run finds nothing
 * until real new messages arrive. Rewinding turns it into a loop.
 *
 * Lossless — it only changes which direct casts are considered new for the
 * purposes of raising a ping. Re-pinged conversations collapse onto their
 * existing row (the pings are keyed per conversation), so a rewind cannot
 * duplicate rows or delete anything.
 */
export function rewindFarcasterCheckWatermark(byMs: number): void {
  const next = rewoundWatermark(getFarcasterCheckWatermark(), byMs, Date.now());
  mmkvStorage.setItem(LAST_FC_MESSAGE_KEY, String(next));
}

/**
 * Check for new Farcaster direct cast messages.
 *
 * Exported for the dev panel so the check can be run on demand. In production
 * it is only ever reached through `checkForNewMessages` from the OS background
 * task, which has a 15-minute floor — far too coarse to test against by hand.
 */
export async function checkFarcasterDirectCasts(): Promise<FarcasterCheckResult> {
  try {
    // The direct-cast token, minted here if there's none yet.
    const token = await getDirectCastToken();
    if (!token) {
      return {
        newMessageCount: 0, success: true, digest: false,
        hasToken: false, conversationsFetched: 0, delivered: 0,
      };
    }

    // Get last seen timestamp
    const lastSeenStr = mmkvStorage.getItem(LAST_FC_MESSAGE_KEY);
    const lastSeenTimestamp = lastSeenStr ? parseInt(lastSeenStr, 10) : 0;

    // Fetch recent conversations
    const { conversations } = await getDirectCastConversations({ limit: 20 });

    const plan = planFarcasterPings(conversations, lastSeenTimestamp);

    // Update last seen timestamp
    if (plan.latestTimestamp > lastSeenTimestamp) {
      mmkvStorage.setItem(LAST_FC_MESSAGE_KEY, String(plan.latestTimestamp));
    }

    if (plan.digestCount > 0) {
      // Too many to be worth one row each. No conversationId — the tap lands
      // on the Messages tab, which is the right destination for a digest.
      const digestId = await showMessageNotification({
        title: 'New Messages',
        body: `You have ${plan.digestCount} new direct messages`,
        data: {
          type: 'message',
          messageId: `fc-${Date.now()}`,
          origin: 'farcaster',
        },
      });
      return {
        newMessageCount: plan.digestCount, success: true, digest: true,
        hasToken: true, conversationsFetched: conversations.length,
        delivered: digestId ? 1 : 0,
      };
    }

    // One ping per conversation. `conversationId` is what makes the in-app row
    // tappable AND what lets the per-DM mute gate in `showMessageNotification`
    // see the conversation at all; `logId` keys the in-app row to the
    // conversation so repeat runs refresh one row rather than stacking
    // identical ones.
    let delivered = 0;
    for (const conversation of plan.conversations) {
      const id = await showMessageNotification({
        title: 'New Messages',
        body: 'You have a new direct message',
        data: {
          type: 'message',
          messageId: `fc-${conversation.lastMessage?.messageId ?? conversation.conversationId}`,
          conversationId: `farcaster:${conversation.conversationId}`,
          origin: 'farcaster',
        },
        logId: `fc-conv:${conversation.conversationId}`,
      });
      if (id) delivered++;
    }

    return {
      newMessageCount: plan.conversations.length, success: true, digest: false,
      hasToken: true, conversationsFetched: conversations.length, delivered,
    };
  } catch (error) {
    return {
      newMessageCount: 0,
      success: false,
      digest: false,
      hasToken: true,
      conversationsFetched: 0,
      delivered: 0,
      error: error instanceof Error ? error.message : 'Farcaster check failed',
    };
  }
}

/**
 * Check if background message checking is enabled
 * Users can disable this in settings
 */
export async function isBackgroundCheckEnabled(): Promise<boolean> {
  // For now, always enabled if user is authenticated
  // Could add a settings toggle in the future
  const deviceKeyset = await getDeviceKeyset();
  return deviceKeyset !== null;
}

/**
 * Get the last time background check was performed
 * Useful for debugging and status display
 */
let lastCheckTime: number | null = null;

export function getLastBackgroundCheckTime(): number | null {
  return lastCheckTime;
}

export function setLastBackgroundCheckTime(time: number): void {
  lastCheckTime = time;
}
