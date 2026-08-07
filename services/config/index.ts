/**
 * Config service exports
 */

export {
  // Config management
  getConfig,
  saveConfig,
  updateConfig,
  setAllowSync,
  getLocalUserConfig,
  saveLocalUserConfig,
  clearConfigStorage,
  // Profile helpers
  getDisplayName,
  getProfileImage,
  // Bookmark management
  getLocalBookmarks,
  addBookmark,
  removeBookmark,
  // DM mute management (config-backed, syncs across devices)
  getLocalMutedConversations,
  setMutedConversations,
  isConversationMutedForCurrentUser,
  // Per-conversation DM setting overrides (config-backed, syncs across devices)
  getLocalConversationSettings,
  getLocalConversationSetting,
  getConversationSettingForCurrentUser,
  setLocalConversationSetting,
  setLocalConversationSettings,
  // Channel/Space notification mute (config-backed, syncs across devices)
  getLocalMutedChannels,
  setMutedChannels,
  getLocalSpaceMuted,
  setSpaceMuted,
  // Per-space notification TYPE settings (config-backed, syncs across devices)
  getLocalNotificationTypes,
  setNotificationTypes,
  DEFAULT_NOTIFICATION_TYPES,
  type SpaceNotificationTypeId,
  // Personal block (viewer-side hide, config-backed, syncs across devices)
  getLocalBlockedUsers,
  setBlockedUsers,
} from './configService';
