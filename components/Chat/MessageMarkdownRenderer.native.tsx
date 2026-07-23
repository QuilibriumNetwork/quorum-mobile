/**
 * MessageMarkdownRenderer (native) — renders message text that contains
 * markdown syntax into React Native elements.
 *
 * Hand-rolled (no third-party markdown library): a small block parser splits
 * the preprocessed text into headings, blockquotes, lists, fenced code blocks,
 * thematic breaks and paragraphs, then an inline parser turns the leaf text of
 * each block into styled `<Text>` runs (bold, italic, strikethrough, inline
 * code, spoilers, links) and the mention/channel/everyone/role pills plus
 * custom + standard emoji.
 *
 * The input MUST already be run through `prepareMessageContent` (from
 * `@quilibrium/quorum-shared`) so mentions are tokenized as `<<<...>>>`,
 * URLs are auto-linked, headers are normalized to `###`, and code fences are
 * balanced. `MessageRenderer` does that before handing off here.
 *
 * Plain (no-markdown) messages never reach this component — they stay on the
 * cheaper `MentionableText` path. See `MessageRenderer`.
 */

import type { AppTheme } from '@/theme';
import React, { useMemo, useState, useCallback } from 'react';
import { Text, View, Image, ScrollView, StyleSheet, TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { Emoji, SpaceMember, Channel } from '@quilibrium/quorum-shared';
import {
  extractCodeContent,
  shouldUseScrollContainer,
} from '@quilibrium/quorum-shared';
import { getEmojiByName } from '@/data/emojiNames';
import { truncateAddress } from '@/utils/formatAddress';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { haptics } from '@/utils/haptics';
import * as Skin from '@/theme/skins/geometry';

export interface MessageMarkdownRendererProps {
  /** Preprocessed content (mentions already tokenized via prepareMessageContent). */
  content: string;
  customEmojis: Emoji[];
  members?: SpaceMember[];
  theme: AppTheme;
  style?: TextStyle;
  onMentionPress?: (userId: string) => void;
  onChannelPress?: (channelId: string) => void;
  onLinkPress?: (url: string) => void;
  /**
   * Inline trailing node (e.g. a DM receipt). Appended after the last inline run
   * when the final block is text (paragraph/heading/list) so it flows on the
   * same line and wraps with it; otherwise (code/quote/hr) it drops to a compact
   * trailing row beneath the content.
   */
  receipt?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'blockquote'; text: string }
  | { type: 'code'; content: string; lang?: string }
  | { type: 'list'; items: { text: string; ordered: boolean; marker: string }[] }
  | { type: 'hr' };

const FENCE_RE = /^```/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const UL_RE = /^[-*+]\s+(.*)$/;
const OL_RE = /^(\d+)\.\s+(.*)$/;
const HR_RE = /^(?:---+|\*\*\*+|___+)\s*$/;

function parseBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (FENCE_RE.test(line)) {
      const lang = line.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (may be absent — fixUnclosedCodeBlocks adds it)
      blocks.push({ type: 'code', content: codeLines.join('\n'), lang });
      continue;
    }

    // Blank line — paragraph separator.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Heading.
    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ type: 'heading', text: heading[1] });
      i++;
      continue;
    }

    // Thematic break.
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote — collect consecutive `>` lines.
    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i])) {
        quoteLines.push(lines[i].match(BLOCKQUOTE_RE)![1]);
        i++;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    // List — collect consecutive list items (ordered or unordered).
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const items: { text: string; ordered: boolean; marker: string }[] = [];
      while (i < lines.length && (UL_RE.test(lines[i]) || OL_RE.test(lines[i]))) {
        const ol = lines[i].match(OL_RE);
        if (ol) {
          items.push({ text: ol[2], ordered: true, marker: `${ol[1]}.` });
        } else {
          const ul = lines[i].match(UL_RE)!;
          items.push({ text: ul[1], ordered: false, marker: '•' });
        }
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // Paragraph — collect consecutive plain lines (soft line breaks preserved).
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !BLOCKQUOTE_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Inline parsing — emphasis, code, spoilers, mention tokens, emoji, links
// ---------------------------------------------------------------------------

type InlineNode =
  | { type: 'text'; content: string; bold?: boolean; italic?: boolean; strike?: boolean }
  | { type: 'code'; content: string }
  | { type: 'spoiler'; content: string }
  | { type: 'mention_user'; address: string }
  | { type: 'mention_everyone' }
  | { type: 'mention_role'; roleTag: string; displayName: string }
  | { type: 'mention_channel'; channelId: string; channelName: string }
  | { type: 'custom_emoji'; emoji: Emoji }
  | { type: 'standard_emoji'; char: string }
  | { type: 'link'; url: string; label: string };

// One regex pass over the leaf text. Order in the alternation defines priority.
// Tokens (`<<<...>>>`) and spoilers (`||...||`) are matched first so emphasis
// markers inside them aren't double-parsed.
const INLINE_RE = new RegExp(
  [
    '<<<MENTION_EVERYONE>>>', // 0
    '<<<MENTION_USER:([^>]+)>>>', // 1: address
    '<<<MENTION_ROLE:([^:]+):([^>]*)>>>', // 2,3: roleTag, displayName
    '<<<MENTION_CHANNEL:([^:]+):([^>]*)>>>', // 4,5: channelId, channelName
    '\\|\\|([^|]+)\\|\\|', // 6: spoiler
    '`([^`]+)`', // 7: inline code
    '\\[([^\\]]+)\\]\\(([^)]+)\\)', // 8,9: link label, url
    ':([a-zA-Z0-9_-]+):', // 10: emoji shortcode
  ].join('|'),
  'g'
);

function parseInline(
  text: string,
  emojiMap: Record<string, Emoji>
): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;

  const pushText = (s: string) => {
    if (s) parseEmphasis(s, nodes);
  };

  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) pushText(text.slice(last, m.index));

    if (m[0] === '<<<MENTION_EVERYONE>>>') {
      nodes.push({ type: 'mention_everyone' });
    } else if (m[1] !== undefined) {
      nodes.push({ type: 'mention_user', address: m[1] });
    } else if (m[2] !== undefined) {
      nodes.push({ type: 'mention_role', roleTag: m[2], displayName: m[3] ?? m[2] });
    } else if (m[4] !== undefined) {
      nodes.push({ type: 'mention_channel', channelId: m[4], channelName: m[5] ?? '' });
    } else if (m[6] !== undefined) {
      nodes.push({ type: 'spoiler', content: m[6] });
    } else if (m[7] !== undefined) {
      nodes.push({ type: 'code', content: m[7] });
    } else if (m[8] !== undefined) {
      nodes.push({ type: 'link', label: m[8], url: m[9] });
    } else if (m[10] !== undefined) {
      // Emoji shortcode — custom first, then standard.
      const name = m[10].toLowerCase();
      const custom = emojiMap[name];
      if (custom) {
        nodes.push({ type: 'custom_emoji', emoji: custom });
      } else {
        const std = getEmojiByName(name);
        if (std) {
          nodes.push({ type: 'standard_emoji', char: std });
        } else {
          pushText(m[0]); // unknown shortcode — leave as literal text
        }
      }
    }

    last = m.index + m[0].length;
  }

  if (last < text.length) pushText(text.slice(last));
  return nodes;
}

// Emphasis pass over a plain (token-free) string: **bold**, __bold__, *italic*,
// _italic_, ~~strike~~. Nesting is handled by recursion.
function parseEmphasis(
  text: string,
  out: InlineNode[],
  ctx: { bold?: boolean; italic?: boolean; strike?: boolean } = {}
): void {
  const EMPHASIS_RE = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3|(~~)(?=\S)([\s\S]*?\S)\5/;
  const m = text.match(EMPHASIS_RE);
  if (!m || m.index === undefined) {
    if (text) out.push({ type: 'text', content: text, ...ctx });
    return;
  }

  if (m.index > 0) {
    out.push({ type: 'text', content: text.slice(0, m.index), ...ctx });
  }

  if (m[1]) {
    parseEmphasis(m[2], out, { ...ctx, bold: true });
  } else if (m[3]) {
    parseEmphasis(m[4], out, { ...ctx, italic: true });
  } else if (m[5]) {
    parseEmphasis(m[6], out, { ...ctx, strike: true });
  }

  const rest = text.slice(m.index + m[0].length);
  if (rest) parseEmphasis(rest, out, ctx);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function MessageMarkdownRendererBase({
  content,
  customEmojis,
  members = [],
  theme,
  style,
  onMentionPress,
  onChannelPress,
  onLinkPress,
  receipt,
}: MessageMarkdownRendererProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const emojiMap = useMemo(() => {
    const map: Record<string, Emoji> = {};
    customEmojis.forEach((e) => {
      map[e.name.toLowerCase()] = e;
    });
    return map;
  }, [customEmojis]);

  const memberByAddress = useMemo(() => {
    const map: Record<string, SpaceMember> = {};
    members.forEach((m) => {
      if (m.address) map[m.address] = m;
    });
    return map;
  }, [members]);

  const blocks = useMemo(() => parseBlocks(content), [content]);

  const baseTextStyle: TextStyle = { ...styles.text, ...style };

  // Inline mention/channel styling. Color-only (no highlighted background):
  // the bg pill reads heavy on mobile, so we use a colored, medium-weight run
  // instead — same approach desktop takes for inline density.
  const mentionStyle: TextStyle = {
    color: theme.colors.primary,
    fontWeight: '600',
  };
  const channelStyle: TextStyle = {
    color: theme.colors.primary,
    fontWeight: '600',
  };
  const linkStyle: TextStyle = {
    color: theme.colors.primary,
    textDecorationLine: 'underline',
  };

  const renderInline = useCallback(
    (text: string, keyPrefix: string): React.ReactNode[] => {
      const nodes = parseInline(text, emojiMap);
      return nodes.map((node, idx) => {
        const key = `${keyPrefix}-${idx}`;
        switch (node.type) {
          case 'text': {
            const ts: TextStyle = {};
            if (node.bold) ts.fontWeight = 'bold';
            if (node.italic) ts.fontStyle = 'italic';
            if (node.strike) ts.textDecorationLine = 'line-through';
            return (
              <Text key={key} style={ts}>
                {node.content}
              </Text>
            );
          }
          case 'code':
            return (
              <Text key={key} style={styles.inlineCode}>
                {node.content}
              </Text>
            );
          case 'spoiler':
            return <Spoiler key={key} content={node.content} styles={styles} />;
          case 'mention_user': {
            const member = memberByAddress[node.address];
            const display = member?.display_name || member?.name || truncateAddress(node.address);
            if (onMentionPress) {
              return (
                <Text
                  key={key}
                  style={mentionStyle}
                  onPress={() => onMentionPress(node.address)}
                >
                  @{display}
                </Text>
              );
            }
            return (
              <Text key={key} style={mentionStyle}>
                @{display}
              </Text>
            );
          }
          case 'mention_everyone':
            return (
              <Text key={key} style={mentionStyle}>
                @everyone
              </Text>
            );
          case 'mention_role':
            // Same accent color as every other mention type — desktop renders
            // all mention pills (user/role/everyone/channel) in one link color,
            // not the role's own color.
            return (
              <Text key={key} style={mentionStyle}>
                @{node.displayName}
              </Text>
            );
          case 'mention_channel':
            if (onChannelPress) {
              return (
                <Text
                  key={key}
                  style={channelStyle}
                  onPress={() => onChannelPress(node.channelId)}
                >
                  #{node.channelName}
                </Text>
              );
            }
            return (
              <Text key={key} style={channelStyle}>
                #{node.channelName}
              </Text>
            );
          case 'custom_emoji':
            return (
              <Image
                key={key}
                source={{ uri: node.emoji.imgUrl }}
                style={styles.customEmoji}
                resizeMode="contain"
              />
            );
          case 'standard_emoji':
            return <Text key={key}>{node.char}</Text>;
          case 'link': {
            // Truncate bare auto-links (label === url) to 50 chars, matching
            // desktop, so a long pasted URL doesn't dominate the bubble.
            const isAutoLink = node.label === node.url;
            const label =
              isAutoLink && node.label.length > 50
                ? node.label.slice(0, 50) + '…'
                : node.label;
            return (
              <Text
                key={key}
                style={linkStyle}
                onPress={onLinkPress ? () => onLinkPress(node.url) : undefined}
              >
                {label}
              </Text>
            );
          }
          default:
            return null;
        }
      });
    },
    [emojiMap, memberByAddress, onMentionPress, onChannelPress, onLinkPress, styles, theme, mentionStyle, channelStyle, linkStyle]
  );

  // Inline the receipt after the last block's text so it trails the last word
  // and wraps with it — but only when that block IS text (paragraph/heading/
  // list). If the message ends in a code block / quote / hr there's no trailing
  // inline run, so the receipt drops to a compact row beneath (below).
  const lastIdx = blocks.length - 1;
  const lastType = lastIdx >= 0 ? blocks[lastIdx].type : undefined;
  const receiptInlineable =
    lastType === 'paragraph' || lastType === 'heading' || lastType === 'list';

  return (
    <View style={styles.container}>
      {blocks.map((block, bi) => {
        const key = `block-${bi}`;
        const isLast = bi === lastIdx;
        switch (block.type) {
          case 'heading':
            return (
              <Text key={key} style={[baseTextStyle, styles.heading]}>
                {renderInline(block.text, key)}
                {isLast ? receipt : null}
              </Text>
            );
          case 'paragraph':
            return (
              <Text key={key} style={baseTextStyle}>
                {renderInline(block.text, key)}
                {isLast ? receipt : null}
              </Text>
            );
          case 'blockquote':
            return (
              <View key={key} style={styles.blockquote}>
                <Text style={baseTextStyle}>{renderInline(block.text, key)}</Text>
              </View>
            );
          case 'list':
            return (
              <View key={key} style={styles.list}>
                {block.items.map((item, ii) => (
                  <View key={`${key}-${ii}`} style={styles.listItem}>
                    <Text style={[baseTextStyle, styles.listMarker]}>{item.marker}</Text>
                    <Text style={[baseTextStyle, styles.listText]}>
                      {renderInline(item.text, `${key}-${ii}`)}
                      {isLast && ii === block.items.length - 1 ? receipt : null}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case 'code':
            return (
              <CodeBlock
                key={key}
                content={block.content}
                styles={styles}
                theme={theme}
              />
            );
          case 'hr':
            return <View key={key} style={styles.hr} />;
          default:
            return null;
        }
      })}
      {receipt && !receiptInlineable ? (
        <View style={styles.receiptRow}>{receipt}</View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type MdStyles = ReturnType<typeof createStyles>;

const Spoiler = React.memo(function Spoiler({
  content,
  styles,
}: {
  content: string;
  styles: MdStyles;
}) {
  const [revealed, setRevealed] = useState(false);
  // When hidden, replace the text with block glyphs over a solid background
  // rather than relying on `color: 'transparent'` (unreliable on nested RN
  // <Text> — the parent color can win). This guarantees the content is
  // unreadable until tapped.
  if (!revealed) {
    return (
      <Text style={styles.spoilerHidden} onPress={() => setRevealed(true)} suppressHighlighting>
        {'█'.repeat(content.length)}
      </Text>
    );
  }
  return (
    <Text style={styles.spoilerRevealed} onPress={() => setRevealed(false)} suppressHighlighting>
      {content}
    </Text>
  );
});

const CodeBlock = React.memo(function CodeBlock({
  content,
  styles,
  theme,
}: {
  content: string;
  styles: MdStyles;
  theme: AppTheme;
}) {
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => extractCodeContent(content), [content]);
  const scrollable = useMemo(() => shouldUseScrollContainer(code), [code]);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(code);
    haptics.selection();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);

  const codeText = <Text style={styles.codeText}>{code}</Text>;

  return (
    <View style={styles.codeBlock}>
      {scrollable ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {codeText}
        </ScrollView>
      ) : (
        codeText
      )}
      <Text style={styles.copyButton} onPress={handleCopy} suppressHighlighting>
        <IconSymbol
          name={copied ? 'checkmark' : 'doc.on.doc'}
          size={14}
          color={theme.colors.textMuted}
        />
      </Text>
    </View>
  );
});

// ---------------------------------------------------------------------------
// Helpers + styles
// ---------------------------------------------------------------------------

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      marginTop: Skin.space(4),
    },
    text: {
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    heading: {
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: 'bold',
      fontSize: Skin.font(17),
      marginTop: Skin.space(4),
      marginBottom: Skin.space(2),
    },
    inlineCode: {
      fontFamily: 'monospace',
      backgroundColor: theme.colors.surface4 ?? theme.colors.surface3,
      color: theme.colors.textMain,
      borderRadius: Skin.radius(3),
      paddingHorizontal: Skin.space(4),
      fontSize: Skin.font(13),
    },
    codeBlock: {
      backgroundColor: theme.colors.surface4 ?? theme.colors.surface3,
      borderRadius: Skin.radius(8),
      padding: Skin.space(10),
      marginVertical: Skin.space(4),
    },
    codeText: {
      fontFamily: 'monospace',
      color: theme.colors.textMain,
      fontSize: Skin.font(13),
    },
    copyButton: {
      position: 'absolute',
      top: Skin.space(6),
      right: Skin.space(6),
      padding: Skin.space(4),
    },
    blockquote: {
      borderLeftWidth: Skin.border(3),
      borderLeftColor: theme.colors.primary,
      paddingLeft: Skin.space(10),
      marginVertical: Skin.space(2),
    },
    list: {
      marginVertical: Skin.space(2),
    },
    listItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    listMarker: {
      marginRight: Skin.space(6),
    },
    listText: {
      flex: 1,
    },
    hr: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.border ?? theme.colors.textMuted,
      marginVertical: Skin.space(8),
    },
    spoilerHidden: {
      backgroundColor: theme.colors.textMuted,
      color: theme.colors.textMuted,
      borderRadius: Skin.radius(3),
    },
    spoilerRevealed: {
      // Once revealed, render as normal text (no background) — matches desktop,
      // which sets the revealed spoiler's background to transparent.
      color: theme.colors.textMain,
    },
    customEmoji: {
      width: 20,
      height: 20,
    },
    // Fallback row for the receipt when the last block isn't inline text
    // (code/quote/hr) — a compact row beneath the content, left-aligned with it.
    receiptRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(2),
    },
  });

export const MessageMarkdownRenderer = React.memo(MessageMarkdownRendererBase);

export default MessageMarkdownRenderer;
