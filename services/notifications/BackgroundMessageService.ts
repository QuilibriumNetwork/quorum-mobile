/**
 * BackgroundMessageService - Checks for new messages in background
 *
 * This service is designed to run in background fetch tasks.
 * It checks for new Farcaster direct casts and Quorum messages
 * and shows local notifications for any new messages found.
 *
 * Limitations:
 * - Background execution time is limited (~30 seconds on iOS)
 * - We don't process/decrypt messages fully, just check for presence
 * - Full message handling happens when app opens
 */

import { getDeviceKeyset, getFarcasterAuthToken } from '../onboarding/secureStorage';
import { getInboxAddress } from '../onboarding/secureStorage';
import { getAllSpaceInboxAddresses } from '../config/spaceStorage';
import { encryptionStateStorage } from '../crypto/encryption-state-storage';
import { showMessageNotification } from './NotificationService';
import { getDirectCastConversations } from '../farcasterClient';
import { planFarcasterPings } from './farcasterPingPlan';
import { mmkvStorage } from '../offline/storage';

import { getApiConfig } from '../api/config';

const API_CONFIG = getApiConfig();

// Timeout for background WebSocket connection (keep short for background execution limits)
const BACKGROUND_WS_TIMEOUT = 15000; // 15 seconds

export interface BackgroundCheckResult {
  newMessageCount: number;
  success: boolean;
  error?: string;
}

// Storage key for tracking last seen Farcaster message timestamp
const LAST_FC_MESSAGE_KEY = 'background.lastFarcasterMessageTimestamp';

/**
 * Check for new messages in background
 * Checks both Farcaster direct casts and Quorum messages
 */
export async function checkForNewMessages(): Promise<BackgroundCheckResult> {
  setLastBackgroundCheckTime(Date.now());

  let totalNewMessages = 0;
  let hasError = false;
  let errorMessage: string | undefined;

  try {
    // 1. Check Farcaster direct casts first (most common use case)
    const farcasterResult = await checkFarcasterDirectCasts();
    totalNewMessages += farcasterResult.newMessageCount;

    // 2. Check Quorum messages if authenticated
    const deviceKeyset = await getDeviceKeyset();
    if (deviceKeyset) {
      const inboxAddresses = await collectInboxAddresses();
      if (inboxAddresses.length > 0) {
        const quorumResult = await checkInboxesViaWebSocket(inboxAddresses);
        totalNewMessages += quorumResult.newMessageCount;
        if (!quorumResult.success) {
          hasError = true;
          errorMessage = quorumResult.error;
        }
      }
    }

    return {
      newMessageCount: totalNewMessages,
      success: !hasError,
      error: errorMessage,
    };
  } catch (error) {
    return {
      newMessageCount: totalNewMessages,
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
  const next = Math.max(0, Date.now() - byMs);
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
    const token = await getFarcasterAuthToken();
    if (!token) {
      return { newMessageCount: 0, success: true, digest: false };
    }

    // Get last seen timestamp
    const lastSeenStr = mmkvStorage.getItem(LAST_FC_MESSAGE_KEY);
    const lastSeenTimestamp = lastSeenStr ? parseInt(lastSeenStr, 10) : 0;

    // Fetch recent conversations
    const { conversations } = await getDirectCastConversations({
      token,
      category: 'default',
      limit: 20,
    });

    const plan = planFarcasterPings(conversations, lastSeenTimestamp);

    // Update last seen timestamp
    if (plan.latestTimestamp > lastSeenTimestamp) {
      mmkvStorage.setItem(LAST_FC_MESSAGE_KEY, String(plan.latestTimestamp));
    }

    if (plan.digestCount > 0) {
      // Too many to be worth one row each. No conversationId — the tap lands
      // on the Messages tab, which is the right destination for a digest.
      await showMessageNotification({
        title: 'New Messages',
        body: `You have ${plan.digestCount} new direct messages`,
        data: {
          type: 'message',
          messageId: `fc-${Date.now()}`,
          origin: 'farcaster',
        },
      });
      return { newMessageCount: plan.digestCount, success: true, digest: true };
    }

    // One ping per conversation. `conversationId` is what makes the in-app row
    // tappable AND what lets the per-DM mute gate in `showMessageNotification`
    // see the conversation at all; `logId` keys the in-app row to the
    // conversation so repeat runs refresh one row rather than stacking
    // identical ones.
    for (const conversation of plan.conversations) {
      await showMessageNotification({
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
    }

    return { newMessageCount: plan.conversations.length, success: true, digest: false };
  } catch (error) {
    return {
      newMessageCount: 0,
      success: false,
      digest: false,
      error: error instanceof Error ? error.message : 'Farcaster check failed',
    };
  }
}

/**
 * Collect all inbox addresses the user should receive messages on
 */
async function collectInboxAddresses(): Promise<string[]> {
  const addresses: string[] = [];

  // 1. User's device inbox
  const deviceInboxAddress = await getInboxAddress();
  if (deviceInboxAddress) {
    addresses.push(deviceInboxAddress);
  }

  // 2. Space inbox addresses
  const spaceInboxAddresses = getAllSpaceInboxAddresses();
  addresses.push(...spaceInboxAddresses);

  // 3. Conversation inbox addresses (created when we initiate conversations)
  const conversationInboxAddresses = encryptionStateStorage.getAllConversationInboxAddresses();
  addresses.push(...conversationInboxAddresses);

  // Deduplicate
  return [...new Set(addresses)];
}

/**
 * Create a brief WebSocket connection to check for pending messages
 * Returns quickly after receiving any messages or timeout
 */
async function checkInboxesViaWebSocket(
  inboxAddresses: string[]
): Promise<BackgroundCheckResult> {
  return new Promise((resolve) => {
    let messageCount = 0;
    let resolved = false;
    let ws: WebSocket | null = null;

    const cleanup = () => {
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close errors
        }
        ws = null;
      }
    };

    const finalize = (success: boolean, error?: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ newMessageCount: messageCount, success, error });
    };

    // Set timeout for background execution limits
    const timeoutId = setTimeout(() => {
      finalize(true); // Timeout is success - we tried
    }, BACKGROUND_WS_TIMEOUT);

    try {
      ws = new WebSocket(API_CONFIG.wsUrl);

      ws.onopen = () => {
        // Send listen message
        const listenMessage = JSON.stringify({
          type: 'listen',
          inbox_addresses: inboxAddresses,
        });

        ws?.send(listenMessage);

        // Give some time to receive queued messages, then close
        // Messages are delivered immediately on subscribe if pending
        setTimeout(() => {
          if (!resolved) {
            finalize(true);
          }
        }, 5000); // 5 seconds to receive pending messages
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data as string);

          // Check if this is an encrypted message
          if (data.type === 'message' && data.encrypted_content) {
            messageCount++;

            // Show a notification for the new message
            // Note: In background, we can't fully decrypt - just show generic notification
            if (messageCount === 1) {
              // Only show one notification for batch
              await showMessageNotification({
                title: 'New Message',
                body: 'You have new messages waiting',
                data: {
                  type: 'message',
                  messageId: `bg-${Date.now()}`,
                  origin: 'quorum',
                },
              });
            }
          }
        } catch {
          // Malformed WebSocket message — skip and continue listening
        }
      };

      ws.onerror = (error) => {
        clearTimeout(timeoutId);
        finalize(false, 'WebSocket error');
      };

      ws.onclose = () => {
        clearTimeout(timeoutId);
        if (!resolved) {
          finalize(true);
        }
      };
    } catch (error) {
      clearTimeout(timeoutId);
      finalize(false, error instanceof Error ? error.message : 'Connection failed');
    }
  });
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
