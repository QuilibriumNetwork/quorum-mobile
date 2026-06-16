import type { AppTheme } from '@/theme';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { SendIcon } from '@/components/Chat/SendIcon';
import { useEmojiFrecency } from '@/hooks/useEmojiFrecency';
import { useDebouncedValue } from '@/hooks/useFarcasterSearch';
import type { ProcessedAttachment } from '@/services/media/imageAttachment';
import type { Channel, Emoji, SpaceMember, Sticker } from '@quilibrium/quorum-shared';
import { searchEmojis } from '@/data/emojiData';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, useWindowDimensions, NativeSyntheticEvent, Platform, ScrollView, StyleSheet, Text, TextInput, TextInputSubmitEditingEventData, View } from 'react-native';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useComposerPanel } from '@/hooks/useComposerPanel';
import * as Skin from '@/theme/skins/geometry';


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
   * Height of bottom chrome (e.g. a tab bar) the composer already sits above.
   * The keyboard/panel footprint is reduced by this so the pill lands exactly
   * on top of the keyboard instead of overshooting it.
   */
  bottomChromeHeight?: number;
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
  bottomChromeHeight = 0,
  customEmojis = [],
  stickers = [],
  onSendSticker,
  members = [],
  channels = [],
  editingMessage,
  onCancelEdit,
  isDM = false,
  castReplyAvailable = false,
  alsoReplyOnFarcaster = false,
  onToggleAlsoReplyOnFarcaster,
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
    bottomInset: Skin.space(8) + bottomInset,
    bottomChromeHeight,
  });
  const showEmojiPicker = composerPanel.panelOpen;
  const [selectedCategory, setSelectedCategory] = useState<CategoryKey>('smileys');
  const [searchQuery, setSearchQuery] = useState('');

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

  // Filter members for mention autocomplete - search by display name, name, or address
  const filteredMembers = useMemo(() => {
    if (autocompleteType !== 'mention') return [];
    return members.filter((m) => {
      const displayName = (m.display_name || '').toLowerCase();
      const name = (m.name || '').toLowerCase();
      const address = (m.address || '').toLowerCase();
      return displayName.includes(debouncedAutocompleteQuery) ||
             name.includes(debouncedAutocompleteQuery) ||
             address.includes(debouncedAutocompleteQuery);
    }).slice(0, 6);
  }, [autocompleteType, debouncedAutocompleteQuery, members]);

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

    // Use address for the mention (MentionableText will render it as display name)
    const newText = value.slice(0, lastAtIndex) + `@${member.address} ` + textAfterCursor;
    onChangeText(newText);
    setAutocompleteType(null);
    setAutocompleteQuery('');
  }, [value, cursorPosition, onChangeText]);

  // Insert selected channel
  const handleSelectChannel = useCallback((channel: Channel) => {
    const textUpToCursor = value.slice(0, cursorPosition);
    const lastHashIndex = textUpToCursor.lastIndexOf('#');
    const textAfterCursor = value.slice(cursorPosition);

    const newText = value.slice(0, lastHashIndex) + `#${channel.channelName} ` + textAfterCursor;
    onChangeText(newText);
    setAutocompleteType(null);
    setAutocompleteQuery('');
  }, [value, cursorPosition, onChangeText]);

  // Track cursor position
  const handleSelectionChange = useCallback((event: { nativeEvent: { selection: { start: number; end: number } } }) => {
    setCursorPosition(event.nativeEvent.selection.end);
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

  // The emoji grid markup, rendered inside the downward panel below the pill.
  // Memoized and gated on `showEmojiPicker` so the (potentially hundreds of
  // nodes) grid isn't rebuilt on every keystroke while the panel is closed.
  const emojiPanelContent = useMemo(() => {
    if (!showEmojiPicker) return null;
    return (
    <View style={styles.emojiPanelInner}>
      {/* Search bar */}
      <View style={styles.searchContainer}>
        <IconSymbol name="magnifyingglass" size={16} color={theme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search emoji..."
          placeholderTextColor={theme.colors.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={8}>
            <IconSymbol name="xmark.circle.fill" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
        )}
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

      {/* Emoji/Sticker grid */}
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
                    <TouchableOpacity
                      key={`${emoji}-${index}`}
                      style={styles.emojiButton}
                      onPress={() => handleSelectEmoji(emoji)}
                    >
                      <Text style={styles.emoji}>{emoji}</Text>
                    </TouchableOpacity>
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
              <TouchableOpacity
                key={`${emoji}-${index}`}
                style={styles.emojiButton}
                onPress={() => handleSelectEmoji(emoji)}
              >
                <Text style={styles.emoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
            {selectedCategory === 'recent' && displayEmojis.length === 0 && (
              <Text style={styles.emptyText}>No recent emojis</Text>
            )}
          </View>
        )}
      </ScrollView>
    </View>
    );
  }, [
    showEmojiPicker,
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
    styles,
    theme,
  ]);

  return (
    <View style={[styles.container, containerDynamicStyle]}>
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
      {autocompleteType && (filteredMembers.length > 0 || filteredChannels.length > 0) && (
        <View style={styles.autocompleteContainer}>
          <ScrollView
            style={styles.autocompleteList}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            {autocompleteType === 'mention' && filteredMembers.map((member) => (
              <TouchableOpacity
                key={member.address}
                style={styles.autocompleteItem}
                onPress={() => handleSelectMention(member)}
              >
                <View style={styles.autocompleteAvatar}>
                  <Text style={styles.autocompleteAvatarText}>
                    {(member.display_name || member.name || '?')[0].toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.autocompleteText}>
                  {member.display_name || member.name || member.address}
                </Text>
              </TouchableOpacity>
            ))}
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
          right. */}
      <View style={styles.pill}>
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
            />
          </TouchableOpacity>
        </View>

        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={handleTextChange}
          onSelectionChange={handleSelectionChange}
          placeholder={editingMessage ? 'Edit message...' : 'Message...'}
          placeholderTextColor={theme.colors.textMuted}
          style={styles.input}
          editable={!disabled}
          returnKeyType="send"
          onSubmitEditing={handleSubmitEditing}
          blurOnSubmit={false}
          multiline
          scrollEnabled
          textAlignVertical="center"
          onFocus={() => {
            composerPanel.onInputFocus();
            setSearchQuery('');
          }}
        />

        <View style={styles.rightButtons}>
          {/* Attach hides while composing to give the text room. */}
          {!isComposing && (
            <TouchableOpacity
              style={styles.inputIconButton}
              onPress={onAttachmentPress}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel="Attach image"
            >
              <IconSymbol
                name="paperclip"
                color={disabled ? theme.colors.textMuted : theme.colors.textSubtle}
                size={27}
              />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              styles.sendButton,
              {
                backgroundColor: canSend ? theme.colors.accent : theme.colors.surface6,
                opacity: canSend ? 1 : 0.6,
              },
            ]}
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
        </View>
      </View>

      {/* Animated spacer beneath the pill. Closed: it follows the keyboard so
          the pill rides up (keyboard avoidance). Open: it holds the keyboard
          footprint and shows the emoji panel — no layout jump on swap. */}
      <Reanimated.View style={spacerAnimatedStyle}>
        {emojiPanelContent}
      </Reanimated.View>
    </View>
  );
});

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: {
    // Match the messages page so the composer bar blends with the chat
    // background; the pill sits on top as the distinct surface.
    backgroundColor: theme.colors.surface1,
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
    // Self-sizing: the row height is defined by its tallest child (the 36px
    // controls), and `center` keeps the text and controls on one baseline on
    // every device instead of relying on per-device text metrics. No fixed
    // pill height — it adapts to the font/line-height the device renders.
    alignItems: 'center',
    // Same shade as the emoji panel so the pill and the panel read as one
    // continuous surface.
    backgroundColor: theme.colors.surface4,
    // Large radius => the short ends are always perfect semicircles regardless
    // of the pill's resolved height (single line vs wrapped).
    borderRadius: 999,
    // Uniform inner padding on all four sides: the send circle then has the
    // same gap to the right edge as it does to the top/bottom, so it reads as
    // evenly inset (snug but balanced) rather than cramped against one side.
    padding: Skin.space(4),
    // A small breathing gap between the pill and whatever sits below it
    // (the keyboard or the emoji panel), so the pill never touches them.
    marginBottom: Skin.space(8),
  },
  leftButtons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rightButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(2),
  },
  input: {
    flex: 1,
    color: theme.colors.textMain,
    paddingHorizontal: Skin.space(8),
    // No vertical padding and no minHeight: the input's height is its own
    // line-height (single line) and grows naturally up to maxHeight when
    // wrapped. The parent's `alignItems: center` + the 36px controls keep a
    // single line vertically centered without device-specific magic numbers.
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
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiPanelInner: {
    flex: 1,
    backgroundColor: theme.colors.surface4,
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
  categoryTabs: {
    // A continuous band (no top/bottom separators), one shade off the panel.
    // Tall enough that the 20px emoji + pill padding aren't clipped.
    maxHeight: 48,
    backgroundColor: theme.colors.surface3,
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
    // content padding so it never touches the band edges.
    backgroundColor: theme.colors.surface6,
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
    color: theme.colors.textMuted,
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
    color: theme.colors.textMuted,
    marginTop: Skin.space(16),
    fontSize: Skin.font(14),
  },
  autocompleteContainer: {
    backgroundColor: theme.colors.surface5,
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
});

export default MessageInput;
