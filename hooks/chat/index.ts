/**
 * Chat hooks - Wrappers around @quilibrium/quorum-shared hooks with storage injection
 */

// Shared query cache types
export type { MessagesPage, InfiniteMessagesData } from './queryTypes';

// Query hooks
export { useSpaces, useSpace, useSpaceMembers } from './useSpaces';
export { useChannels, flattenChannels, findChannel } from './useChannels';
export { useMessages, flattenMessages, useInvalidateMessages } from './useMessages';
export { useConversations, useConversation } from './useConversations';
export type { Conversation, ConversationWithPreview } from './useConversations';
// Re-export base Conversation type for places that need it
export { Conversation as BaseConversation } from '@quilibrium/quorum-shared';

// Farcaster direct cast hooks
export {
  useFarcasterConversations,
  useFarcasterDirectCastMessages,
  useSendFarcasterDirectCast,
  useMarkFarcasterConversationRead,
  useAddFarcasterDirectCastReaction,
  useRemoveFarcasterDirectCastReaction,
  farcasterDCQueryKeys,
} from './useFarcasterDirectCasts';
export type { DirectCastConversation, DirectCastMessage } from './useFarcasterDirectCasts';

// Unified conversations (E2EE + Farcaster)
export { useUnifiedConversations } from './useUnifiedConversations';
export type { UnifiedConversationsResult } from './useUnifiedConversations';

// Mutation hooks
export { useSendMessage } from './useSendMessage';
export { useSendSpaceMessage } from './useSendSpaceMessage';
export { useDeleteSpaceMessage } from './useDeleteSpaceMessage';
export { useDeleteDirectMessage } from './useDeleteDirectMessage';
export { useSendDirectMessage, resetDMSession } from './useSendDirectMessage';
export { useSendDirectEmbedMessage } from './useSendDirectEmbedMessage';
export { useSendEmbedMessage } from './useSendEmbedMessage';
export { useAddReaction, useRemoveReaction } from './useReactions';
export { useAddSpaceReaction, useRemoveSpaceReaction } from './useSpaceReactions';
export { useSendDirectReaction, useRemoveDirectReaction } from './useSendDirectReaction';
export { useSendStickerMessage } from './useSendStickerMessage';

// Space action hooks
export { useCreateSpace, useJoinSpace, useValidateInvite } from './useSpaceActions';

// Role management hooks
export {
  useRoles,
  useHasPermission,
  useUserPermissions,
  useUserRoles,
  useAddRole,
  useUpdateRole,
  useDeleteRole,
  useAssignRole,
  useRemoveFromRole,
  useToggleRolePermission,
} from './useRoleManagement';

// User kicking hook
export { useUserKicking } from './useUserKicking';

// Channel management hooks
export {
  useAddChannel,
  useUpdateChannel,
  useDeleteChannel,
  useAddGroup,
  useUpdateGroup,
  useDeleteGroup,
  useMoveChannel,
  useReorderGroups,
  useReorderChannels,
} from './useChannelManagement';

// Space settings hooks
export {
  useUpdateSpace,
  useDeleteSpace,
  useLeaveSpace,
} from './useSpaceSettings';

// Edit hooks
export { useEditSpaceMessage, canEditMessage } from './useEditSpaceMessage';
export { useEditDirectMessage } from './useEditDirectMessage';

// Pin hooks
export { usePinMessage, useUnpinMessage, usePinnedMessages } from './usePinnedMessages';

// DM favorites and muting
export { useDMFavorites } from './useDMFavorites';
export { useDMMute } from './useDMMute';

// Search
export { useMessageSearch } from './useMessageSearch';

// User muting in spaces
export { useUserMuting } from './useUserMuting';

// Reply tracking
export { useReplyTracking } from './useReplyTracking';

// Encryption hooks
export {
  useRecipientRegistration,
  useHasEncryptionSession,
  toRecipientInfo,
  toAllDeviceInfos,
} from './useRecipientRegistration';
export type { DeviceInfo } from './useRecipientRegistration';

// Invite management hooks
export {
  useGenerateInvite,
  useCopyInviteLink,
  useShareInvite,
  useParseInviteLink,
  isValidInviteLink,
  getShortenedInviteLink,
  parseInviteLink,
} from './useInviteManagement';
