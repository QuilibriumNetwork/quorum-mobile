/**
 * Notification Services Export
 *
 * This module exports all notification-related functionality for Quorum mobile.
 */

// Background task registration (must be imported at app startup)
export {
  BACKGROUND_MESSAGE_TASK,
  BACKGROUND_FETCH_INTERVAL_MINUTES,
  registerBackgroundFetch,
  unregisterBackgroundFetch,
  getBackgroundFetchStatus,
  isBackgroundFetchAvailable,
} from './backgroundTask';

// Background message checking
export {
  checkForNewMessages,
  isBackgroundCheckEnabled,
  getLastBackgroundCheckTime,
  setLastBackgroundCheckTime,
  type BackgroundCheckResult,
} from './BackgroundMessageService';

// Notification service
export {
  requestNotificationPermissions,
  setupNotificationChannel,
  showMessageNotification,
  handleNotificationTap,
  setupNotificationResponseListener,
  setNotificationNavigationReady,
  processColdStartNotification,
  setupNotificationReceivedListener,
  getBadgeCount,
  setBadgeCount,
  clearAllNotifications,
  initializeNotifications,
  type MessageNotificationData,
  type NotificationContent,
} from './NotificationService';
