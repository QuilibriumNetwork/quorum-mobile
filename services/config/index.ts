/**
 * Config service exports
 */

export {
  // Config management
  getConfig,
  saveConfig,
  updateConfig,
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
} from './configService';
