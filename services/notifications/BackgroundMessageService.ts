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

/**
 * Check for new Farcaster direct cast messages
 */
async function checkFarcasterDirectCasts(): Promise<BackgroundCheckResult> {
  try {
    const token = await getFarcasterAuthToken();
    if (!token) {
      return { newMessageCount: 0, success: true };
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

    let newMessageCount = 0;
    let latestTimestamp = lastSeenTimestamp;

    // Check for new messages in conversations
    for (const conversation of conversations) {
      const lastMessage = conversation.lastMessage;
      if (lastMessage && lastMessage.serverTimestamp > lastSeenTimestamp) {
        // This is a new message we haven't seen
        newMessageCount++;
        if (lastMessage.serverTimestamp > latestTimestamp) {
          latestTimestamp = lastMessage.serverTimestamp;
        }
      }
    }

    // Update last seen timestamp
    if (latestTimestamp > lastSeenTimestamp) {
      mmkvStorage.setItem(LAST_FC_MESSAGE_KEY, String(latestTimestamp));
    }

    // Show notification if there are new messages
    if (newMessageCount > 0) {
      await showMessageNotification({
        title: 'New Messages',
        body: newMessageCount === 1
          ? 'You have a new direct message'
          : `You have ${newMessageCount} new direct messages`,
        data: {
          type: 'message',
          messageId: `fc-${Date.now()}`,
          origin: 'farcaster',
        },
      });
    }

    return { newMessageCount, success: true };
  } catch (error) {
    return {
      newMessageCount: 0,
      success: false,
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
