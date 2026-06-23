/**
 * MessageRenderer — single entry point for rendering message body text.
 *
 * Routes by content:
 *  - No markdown syntax → `MentionableText` (the original, cheaper tokenizer).
 *    This keeps the common case (a plain chat line, an emoji-only message, a
 *    bare @mention) on the exact same code path as before — no regression and
 *    no markdown cost.
 *  - Contains markdown syntax → `MessageMarkdownRenderer`, after running the
 *    preprocessing pipeline (mention tokenization, URL auto-linking, header
 *    normalization, code-fence balancing).
 *
 * Every existing `<MentionableText>` call site in the message list should use
 * this component instead, passing the same props plus `roles`.
 */

import type { AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import type { TextStyle } from 'react-native';
import type { Emoji, SpaceMember, Channel, Role } from '@quilibrium/quorum-shared';
import { MentionableText } from './MentionableText';
import { MessageMarkdownRenderer } from './MessageMarkdownRenderer.native';
import { hasMarkdown, prepareMessageContent } from '@/utils/messagePreprocessing';

interface MessageRendererProps {
  text: string;
  customEmojis: Emoji[];
  members?: SpaceMember[];
  channels?: Channel[];
  /** Space roles, for resolving @role mention pills. */
  roles?: Role[];
  currentUserId?: string;
  style?: TextStyle;
  theme?: AppTheme;
  onMentionPress?: (userId: string) => void;
  onChannelPress?: (channelId: string) => void;
  onLinkPress?: (url: string) => void;
  /** Show an on-device "See translation" toggle (MentionableText path only). */
  enableTranslate?: boolean;
}

function MessageRendererBase({
  text,
  customEmojis,
  members = [],
  channels = [],
  roles = [],
  currentUserId,
  style,
  theme,
  onMentionPress,
  onChannelPress,
  onLinkPress,
  enableTranslate = false,
}: MessageRendererProps) {
  const isMarkdown = useMemo(() => hasMarkdown(text), [text]);

  // Preprocess only when we're taking the markdown path (and only when the
  // inputs change). Mentions are tokenized here so the markdown renderer can't
  // mangle an `@<address>` into emphasis/code.
  const prepared = useMemo(() => {
    if (!isMarkdown) return '';
    return prepareMessageContent(text, { members, roles, channels });
  }, [isMarkdown, text, members, roles, channels]);

  if (!isMarkdown) {
    return (
      <MentionableText
        text={text}
        enableTranslate={enableTranslate}
        customEmojis={customEmojis}
        members={members}
        roles={roles}
        channels={channels}
        currentUserId={currentUserId}
        style={style}
        theme={theme}
        onMentionPress={onMentionPress}
        onChannelPress={onChannelPress}
        onLinkPress={onLinkPress}
      />
    );
  }

  // Markdown renderer needs a theme; MessagesList always passes one. If a
  // future caller omits it, fall back to the plain tokenizer rather than crash.
  if (!theme) {
    return (
      <MentionableText
        text={text}
        enableTranslate={enableTranslate}
        customEmojis={customEmojis}
        members={members}
        roles={roles}
        channels={channels}
        currentUserId={currentUserId}
        style={style}
        onMentionPress={onMentionPress}
        onChannelPress={onChannelPress}
        onLinkPress={onLinkPress}
      />
    );
  }

  return (
    <MessageMarkdownRenderer
      content={prepared}
      customEmojis={customEmojis}
      members={members}
      theme={theme}
      style={style}
      onMentionPress={onMentionPress}
      onChannelPress={onChannelPress}
      onLinkPress={onLinkPress}
    />
  );
}

export const MessageRenderer = React.memo(MessageRendererBase);

export default MessageRenderer;
