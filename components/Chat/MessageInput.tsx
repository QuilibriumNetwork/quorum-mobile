import type { AppTheme } from '@/theme';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { SendIcon } from '@/components/Chat/SendIcon';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { useEmojiFrecency } from '@/hooks/useEmojiFrecency';
import { useDebouncedValue } from '@/hooks/useFarcasterSearch';
import type { ProcessedAttachment } from '@/services/media/imageAttachment';
import type { Channel, Emoji, SpaceMember, Sticker, Role, Space } from '@quilibrium/quorum-shared';
import { hasPermission, getRoleColorHex } from '@quilibrium/quorum-shared';
import { searchEmojis } from '@/data/emojiData';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, useWindowDimensions, NativeSyntheticEvent, Platform, ScrollView, StyleSheet, Text, TextInput, TextInputSubmitEditingEventData, TouchableOpacity as RNTouchableOpacity, View } from 'react-native';
import Reanimated, { useAnimatedStyle, useDerivedValue, withTiming, interpolate, interpolateColor, Easing } from 'react-native-reanimated';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useComposerPanel } from '@/hooks/useComposerPanel';
import { composerPanelVisibleStore } from '@/services/ui/composerPanelVisible';
import { composerFootprintSV } from '@/services/ui/composerFootprint';
import * as Skin from '@/theme/skins/geometry';
import type { LayoutChangeEvent } from 'react-native';


export interface ReplyToMessage {
  messageId: string;
  senderName: string;
  text: string;
}

export interface EditingMessage {
  messageId: string;
  originalText: string;
}

interface MessageInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  channelName: string;
  theme: AppTheme;
  isSending?: boolean;
  disabled?: boolean;
  onAttachmentPress?: () => void;
  onMentionPress?: () => void;
  onEmojiPress?: () => void;
  /** Pending image attachment to preview */
  pendingAttachment?: ProcessedAttachment | null;
  /** Clear the pending attachment */
  onClearAttachment?: () => void;
  /** Message being replied to */
  replyTo?: ReplyToMessage | null;
  /** Dismiss the reply */
  onDismissReply?: () => void;
  /** Bottom safe area inset */
  bottomInset?: number;
  /**
   * Resting height of the bottom chrome (the tab bar) the composer floats above.
   * The composer overlay sits at `bottom: 0`; this is the clearance the animated
   * spacer holds at rest so the pill floats above the tab bar, and which the
   * keyboard/panel footprint grows past when it opens. Pass the raw tab-bar
   * height (do NOT zero it while the panel is open).
   */
  restingChromeHeight?: number;
  /** Custom emojis for the space */
  customEmojis?: Emoji[];
  /** Stickers for the space */
  stickers?: Sticker[];
  /** Callback when sticker is selected */
  onSendSticker?: (stickerId: string) => void;
  /** Members for @mention autocomplete */
  members?: SpaceMember[];
  /** Channels for #channel autocomplete */
  channels?: Channel[];
  /** Roles for @role autocomplete */
  roles?: Role[];
  /** Current user's address — gates the @everyone autocomplete option. */
  currentUserId?: string;
  /** Space context — used to check the mention:everyone permission. */
  space?: Space | null;
  /** Message being edited */
  editingMessage?: EditingMessage | null;
  /** Cancel editing */
  onCancelEdit?: () => void;
  /** Whether this is a DM input (changes placeholder format) */
  isDM?: boolean;
  /** When the reply target is a Farcaster cast, the input shows an opt-in
   *  "also reply on Farcaster" checkbox. The parent owns the boolean. */
  castReplyAvailable?: boolean;
  alsoReplyOnFarcaster?: boolean;
  onToggleAlsoReplyOnFarcaster?: (next: boolean) => void;
  /** Show the per-message signing lock button. Only true when the conversation/
   *  space left signing optional (DM: isRepudiable; Space: space.isRepudiable). */
  signingOptional?: boolean;
  /** Lock open ⇒ this message will be sent unsigned (repudiable). */
  skipSigning?: boolean;
  onToggleSkipSigning?: () => void;
}

export interface MessageInputHandle {
  focus: () => void;
}

// Emoji categories with local emoji data
const EMOJI_CATEGORIES = {
  recent: {
    name: 'Recent',
    icon: '🕐',
    emojis: [] as string[], // Will be populated from frecency
  },
  smileys: {
    name: 'Smileys',
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
      '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺️', '😚',
      '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭',
      '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄',
      '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕',
      '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳',
      '🥸', '😎', '🤓', '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯',
      '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭',
      '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡',
      '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺',
      '👻', '👽', '👾', '🤖', '😺', '😸', '😹', '😻', '😼', '😽',
      '🙀', '😿', '😾',
    ],
  },
  gestures: {
    name: 'Gestures',
    icon: '👋',
    emojis: [
      '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
      '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍',
      '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝',
      '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂',
      '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅',
      '👄', '💋', '🩸',
    ],
  },
  symbols: {
    name: 'Symbols',
    icon: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️',
      '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐',
      '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐',
      '♑', '♒', '♓', '🆔', '⚛️', '🔥', '✨', '⭐', '🌟', '💫',
      '💥', '💦', '💨', '🕳️', '💣', '💬', '👁️‍🗨️', '🗨️', '🗯️', '💭',
      '💤', '💯', '💢', '💠', '⚜️', '🔱', '📛', '🔰', '⭕', '✅',
      '☑️', '✔️', '❌', '❎', '➕', '➖', '➗', '✖️', '♾️', '‼️',
      '⁉️', '❓', '❔', '❕', '❗', '〰️', '💲', '⚕️', '♻️', '⚧️',
    ],
  },
  nature: {
    name: 'Nature',
    icon: '🐶',
    emojis: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨',
      '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊',
      '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉',
      '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌',
      '🐞', '🐜', '🪰', '🪲', '🪳', '🦟', '🦗', '🕷️', '🕸️', '🦂',
      '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀',
      '🌸', '💮', '🏵️', '🌹', '🥀', '🌺', '🌻', '🌼', '🌷', '🌱',
      '🪴', '🌲', '🌳', '🌴', '🌵', '🌾', '🌿', '☘️', '🍀', '🍁',
    ],
  },
  food: {
    name: 'Food',
    icon: '🍔',
    emojis: [
      '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐',
      '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑',
      '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅',
      '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳',
      '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔',
      '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗',
      '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠',
      '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬',
      '🍫', '🍿', '🍩', '🍪', '☕', '🍵', '🧃', '🥤', '🍺', '🍻',
    ],
  },
  activities: {
    name: 'Activities',
    icon: '⚽',
    emojis: [
      '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
      '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳',
      '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷',
      '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏆', '🥇', '🥈', '🥉',
      '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️', '🎪', '🎭', '🩰', '🎨',
      '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🪘', '🎷', '🎺', '🪗',
      '🎸', '🪕', '🎻', '🎲', '♟️', '🎯', '🎳', '🎮', '🎰', '🧩',
    ],
  },
  objects: {
    name: 'Objects',
    icon: '💡',
    emojis: [
      '⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️',
      '💽', '💾', '💿', '📀', '📷', '📸', '📹', '🎥', '📽️', '🎞️',
      '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '⏰',
      '⏱️', '⏲️', '🕰️', '⌛', '⏳', '📡', '🔋', '🔌', '💡', '🔦',
      '🕯️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎',
      '⚖️', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🔩', '⚙️', '🔫', '💣',
      '🔪', '🗡️', '⚔️', '🛡️', '🔮', '💊', '💉', '🌡️', '🚽', '🚿',
      '🔑', '🗝️', '🚪', '🛋️', '🛏️', '🎁', '🎈', '🎉', '🎊', '✉️',
    ],
  },
};

type CategoryKey = keyof typeof EMOJI_CATEGORIES | 'custom' | 'stickers' | 'recent';

// Lightweight emoji cell: a plain memoized touchable, skipping SkinTouchable's
// per-node theme/flatten/color work (pure overhead for an always-transparent
// button). ~120 of these mount on first open.
const EmojiCell = React.memo(function EmojiCell({
  emoji,
  onSelect,
  buttonStyle,
  textStyle,
}: {
  emoji: string;
  onSelect: (emoji: string) => void;
  buttonStyle: object;
  textStyle: object;
}) {
  const handlePress = useCallback(() => onSelect(emoji), [emoji, onSelect]);
  return (
    <RNTouchableOpacity style={buttonStyle} onPress={handlePress}>
      <Text style={textStyle}>{emoji}</Text>
    </RNTouchableOpacity>
  );
});

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput({
  value,
  onChangeText,
  onSend,
  channelName,
  theme,
  isSending = false,
  disabled = false,
  onAttachmentPress,
  onMentionPress,
  onEmojiPress,
  pendingAttachment,
  onClearAttachment,
  replyTo,
  onDismissReply,
  bottomInset = 0,
  restingChromeHeight = 0,
  customEmojis = [],
  stickers = [],
  onSendSticker,
  members = [],
  channels = [],
  roles = [],
  currentUserId,
  space,
  editingMessage,
  onCancelEdit,
  isDM = false,
  castReplyAvailable = false,
  alsoReplyOnFarcaster = false,
  onToggleAlsoReplyOnFarcaster,
  signingOptional = false,
  skipSigning = false,
  onToggleSkipSigning,
}, ref) {
  const { width: screenWidth } = useWindowDimensions();
  const styles = useMemo(() => createStyles(theme), [theme]);
  // Keyboard/inset/rotation-driven values applied inline so the whole
  // stylesheet isn't rebuilt every time the insets or screen width change.
  const containerDynamicStyle = useMemo(() => ({
    width: screenWidth,
  }), [screenWidth]);
  const inputRef = useRef<TextInput>(null);
  const valueRef = useRef(value);
  const onChangeTextRef = useRef(onChangeText);
  valueRef.current = value;
  onChangeTextRef.current = onChangeText;
  // Keyboard <-> emoji-panel choreography. The panel opens downward,
  // replacing the keyboard in the same footprint.
  const composerPanel = useComposerPanel({
    // Resting gap below the pill carries only a genuine safe-area inset (passed
    // by screens with no tab bar to cover it). The small constant gap is the
    // pill's own marginBottom, applied in BOTH states — so the no-keyboard
    // spacing matches the tighter keyboard-up spacing instead of being larger.
    bottomInset,
    // The tab-bar clearance the spacer holds at rest (overlay sits at bottom: 0).
    restingChromeHeight,
    // Publish open/close synchronously (in the toggle action, not via an effect)
    // so the tab bar hides/shows in the same tick — no extra render-cycle lag.
    onPanelVisibilityChange: composerPanelVisibleStore.set,
  });
  const showEmojiPicker = composerPanel.panelOpen;
  const keyboardVisible = composerPanel.keyboardVisible;
  // Panel VISIBILITY is driven on the UI thread by panelVisibleSV (opacity, see
  // panelOpacityStyle): painted behind a fully-up keyboard (preload → instant
  // reveal on open) and hidden in lockstep as the keyboard descends (no peek
  // below the tab bar). `panelShown` is the React mirror, used only for
  // pointerEvents (touch-inertness; a frame of lag here is harmless because the
  // panel is either behind the keyboard or in the collapsed resting spacer).
  const panelShown = keyboardVisible || showEmojiPicker;
  const panelOpacityStyle = useAnimatedStyle(() => ({
    opacity: composerPanel.panelVisibleSV.value,
  }));
  // Mount latch: build the (heavy) panel on first need — the panel opening or a
  // keyboard coming up (so the grid is pre-built before the first emoji tap) —
  // then keep it mounted. Reopening is a pure reveal. Resets per chat (remount).
  const [panelEverNeeded, setPanelEverNeeded] = useState(false);
  useEffect(() => {
    if (keyboardVisible || showEmojiPicker) setPanelEverNeeded(true);
  }, [keyboardVisible, showEmojiPicker]);
  const panelPresent = panelEverNeeded;
  const showEmojiGrid = panelEverNeeded;
  const [selectedCategory, setSelectedCategory] = useState<CategoryKey>('smileys');
  const [searchQuery, setSearchQuery] = useState('');
  // When the input wraps to multiple lines the pill switches from a single-line
  // stadium (fully rounded, controls centered) to a grown box (moderate corner
  // radius, controls pinned to the bottom/last line). Driven by the measured
  // content height so it adapts to the device's font metrics.
  const [isMultiline, setIsMultiline] = useState(false);

  // Animated spacer/panel container under the pill — follows the keyboard
  // when the panel is closed, holds the keyboard footprint when it's open.
  const spacerAnimatedStyle = useAnimatedStyle(() => ({
    height: composerPanel.spacerHeight.value,
  }));

  // Emoji frecency tracking
  const { recentEmojis, trackEmoji, refreshRecent } = useEmojiFrecency();

  // Refresh recent emojis when picker opens
  useEffect(() => {
    if (showEmojiPicker) {
      refreshRecent();
    }
  }, [showEmojiPicker, refreshRecent]);

  // The panel's open/close is published synchronously via the hook's
  // onPanelVisibilityChange (see useComposerPanel call above). This effect only
  // guards unmount: a composer leaving the tree must never leave the tab bar
  // hidden.
  useEffect(() => () => composerPanelVisibleStore.set(false), []);

  // Autocomplete state
  const [autocompleteType, setAutocompleteType] = useState<'mention' | 'channel' | null>(null);
  const [autocompleteQuery, setAutocompleteQuery] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  // Debounce the query that feeds the filter memos so fast typing doesn't
  // re-filter the full member/channel lists on every keystroke. Trigger
  // detection ('@'/'#' showing or hiding the popup) stays immediate.
  const debouncedAutocompleteQuery = useDebouncedValue(autocompleteQuery, 150);

  // Expose focus method to parent
  // On Android, blur first to ensure keyboard shows when re-focusing after modal dismiss
  useImperativeHandle(ref, () => ({
    focus: () => {
      // Already focused (e.g. the refocus fired right after sending a
      // message): the keyboard is up, so re-running the Android
      // blur/refocus dance would visibly dismiss and re-show it. No-op.
      if (inputRef.current?.isFocused()) return;
      if (Platform.OS === 'android') {
        inputRef.current?.blur();
        setTimeout(() => {
          inputRef.current?.focus();
        }, 100);
      } else {
        inputRef.current?.focus();
      }
    },
  }));

  // Can send if we have text OR an attachment
  const canSend = (value.trim().length > 0 || !!pendingAttachment) && !isSending && !disabled;

  const handleSend = useCallback(() => {
    if (canSend) {
      onSend();
    }
  }, [canSend, onSend]);

  const handleSubmitEditing = useCallback(
    (e: NativeSyntheticEvent<TextInputSubmitEditingEventData>) => {
      if (canSend) {
        onSend();
      }
    },
    [canSend, onSend]
  );

  const handleToggleEmojiPicker = useCallback(() => {
    setSearchQuery('');
    composerPanel.togglePanel();
  }, [composerPanel]);

  const handleSelectEmoji = useCallback((emoji: string) => {
    const newValue = valueRef.current + emoji;
    onChangeTextRef.current(newValue);
    // Track usage for frecency (only standard emojis, not custom)
    if (!emoji.startsWith(':')) {
      trackEmoji(emoji);
    }
  }, [trackEmoji]);

  const handleSelectSticker = useCallback((stickerId: string) => {
    if (onSendSticker) {
      onSendSticker(stickerId);
      composerPanel.closePanel();
      setSearchQuery('');
    }
  }, [onSendSticker, composerPanel]);

  // Handle text changes and detect @mention or #channel triggers
  const handleTextChange = useCallback((newText: string) => {
    onChangeText(newText);

    // Typing dismisses the emoji panel. The soft-keyboard path already does
    // this via the input's onFocus, but a hardware/Bluetooth keyboard types
    // into an already-focused input without re-firing focus, so close here too.
    composerPanel.closePanel();

    // Find the word being typed at cursor position
    const textUpToCursor = newText.slice(0, cursorPosition + (newText.length - value.length));
    const lastAtIndex = textUpToCursor.lastIndexOf('@');
    const lastHashIndex = textUpToCursor.lastIndexOf('#');
    const lastSpaceIndex = Math.max(textUpToCursor.lastIndexOf(' '), textUpToCursor.lastIndexOf('\n'));

    // Check for @mention trigger (no spaces allowed in mentions)
    if (lastAtIndex > lastSpaceIndex && lastAtIndex >= 0) {
      const query = textUpToCursor.slice(lastAtIndex + 1);
      if (!/\s/.test(query)) {
        setAutocompleteType('mention');
        setAutocompleteQuery(query.toLowerCase());
        return;
      }
    }

    // Check for #channel trigger (spaces allowed - channel names can have spaces)
    if (lastHashIndex >= 0) {
      const query = textUpToCursor.slice(lastHashIndex + 1);
      // Check if any channel name starts with this query (case insensitive)
      const hasMatchingChannel = channels.some((c) =>
        c.channelName.toLowerCase().startsWith(query.toLowerCase())
      );
      if (hasMatchingChannel) {
        setAutocompleteType('channel');
        setAutocompleteQuery(query.toLowerCase());
        return;
      }
    }

    // No trigger found
    setAutocompleteType(null);
    setAutocompleteQuery('');
  }, [onChangeText, cursorPosition, value, channels, composerPanel]);

  // Whether the current user may mention @everyone in this space. Gates the
  // @everyone autocomplete option (mirrors desktop — silently omit when the
  // user lacks the permission rather than showing it disabled).
  const canMentionEveryone = useMemo(() => {
    if (!currentUserId || !space) return false;
    return hasPermission(currentUserId, 'mention:everyone', space);
  }, [currentUserId, space]);

  // Combined @mention suggestions: @everyone first (when permitted and it
  // matches the query), then matching roles, then matching members. Capped at
  // 8 total. A discriminated union keeps the render + insert logic per-kind.
  type MentionSuggestion =
    | { kind: 'everyone' }
    | { kind: 'role'; role: Role }
    | { kind: 'member'; member: SpaceMember };

  const mentionSuggestions = useMemo((): MentionSuggestion[] => {
    if (autocompleteType !== 'mention') return [];
    const q = debouncedAutocompleteQuery;
    const out: MentionSuggestion[] = [];

    // @everyone — show when permitted and the query is a prefix of "everyone"
    // (empty query counts, so "@" alone surfaces it first).
    if (canMentionEveryone && 'everyone'.startsWith(q)) {
      out.push({ kind: 'everyone' });
    }

    // Roles — match by tag or display name.
    for (const role of roles) {
      const tag = (role.roleTag || '').toLowerCase();
      const name = (role.displayName || '').toLowerCase();
      if (tag.includes(q) || name.includes(q)) {
        out.push({ kind: 'role', role });
      }
    }

    // Members — match by display name, name, or address.
    for (const m of members) {
      const displayName = (m.display_name || '').toLowerCase();
      const name = (m.name || '').toLowerCase();
      const address = (m.address || '').toLowerCase();
      if (displayName.includes(q) || name.includes(q) || address.includes(q)) {
        out.push({ kind: 'member', member: m });
      }
    }

    return out.slice(0, 8);
  }, [autocompleteType, debouncedAutocompleteQuery, canMentionEveryone, roles, members]);

  // Filter channels for channel autocomplete - match from start of name
  const filteredChannels = useMemo(() => {
    if (autocompleteType !== 'channel') return [];
    return channels.filter((c) => {
      return c.channelName.toLowerCase().startsWith(debouncedAutocompleteQuery);
    }).slice(0, 6);
  }, [autocompleteType, debouncedAutocompleteQuery, channels]);

  // Insert selected mention - uses address for reliable matching, renders as display name
  const handleSelectMention = useCallback((member: SpaceMember) => {
    const textUpToCursor = value.slice(0, cursorPosition);
    const lastAtIndex = textUpToCursor.lastIndexOf('@');
    const textAfterCursor = value.slice(cursorPosition);

    // Use canonical @<address> format (matches desktop wire format)
    const newText = value.slice(0, lastAtIndex) + `@<${member.address}> ` + textAfterCursor;
    onChangeText(newText);
    setAutocompleteType(null);
    setAutocompleteQuery('');
  }, [value, cursorPosition, onChangeText]);

  // Insert @everyone — stored as the literal token (no angle brackets), matching
  // desktop's wire format.
  const handleSelectEveryone = useCallback(() => {
    const textUpToCursor = value.slice(0, cursorPosition);
    const lastAtIndex = textUpToCursor.lastIndexOf('@');
    const textAfterCursor = value.slice(cursorPosition);

    const newText = value.slice(0, lastAtIndex) + `@everyone ` + textAfterCursor;
    onChangeText(newText);
    setAutocompleteType(null);
    setAutocompleteQuery('');
  }, [value, cursorPosition, onChangeText]);

  // Insert a role mention as `@roleTag` (NO angle brackets). This is the wire
  // format the shared extractMentionsFromText understands — it matches @roleTag
  // against spaceRoles by tag and populates mentions.roleIds, which is what
  // drives role-mention notifications. (The earlier @<roleId> form matched
  // neither the user-mention CID regex nor the role-tag regex, so role mentions
  // were silently dropped from the wire and never notified.) Matches desktop's
  // MessageComposer, which also inserts `@${roleTag}`.
  const handleSelectRole = useCallback((role: Role) => {
    const textUpToCursor = value.slice(0, cursorPosition);
    const lastAtIndex = textUpToCursor.lastIndexOf('@');
    const textAfterCursor = value.slice(cursorPosition);

    const newText = value.slice(0, lastAtIndex) + `@${role.roleTag} ` + textAfterCursor;
    onChangeText(newText);
    setAutocompleteType(null);
    setAutocompleteQuery('');
  }, [value, cursorPosition, onChangeText]);

  // Insert selected channel — uses the canonical #<channelId> wire format
  // (matches desktop). Renders as #channelName via the channels prop, and is
  // tappable in both the plain and markdown render paths.
  const handleSelectChannel = useCallback((channel: Channel) => {
    const textUpToCursor = value.slice(0, cursorPosition);
    const lastHashIndex = textUpToCursor.lastIndexOf('#');
    const textAfterCursor = value.slice(cursorPosition);

    const newText = value.slice(0, lastHashIndex) + `#<${channel.channelId}> ` + textAfterCursor;
    onChangeText(newText);
    setAutocompleteType(null);
    setAutocompleteQuery('');
  }, [value, cursorPosition, onChangeText]);

  // Track cursor position
  const handleSelectionChange = useCallback((event: { nativeEvent: { selection: { start: number; end: number } } }) => {
    setCursorPosition(event.nativeEvent.selection.end);
  }, []);

  // Detect single- vs multi-line from the measured content height so the pill
  // can switch shape. A single line is ~one lineHeight tall; once the content
  // exceeds ~1.5 lines it has wrapped. Using the measured height (not character
  // counting) keeps this correct across fonts/devices and for pasted newlines.
  const singleLineThreshold = Skin.font(22) * 1.5;
  const handleContentSizeChange = useCallback(
    (event: { nativeEvent: { contentSize: { height: number } } }) => {
      const next = event.nativeEvent.contentSize.height > singleLineThreshold;
      setIsMultiline((prev) => (prev === next ? prev : next));
    },
    [singleLineThreshold]
  );

  // Measure the composer's on-screen footprint (the pill + any reply/edit banner
  // + attachment preview — everything ABOVE the keyboard/panel spacer) and write
  // it to the shared value the chat list's KeyboardChatScrollView reads as
  // `extraContentPadding`. This makes the keyboard-open lift clear `keyboard +
  // composer` (not just the keyboard), so the newest message rests above the
  // pill in every state — single line, wrapped multi-line, image preview, reply
  // banner. Writing a SharedValue (not React state) keeps it off the re-render
  // path; the consumer reads it on the UI thread.
  const handleFootprintLayout = useCallback((e: LayoutChangeEvent) => {
    composerFootprintSV.value = e.nativeEvent.layout.height;
  }, []);

  // Build categories list including custom emojis, stickers, and recent if available
  const categories = useMemo(() => {
    const result: { key: CategoryKey; name: string; icon: string }[] = [];

    // Add Recent first if there are recent emojis
    if (recentEmojis.length > 0) {
      result.push({ key: 'recent', name: 'Recent', icon: '🕐' });
    }

    if (customEmojis.length > 0) {
      result.push({ key: 'custom', name: 'Custom', icon: '⭐' });
    }
    if (stickers.length > 0) {
      result.push({ key: 'stickers', name: 'Stickers', icon: '🖼️' });
    }

    // Add standard categories (excluding 'recent' since we handle it separately)
    Object.entries(EMOJI_CATEGORIES).forEach(([key, cat]) => {
      if (key !== 'recent') {
        result.push({ key: key as CategoryKey, name: cat.name, icon: cat.icon });
      }
    });

    return result;
  }, [customEmojis.length, stickers.length, recentEmojis.length]);

  // Get emojis for selected category
  const displayEmojis = useMemo((): string[] => {
    if (selectedCategory === 'custom' || selectedCategory === 'stickers') {
      return [];
    }
    if (selectedCategory === 'recent') {
      return recentEmojis;
    }
    if (selectedCategory in EMOJI_CATEGORIES) {
      return EMOJI_CATEGORIES[selectedCategory as keyof typeof EMOJI_CATEGORIES].emojis;
    }
    return [];
  }, [selectedCategory, recentEmojis]);

  // Filter by search if query exists
  const filteredEmojis = useMemo((): string[] => {
    if (!searchQuery) return displayEmojis;

    // Search all emoji categories
    const allEmojis = Object.values(EMOJI_CATEGORIES).flatMap((cat) => cat.emojis);
    const uniqueEmojis = [...new Set(allEmojis)];
    return searchEmojis(searchQuery, uniqueEmojis);
  }, [searchQuery, displayEmojis]);

  // Filter custom emojis by search
  const filteredCustomEmojis = useMemo(() => {
    if (!searchQuery) return customEmojis;
    const lowerQuery = searchQuery.toLowerCase();
    return customEmojis.filter((e) => e.name.toLowerCase().includes(lowerQuery));
  }, [searchQuery, customEmojis]);

  // Filter stickers by search
  const filteredStickers = useMemo(() => {
    if (!searchQuery) return stickers;
    const lowerQuery = searchQuery.toLowerCase();
    return stickers.filter((s) => s.name.toLowerCase().includes(lowerQuery));
  }, [searchQuery, stickers]);

  // Attach (+) hides while composing so the text has more room; it reappears
  // when the input is empty. Emoji toggle always stays.
  const isComposing = value.trim().length > 0;

  // Brief feedback pill shown above the composer when the signing lock is tapped.
  const [signingHint, setSigningHint] = useState<string | null>(null);
  const signingHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (signingHintTimer.current) clearTimeout(signingHintTimer.current);
  }, []);
  const handleToggleSigning = useCallback(() => {
    onToggleSkipSigning?.();
    // skipSigning is the value BEFORE the toggle, so invert it for the new state.
    setSigningHint(skipSigning ? 'Messages will be signed' : "Messages won't be signed");
    if (signingHintTimer.current) clearTimeout(signingHintTimer.current);
    signingHintTimer.current = setTimeout(() => setSigningHint(null), 1800);
  }, [onToggleSkipSigning, skipSigning]);

  // --- Composer focus/compose micro-animations ---------------------------
  // Two driven progress values so the transitions are smooth instead of
  // snapping:
  //   composeProgress — 0 idle, 1 composing. Slides the paperclip to the
  //     right, fades it out, and collapses its width so the input reclaims
  //     the space. Reverses when the input is cleared.
  //   sendProgress    — 0 can't-send, 1 can-send. Cross-fades the send
  //     button from the muted grey surface to the accent color.
  const TIMING = { duration: 180, easing: Easing.out(Easing.quad) };
  const composeProgress = useDerivedValue(
    () => withTiming(isComposing ? 1 : 0, TIMING),
    [isComposing],
  );
  const sendProgress = useDerivedValue(
    () => withTiming(canSend ? 1 : 0, TIMING),
    [canSend],
  );

  // Width the paperclip occupies when shown: icon (27) + button padding
  // (6 each side). Collapsing it to 0 lets the input grow without a jump.
  const ATTACH_WIDTH = 27 + Skin.space(6) * 2;
  const attachAnimatedStyle = useAnimatedStyle(() => ({
    width: interpolate(composeProgress.value, [0, 1], [ATTACH_WIDTH, 0]),
    opacity: interpolate(composeProgress.value, [0, 1], [1, 0]),
    transform: [{ translateX: interpolate(composeProgress.value, [0, 1], [0, ATTACH_WIDTH]) }],
  }));
  const sendAnimatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      sendProgress.value,
      [0, 1],
      [theme.colors.surface7, theme.colors.accent],
    ),
    opacity: interpolate(sendProgress.value, [0, 1], [0.6, 1]),
  }));

  // Panel markup inside the spacer. Mounted once needed (keyboard up or panel
  // open) and then kept mounted; visible whenever `panelShown` (so it sits
  // preloaded behind the keyboard and is revealed when the keyboard dismisses),
  // hidden otherwise. Memoized.
  const emojiPanelContent = useMemo(() => {
    if (!panelPresent) return null;
    return (
    <View style={styles.emojiPanelInner} pointerEvents={panelShown ? 'auto' : 'none'}>
      {/* Search bar */}
      <View style={styles.searchContainer}>
        <IconSymbol name="magnifyingglass" size={16} color={theme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search emoji..."
          placeholderTextColor={theme.colors.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          onFocus={composerPanel.onSearchFocus}
          onBlur={composerPanel.onSearchBlur}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={8}>
            <IconSymbol name="xmark.circle.fill" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
        )}
        {/* Close the emoji panel. Far right of the search row. */}
        <TouchableOpacity
          onPress={() => composerPanel.closePanel()}
          hitSlop={8}
          style={styles.panelCloseButton}
          accessibilityRole="button"
          accessibilityLabel="Close emoji panel"
        >
          <IconSymbol name="xmark" size={18} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Category tabs */}
      {!searchQuery && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.categoryTabs}
          contentContainerStyle={styles.categoryTabsContent}
          keyboardShouldPersistTaps="always"
        >
          {categories.map((cat) => (
            <TouchableOpacity
              key={cat.key}
              style={[
                styles.categoryTab,
                selectedCategory === cat.key && styles.categoryTabActive,
              ]}
              onPress={() => setSelectedCategory(cat.key)}
            >
              <Text style={styles.categoryTabEmoji}>{cat.icon}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Grid mounts on first need (latched), then stays. Placeholder holds the
          height before that so the first fill-in doesn't jump. */}
      {!showEmojiGrid ? (
        <View style={styles.emojiGrid} />
      ) : (
      <ScrollView
        style={styles.emojiGrid}
        contentContainerStyle={styles.emojiGridContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
      >
        {/* Show search results across all categories */}
        {searchQuery && (
          <>
            {filteredCustomEmojis.length > 0 && (
              <View style={styles.emojiSection}>
                <Text style={styles.emojiSectionTitle}>Custom</Text>
                <View style={styles.emojiRow}>
                  {filteredCustomEmojis.map((emoji) => (
                    <TouchableOpacity
                      key={emoji.id}
                      style={styles.emojiButton}
                      onPress={() => handleSelectEmoji(`:${emoji.name}:`)}
                    >
                      <Image
                        source={{ uri: emoji.imgUrl }}
                        style={styles.customEmojiImage}
                        resizeMode="contain"
                      />
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            {filteredStickers.length > 0 && (
              <View style={styles.emojiSection}>
                <Text style={styles.emojiSectionTitle}>Stickers</Text>
                <View style={styles.stickerRow}>
                  {filteredStickers.map((sticker) => (
                    <TouchableOpacity
                      key={sticker.id}
                      style={styles.stickerButton}
                      onPress={() => handleSelectSticker(sticker.id)}
                    >
                      <Image
                        source={{ uri: sticker.imgUrl }}
                        style={styles.stickerImage}
                        resizeMode="contain"
                      />
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            {filteredEmojis.length > 0 && (
              <View style={styles.emojiSection}>
                <Text style={styles.emojiSectionTitle}>Emoji</Text>
                <View style={styles.emojiRow}>
                  {filteredEmojis.map((emoji, index) => (
                    <EmojiCell
                      key={`${emoji}-${index}`}
                      emoji={emoji}
                      onSelect={handleSelectEmoji}
                      buttonStyle={styles.emojiButton}
                      textStyle={styles.emoji}
                    />
                  ))}
                </View>
              </View>
            )}
            {filteredEmojis.length === 0 && filteredCustomEmojis.length === 0 && filteredStickers.length === 0 && (
              <Text style={styles.emptyText}>No results found</Text>
            )}
          </>
        )}

        {/* Show category content when not searching */}
        {!searchQuery && selectedCategory === 'custom' && (
          <View style={styles.emojiRow}>
            {customEmojis.map((emoji) => (
              <TouchableOpacity
                key={emoji.id}
                style={styles.emojiButton}
                onPress={() => handleSelectEmoji(`:${emoji.name}:`)}
              >
                <Image
                  source={{ uri: emoji.imgUrl }}
                  style={styles.customEmojiImage}
                  resizeMode="contain"
                />
              </TouchableOpacity>
            ))}
            {customEmojis.length === 0 && (
              <Text style={styles.emptyText}>No custom emoji</Text>
            )}
          </View>
        )}

        {!searchQuery && selectedCategory === 'stickers' && (
          <View style={styles.stickerRow}>
            {stickers.map((sticker) => (
              <TouchableOpacity
                key={sticker.id}
                style={styles.stickerButton}
                onPress={() => handleSelectSticker(sticker.id)}
              >
                <Image
                  source={{ uri: sticker.imgUrl }}
                  style={styles.stickerImage}
                  resizeMode="contain"
                />
              </TouchableOpacity>
            ))}
            {stickers.length === 0 && (
              <Text style={styles.emptyText}>No stickers</Text>
            )}
          </View>
        )}

        {!searchQuery && selectedCategory !== 'custom' && selectedCategory !== 'stickers' && (
          <View style={styles.emojiRow}>
            {displayEmojis.map((emoji, index) => (
              <EmojiCell
                key={`${emoji}-${index}`}
                emoji={emoji}
                onSelect={handleSelectEmoji}
                buttonStyle={styles.emojiButton}
                textStyle={styles.emoji}
              />
            ))}
            {selectedCategory === 'recent' && displayEmojis.length === 0 && (
              <Text style={styles.emptyText}>No recent emojis</Text>
            )}
          </View>
        )}
      </ScrollView>
      )}
    </View>
    );
  }, [
    panelPresent,
    panelShown,
    showEmojiGrid,
    searchQuery,
    selectedCategory,
    categories,
    displayEmojis,
    filteredEmojis,
    filteredCustomEmojis,
    filteredStickers,
    customEmojis,
    stickers,
    handleSelectEmoji,
    handleSelectSticker,
    composerPanel.onSearchFocus,
    composerPanel.onSearchBlur,
    composerPanel.closePanel,
    styles,
    theme,
  ]);

  return (
    <View style={[styles.container, containerDynamicStyle]}>
      {/* Composer footprint: everything above the keyboard/panel spacer (banners
          + attachment preview + autocomplete anchor + pill). Measured so the
          chat list can lift to clear the composer exactly in every state. */}
      <View onLayout={handleFootprintLayout}>
      {/* Brief signing-state feedback when the lock is tapped. */}
      {signingHint && (
        <View style={styles.signingHintRow} pointerEvents="none">
          <View style={styles.signingHintPill}>
            <IconSymbol
              name={skipSigning ? 'lock.open' : 'lock'}
              size={13}
              color={theme.colors.textSubtle}
              strokeWidth={1.5}
            />
            <Text style={styles.signingHintText}>{signingHint}</Text>
          </View>
        </View>
      )}
      {/* Edit mode preview */}
      {editingMessage && (
        <View style={styles.editContainer}>
          <View style={styles.editBar} />
          <View style={styles.editContent}>
            <Text style={styles.editLabel}>Editing Message</Text>
            <Text style={styles.editOriginalText} numberOfLines={1}>
              {editingMessage.originalText}
            </Text>
          </View>
          <TouchableOpacity onPress={onCancelEdit} style={styles.replyDismiss}>
            <IconSymbol name="xmark" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
      )}

      {/* Reply-to preview */}
      {replyTo && !editingMessage && (
        <View>
          <View style={styles.replyContainer}>
            <View style={styles.replyBar} />
            <View style={styles.replyContent}>
              <Text style={styles.replySender} numberOfLines={1}>
                Replying to {replyTo.senderName}
              </Text>
              <Text style={styles.replyText} numberOfLines={1}>
                {replyTo.text}
              </Text>
            </View>
            <TouchableOpacity onPress={onDismissReply} style={styles.replyDismiss}>
              <IconSymbol name="xmark" size={16} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          {castReplyAvailable && (
            <TouchableOpacity
              onPress={() => onToggleAlsoReplyOnFarcaster?.(!alsoReplyOnFarcaster)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: Skin.space(8),
                paddingHorizontal: Skin.space(12),
                paddingVertical: Skin.space(6),
              }}
              activeOpacity={0.7}
            >
              <View
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: Skin.radius(4),
                  borderWidth: Skin.border(2),
                  borderColor: alsoReplyOnFarcaster ? theme.colors.accent : theme.colors.textMuted,
                  backgroundColor: alsoReplyOnFarcaster ? theme.colors.accent : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {alsoReplyOnFarcaster && <IconSymbol name="checkmark" size={11} color="#fff" />}
              </View>
              <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(13) }}>
                Also reply on Farcaster
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Image preview */}
      {pendingAttachment && (
        <View style={styles.previewContainer}>
          <View style={styles.previewWrapper}>
            <TouchableOpacity
              style={styles.previewCloseButton}
              onPress={onClearAttachment}
            >
              <IconSymbol name="xmark.circle.fill" size={24} color={theme.colors.textMain} />
            </TouchableOpacity>
            <Image
              source={{ uri: pendingAttachment.localUri }}
              style={styles.previewImage}
              resizeMode="cover"
            />
            {pendingAttachment.isLargeGif && (
              <View style={styles.gifBadge}>
                <Text style={styles.gifBadgeText}>GIF</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Autocomplete popup — anchored above the pill */}
      {autocompleteType && (mentionSuggestions.length > 0 || filteredChannels.length > 0) && (
        <View style={styles.autocompleteContainer}>
          <ScrollView
            style={styles.autocompleteList}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            {autocompleteType === 'mention' && mentionSuggestions.map((s) => {
              if (s.kind === 'everyone') {
                return (
                  <TouchableOpacity
                    key="mention-everyone"
                    style={styles.autocompleteItem}
                    onPress={handleSelectEveryone}
                  >
                    <View style={styles.autocompleteAvatar}>
                      <IconSymbol name="bullhorn" size={14} color={theme.colors.primary} />
                    </View>
                    <Text style={styles.autocompleteText}>everyone</Text>
                    <Text style={styles.autocompleteHint}>Notify everyone</Text>
                  </TouchableOpacity>
                );
              }
              if (s.kind === 'role') {
                const color = getRoleColorHex(s.role.color);
                return (
                  <TouchableOpacity
                    key={`role-${s.role.roleId}`}
                    style={styles.autocompleteItem}
                    onPress={() => handleSelectRole(s.role)}
                  >
                    <View style={[styles.autocompleteAvatar, { backgroundColor: color + '30' }]}>
                      <IconSymbol name="at" size={14} color={color} />
                    </View>
                    <Text style={[styles.autocompleteText, { color }]}>{s.role.displayName}</Text>
                    <Text style={styles.autocompleteHint}>Role</Text>
                  </TouchableOpacity>
                );
              }
              const member = s.member;
              const avatarUri = member.profile_image || member.user_icon;
              return (
                <TouchableOpacity
                  key={`member-${member.address}`}
                  style={styles.autocompleteItem}
                  onPress={() => handleSelectMention(member)}
                >
                  <CachedAvatar
                    source={avatarUri ? { uri: avatarUri } : null}
                    style={styles.autocompleteAvatar}
                    fallbackName={member.display_name || member.name || member.address}
                  />
                  <Text style={styles.autocompleteText}>
                    {member.display_name || member.name || member.address}
                  </Text>
                </TouchableOpacity>
              );
            })}
            {autocompleteType === 'channel' && filteredChannels.map((channel) => (
              <TouchableOpacity
                key={channel.channelId}
                style={styles.autocompleteItem}
                onPress={() => handleSelectChannel(channel)}
              >
                <IconSymbol name="number" size={16} color={theme.colors.textMuted} />
                <Text style={styles.autocompleteText}>{channel.channelName}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* The composer pill — one rounded container with the emoji toggle on the
          left, the growing text input, then the attach + send buttons on the
          right. Single line: a fully-rounded stadium, text centered. Multi-line:
          a moderate-radius box with controls on the last line. The controls are
          bottom-pinned in BOTH states (button containers, not the pill, own the
          vertical align) so growing a line never moves them. No layout
          animation here — it raced the height growth and shoved the icons out
          of the pill for a frame before they snapped back. */}
      <View style={[styles.pill, isMultiline && styles.pillMultiline]}>
        <View style={styles.leftButtons}>
          <TouchableOpacity
            style={styles.inputIconButton}
            onPress={handleToggleEmojiPicker}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={showEmojiPicker ? 'Show keyboard' : 'Open emoji panel'}
          >
            <IconSymbol
              name={showEmojiPicker ? 'keyboard' : 'face.smiling'}
              color={showEmojiPicker ? theme.colors.primary : (disabled ? theme.colors.textMuted : theme.colors.textSubtle)}
              size={27}
              strokeWidth={1.5}
            />
          </TouchableOpacity>
        </View>

        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={handleTextChange}
          onSelectionChange={handleSelectionChange}
          onContentSizeChange={handleContentSizeChange}
          placeholder={editingMessage ? 'Edit message...' : 'Message...'}
          placeholderTextColor={theme.colors.textMuted}
          style={styles.input}
          editable={!disabled}
          returnKeyType="send"
          onSubmitEditing={handleSubmitEditing}
          blurOnSubmit={false}
          multiline
          scrollEnabled
          // Always 'center' — flipping this on the multi-line boundary was
          // unreliable on Android (the text sometimes stayed top-aligned after
          // shrinking back to one line). Centering the text block reads fine in
          // both states and is deterministic.
          textAlignVertical="center"
          onFocus={() => {
            composerPanel.onInputFocus();
            setSearchQuery('');
          }}
        />

        <View style={styles.rightButtons}>
          {/* Per-message signing lock — only when the conversation/space allows
              opt-out. Collapses while composing like the attach button. Outline
              lock = signed (default), open = repudiable. */}
          {signingOptional && (
            <Reanimated.View style={[styles.attachContainer, attachAnimatedStyle]}>
              <TouchableOpacity
                style={styles.inputIconButton}
                onPress={handleToggleSigning}
                disabled={disabled || isComposing}
                accessibilityRole="button"
                accessibilityLabel={skipSigning ? 'Message signing off (unsigned)' : 'Message signing on (signed)'}
              >
                <IconSymbol
                  name={skipSigning ? 'lock.open' : 'lock'}
                  color={skipSigning ? theme.colors.textMuted : theme.colors.primary}
                  size={25}
                  strokeWidth={1.5}
                />
              </TouchableOpacity>
            </Reanimated.View>
          )}
          {/* Attach slides right + fades out while composing to give the text
              room; it slides back when the input is cleared. Kept mounted (not
              conditionally unmounted) so it can animate in both directions, with
              its width collapsing to 0 so the input reclaims the space. */}
          <Reanimated.View style={[styles.attachContainer, attachAnimatedStyle]}>
            <TouchableOpacity
              style={styles.inputIconButton}
              onPress={onAttachmentPress}
              disabled={disabled || isComposing}
              accessibilityRole="button"
              accessibilityLabel="Attach image"
            >
              <IconSymbol
                name="paperclip"
                color={disabled ? theme.colors.textMuted : theme.colors.textSubtle}
                size={27}
                strokeWidth={1.5}
              />
            </TouchableOpacity>
          </Reanimated.View>
          <Reanimated.View style={[styles.sendButton, sendAnimatedStyle]}>
            <TouchableOpacity
              style={styles.sendButtonTouch}
              onPress={handleSend}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel="Send message"
            >
              {isSending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <SendIcon color="#fff" size={20} />
              )}
            </TouchableOpacity>
          </Reanimated.View>
        </View>
      </View>
      </View>{/* end composer footprint */}

      {/* Animated spacer beneath the pill. Closed: it follows the keyboard so
          the pill rides up (keyboard avoidance). Open: it holds the keyboard
          footprint and shows the emoji panel — no layout jump on swap. The inner
          opacity (panelOpacityStyle) hides the panel in lockstep with the
          keyboard on the UI thread, so it preloads behind a full keyboard but
          never peeks during a dismiss. */}
      <Reanimated.View style={spacerAnimatedStyle}>
        {emojiPanelContent && (
          <Reanimated.View style={[styles.panelOpacityWrap, panelOpacityStyle]}>
            {emojiPanelContent}
          </Reanimated.View>
        )}
      </Reanimated.View>
    </View>
  );
});

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: {
    // Transparent so chat messages scroll visibly behind the composer; only
    // the pill itself carries a surface. (The keyboard/emoji-panel spacer below
    // the pill is covered by the keyboard or the panel's own background, so the
    // transparency only reveals messages in the resting state.)
    backgroundColor: 'transparent',
    paddingHorizontal: Skin.space(12),
    paddingTop: Skin.space(8),
    // paddingBottom and width depend on insets/screen width and are
    // applied inline via containerDynamicStyle in the component.
  },
  replyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Skin.space(8),
    backgroundColor: theme.colors.surface5,
    borderRadius: Skin.radius(8),
    paddingVertical: Skin.space(8),
    paddingRight: Skin.space(8),
  },
  replyBar: {
    width: 3,
    height: '100%',
    backgroundColor: theme.colors.primary,
    borderRadius: Skin.radius(2),
    marginRight: Skin.space(8),
  },
  replyContent: {
    flex: 1,
  },
  replySender: {
    fontSize: Skin.font(12),
    fontFamily: theme.fonts.medium.fontFamily,
    fontWeight: theme.fonts.medium.fontWeight,
    color: theme.colors.primary,
    marginBottom: Skin.space(2),
  },
  replyText: {
    fontSize: Skin.font(13),
    fontFamily: theme.fonts.regular.fontFamily,
    color: theme.colors.textSubtle,
  },
  replyDismiss: {
    padding: Skin.space(4),
  },
  editContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Skin.space(8),
    backgroundColor: theme.colors.surface5,
    borderRadius: Skin.radius(8),
    paddingVertical: Skin.space(8),
    paddingRight: Skin.space(8),
  },
  editBar: {
    width: 3,
    height: '100%',
    backgroundColor: theme.colors.warning ?? '#f59e0b',
    borderRadius: Skin.radius(2),
    marginRight: Skin.space(8),
  },
  editContent: {
    flex: 1,
  },
  editLabel: {
    fontSize: Skin.font(12),
    fontFamily: theme.fonts.medium.fontFamily,
    fontWeight: theme.fonts.medium.fontWeight,
    color: theme.colors.warning ?? '#f59e0b',
    marginBottom: Skin.space(2),
  },
  editOriginalText: {
    fontSize: Skin.font(13),
    fontFamily: theme.fonts.regular.fontFamily,
    color: theme.colors.textSubtle,
  },
  previewContainer: {
    marginBottom: Skin.space(8),
  },
  previewWrapper: {
    position: 'relative',
    alignSelf: 'flex-start',
  },
  previewImage: {
    width: 100,
    height: 100,
    borderRadius: Skin.radius(8),
  },
  previewCloseButton: {
    position: 'absolute',
    top: -8,
    right: -8,
    zIndex: 1,
    backgroundColor: theme.colors.surface3,
    borderRadius: Skin.radius(12),
  },
  gifBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: Skin.space(6),
    paddingVertical: Skin.space(2),
    borderRadius: Skin.radius(4),
  },
  gifBadgeText: {
    color: '#fff',
    fontSize: Skin.font(10),
    fontWeight: 'bold',
  },
  // The single pill: rounded container holding left buttons, the growing
  // input, and the circular send button. Children are bottom-aligned so that
  // when the input wraps to multiple lines the buttons + send stay anchored to
  // the last line; for a single line everything lands on the same baseline.
  pill: {
    flexDirection: 'row',
    // `stretch` (not center/flex-end) so children fill the pill's height and we
    // NEVER flip alignItems on the 1->2 line boundary — that flip was what made
    // the emoji icon jump. Button position is controlled inside the button
    // containers (justifyContent: flex-end) and text position by the input's
    // own textAlignVertical, so neither depends on the pill's vertical align.
    alignItems: 'stretch',
    // Per-scheme semantic token: distinct raised surface on dark, white on light.
    backgroundColor: theme.colors.composerPillBg,
    // Large radius => the short ends are perfect semicircles while single-line.
    borderRadius: 999,
    // "Raised" cue via a per-scheme rim token (faint white top-light on dark,
    // subtle grey hairline on light where white-on-white would be invisible)
    // plus a soft shadow for lift. Both tuned per scheme by the token, not
    // eyeballed once on dark.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.composerPillBorder,
    // Per-scheme "raised" cue:
    //   DARK  — a soft drop shadow (shadows read well on dark).
    //   LIGHT — a visible hairline `borderColor` (above) plus a TIGHT elevation 1.
    //           elevation 1 on Android casts a low-diffusion shadow right under
    //           the pill — a crisp lift, not the heavy diffuse drop of 2+.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: theme.dark ? 0.10 : 0.06,
    shadowRadius: theme.dark ? 5 : 3,
    elevation: theme.dark ? 5 : 1,
    // Uniform inner padding on all four sides: the send circle then has the
    // same gap to the right edge as it does to the top/bottom, so it reads as
    // evenly inset (snug but balanced) rather than cramped against one side.
    padding: Skin.space(4),
    // A small breathing gap between the pill and whatever sits below it
    // (the keyboard or the emoji panel), so the pill never touches them.
    marginBottom: Skin.space(8),
  },
  pillMultiline: {
    // Grown box: only the corner radius changes (down from the stadium) so the
    // short ends don't bulge on a tall pill. Controls stay bottom-pinned via
    // the button containers — no alignItems flip here.
    borderRadius: Skin.radius(20),
  },
  // Button containers fill the pill height (stretch) and bottom-pin their
  // button. Single line: container is one row tall, so "bottom" reads centered.
  // Multi-line: button sits on the last line. Same rule both states -> no jump.
  leftButtons: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  rightButtons: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Skin.space(2),
  },
  input: {
    flex: 1,
    color: theme.colors.textMain,
    paddingHorizontal: Skin.space(8),
    // Size to content height and center within the pill. The pill uses
    // `alignItems: stretch`, which would stretch the input to the button
    // height and — because iOS IGNORES textAlignVertical on multiline inputs
    // — leave a single line stuck at the top. `alignSelf: center` overrides
    // the stretch for the input only (buttons stay bottom-pinned), so one
    // line is vertically centered on iOS too; multiline grows the pill and
    // still reads centered.
    alignSelf: 'center',
    // No vertical padding and no minHeight: the input's height is its own
    // line-height (single line) and grows naturally up to maxHeight when
    // wrapped.
    paddingVertical: 0,
    fontFamily: theme.fonts.regular.fontFamily,
    fontSize: Skin.font(16),
    lineHeight: Skin.font(22),
    maxHeight: 120,
    // Android adds extra font padding above/below the glyphs that throws off
    // vertical centering in a flex row; disabling it makes the text box equal
    // its lineHeight so it centers cleanly. (No-op / ignored on iOS.)
    includeFontPadding: false,
  },
  inputIconButton: {
    padding: Skin.space(6),
  },
  signingHintRow: {
    alignItems: 'center',
    paddingBottom: Skin.space(6),
  },
  signingHintPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(6),
    paddingVertical: Skin.space(5),
    paddingHorizontal: Skin.space(10),
    borderRadius: Skin.radius(14),
    backgroundColor: theme.colors.composerPillBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.composerPillBorder,
  },
  signingHintText: {
    fontSize: Skin.font(12),
    color: theme.colors.textSubtle,
    fontFamily: theme.fonts.medium?.fontFamily || theme.fonts.regular.fontFamily,
  },
  // Clips the paperclip as its width animates to 0 while composing, so the
  // icon slides out cleanly instead of overflowing the collapsing container.
  attachContainer: {
    overflow: 'hidden',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  sendButtonTouch: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Wraps the kept-mounted panel; its opacity (UI-thread) hides it while closed.
  panelOpacityWrap: {
    flex: 1,
  },
  emojiPanelInner: {
    flex: 1,
    // Same semantic token as the composer pill so the pill and the panel read
    // as one continuous surface in BOTH schemes (near-white on light, raised
    // surface on dark). The sub-bands below stay one step off this base.
    backgroundColor: theme.colors.composerPillBg,
    // Rim so the panel has a defined edge — on light it's near-white and would
    // otherwise blend into the page. Same token as the pill's rim (grey hairline
    // on light, faint white on dark). Top + sides; the bottom runs off-screen.
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.composerPillBorder,
    borderTopLeftRadius: Skin.radius(16),
    borderTopRightRadius: Skin.radius(16),
    // Clip the search bar / category band to the rounded top corners.
    overflow: 'hidden',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Skin.space(14),
    // More breathing room: clears the panel's rounded top and gives the field
    // air before the category band. No bottom border — the band below provides
    // separation by color instead of a hard line.
    paddingTop: Skin.space(14),
    paddingBottom: Skin.space(12),
    gap: Skin.space(8),
  },
  searchInput: {
    flex: 1,
    fontSize: Skin.font(15),
    lineHeight: Skin.font(20),
    color: theme.colors.textMain,
    fontFamily: theme.fonts.regular.fontFamily,
    padding: 0,
  },
  panelCloseButton: {
    // Slight left pad so it reads as a distinct affordance at the far right,
    // separated from the in-field clear button.
    paddingLeft: Skin.space(4),
  },
  categoryTabs: {
    // A continuous band (no top/bottom separators), a subtle step off the panel
    // (semantic token so it tracks the panel surface in both schemes).
    // Tall enough that the 20px emoji + pill padding aren't clipped.
    maxHeight: 48,
    backgroundColor: theme.colors.composerPanelBand,
  },
  categoryTabsContent: {
    paddingHorizontal: Skin.space(6),
    // Vertical padding inside the band so the active pill floats and never
    // touches the band's edges.
    paddingVertical: Skin.space(6),
    alignItems: 'center',
  },
  categoryTab: {
    paddingHorizontal: Skin.space(9),
    paddingVertical: Skin.space(5),
    marginHorizontal: Skin.space(2),
    borderRadius: Skin.radius(10),
  },
  categoryTabActive: {
    // Floating pill one step above the band so it reads as raised, inset by the
    // content padding so it never touches the band edges. Semantic token,
    // derived from the panel surface so it tracks it in both schemes.
    backgroundColor: theme.colors.composerPanelBandActive,
  },
  categoryTabEmoji: {
    fontSize: Skin.font(20),
    // Explicit line-height so the glyph box is tall enough on Android (where
    // emoji overshoot the default line box and clip).
    lineHeight: Skin.font(26),
  },
  emojiGrid: {
    flex: 1,
  },
  emojiGridContent: {
    padding: Skin.space(8),
  },
  emojiSection: {
    marginBottom: Skin.space(12),
  },
  emojiSectionTitle: {
    fontSize: Skin.font(12),
    fontFamily: theme.fonts.medium.fontFamily,
    color: theme.colors.textSubtle,
    marginBottom: Skin.space(6),
  },
  emojiRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  emojiButton: {
    padding: Skin.space(8),
    justifyContent: 'center',
    alignItems: 'center',
  },
  emoji: {
    fontSize: Skin.font(24),
  },
  customEmojiImage: {
    width: 28,
    height: 28,
    borderRadius: Skin.radius(4),
  },
  stickerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  stickerButton: {
    width: '25%', // 4 columns for stickers (larger)
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Skin.space(4),
  },
  stickerImage: {
    width: '100%',
    height: '100%',
    borderRadius: Skin.radius(8),
  },
  emptyText: {
    textAlign: 'center',
    color: theme.colors.textSubtle,
    marginTop: Skin.space(16),
    fontSize: Skin.font(14),
  },
  autocompleteContainer: {
    // Match the composer pill's surface so the menu reads as one surface with it.
    backgroundColor: theme.colors.surface4,
    borderRadius: Skin.radius(12),
    marginBottom: Skin.space(8),
    maxHeight: 200,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
  },
  autocompleteList: {
    maxHeight: 200,
  },
  autocompleteItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Skin.space(12),
    paddingVertical: Skin.space(10),
    gap: Skin.space(10),
  },
  autocompleteAvatar: {
    width: 28,
    height: 28,
    borderRadius: Skin.radius(14),
    backgroundColor: theme.colors.primary + '30',
    justifyContent: 'center',
    alignItems: 'center',
  },
  autocompleteAvatarText: {
    color: theme.colors.primary,
    fontSize: Skin.font(12),
    fontFamily: theme.fonts.medium.fontFamily,
    fontWeight: theme.fonts.medium.fontWeight,
  },
  autocompleteText: {
    color: theme.colors.textMain,
    fontSize: Skin.font(14),
    fontFamily: theme.fonts.regular.fontFamily,
    flex: 1,
  },
  autocompleteHint: {
    // textSubtle, not textMuted — the muted token is too low-contrast on the
    // surface4 menu background to read comfortably.
    color: theme.colors.textSubtle,
    fontSize: Skin.font(12),
    fontFamily: theme.fonts.regular.fontFamily,
  },
});

export default MessageInput;
