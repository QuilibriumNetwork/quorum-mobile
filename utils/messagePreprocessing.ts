/**
 * Message content preprocessing — pure string transforms shared by the
 * markdown renderer.
 *
 * Ported from desktop's `MessageMarkdownRenderer.tsx` preprocessing pipeline.
 * Every function here is platform-agnostic (string in, string out); only the
 * final React rendering step is platform-specific (see
 * `components/Chat/MessageMarkdownRenderer.native.tsx`).
 *
 * The pipeline converts inline mentions/channels into internal tokens of the
 * form `<<<MENTION_USER:address>>>` BEFORE the markdown layer runs, so the
 * markdown parser never mangles an `@<address>` into emphasis/code/etc. The
 * tokens use `<<<...>>>` delimiters that don't collide with any markdown
 * syntax, matching desktop exactly so both platforms share one wire vocabulary.
 *
 * Mobile difference vs desktop: desktop relies on pre-extracted `message.mentions`
 * arrays to know which roleTags/channelIds to convert. Mobile resolves mentions
 * directly from the `members` / `roles` / `channels` props passed to the
 * renderer — consistent with the existing `MentionableText` tokenizer, and
 * avoids threading extracted-mention metadata through every render path.
 */

import { createIPFSCIDRegex, hasWordBoundaries } from '@quilibrium/quorum-shared';
import type { SpaceMember, Role, Channel } from '@quilibrium/quorum-shared';

// Internal token formats (must match desktop's MessageMarkdownRenderer).
//   <<<MENTION_EVERYONE>>>
//   <<<MENTION_USER:address>>>
//   <<<MENTION_ROLE:roleTag:displayName>>>
//   <<<MENTION_CHANNEL:channelId:channelName>>>
// Spoilers (`||text||`) are NOT tokenized; the renderer detects them inline.

export interface PreprocessOptions {
  members?: SpaceMember[];
  roles?: Role[];
  channels?: Channel[];
}

// ---------------------------------------------------------------------------
// Protected-region helpers — never tokenize/auto-link inside code.
// ---------------------------------------------------------------------------

interface Region {
  start: number;
  end: number;
}

/**
 * Find fenced (```...```) and inline (`...`) code regions so mention/URL
 * processing skips them. Mirrors desktop's `getProtectedRegions`.
 */
function getProtectedRegions(text: string): Region[] {
  const regions: Region[] = [];

  // Fenced code blocks.
  const fenceRegex = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(text)) !== null) {
    regions.push({ start: m.index, end: m.index + m[0].length });
  }

  // Inline code — skip backticks that fall inside an already-found fence.
  const inlineRegex = /`[^`\n]+`/g;
  while ((m = inlineRegex.exec(text)) !== null) {
    const start = m.index;
    const insideFence = regions.some((r) => start >= r.start && start < r.end);
    if (!insideFence) {
      regions.push({ start, end: start + m[0].length });
    }
  }

  return regions;
}

function isInProtectedRegion(index: number, regions: Region[]): boolean {
  return regions.some((r) => index >= r.start && index < r.end);
}

// ---------------------------------------------------------------------------
// Mention / channel tokenization
// ---------------------------------------------------------------------------

/**
 * Convert `@everyone` and `@<address>` user mentions into internal tokens.
 * Also tolerates the legacy bare `@address` format already in storage from
 * older mobile clients (matched against the member map by address/name).
 */
export function processMentions(text: string, members: SpaceMember[] = []): string {
  let processed = text;

  // @everyone first (cheap, no map needed).
  const everyoneRegex = /@everyone\b/gi;
  const everyoneMatches = Array.from(processed.matchAll(everyoneRegex));
  const validEveryone = everyoneMatches.filter(
    (match) =>
      !isInProtectedRegion(match.index!, getProtectedRegions(processed)) &&
      hasWordBoundaries(processed, match)
  );
  for (let i = validEveryone.length - 1; i >= 0; i--) {
    const match = validEveryone[i];
    processed =
      processed.substring(0, match.index) +
      '<<<MENTION_EVERYONE>>>' +
      processed.substring(match.index! + match[0].length);
  }

  // Canonical user mentions: @<address>
  const cidPattern = createIPFSCIDRegex().source;
  const userMentionRegex = new RegExp(`@<(${cidPattern})>`, 'g');
  const userMatches = Array.from(processed.matchAll(userMentionRegex));
  const validUsers = userMatches.filter(
    (match) =>
      hasWordBoundaries(processed, match) &&
      !isInProtectedRegion(match.index!, getProtectedRegions(processed))
  );
  for (let i = validUsers.length - 1; i >= 0; i--) {
    const match = validUsers[i];
    const address = match[1];
    processed =
      processed.substring(0, match.index) +
      `<<<MENTION_USER:${address}>>>` +
      processed.substring(match.index! + match[0].length);
  }

  // Legacy bare @address (no brackets) — only convert when it resolves to a
  // known member, so we don't accidentally tokenize ordinary "@word" text.
  if (members.length > 0) {
    const memberByKey = buildMemberKeyMap(members);
    const bareRegex = /@([a-zA-Z0-9_.\-]+)/g;
    const bareMatches = Array.from(processed.matchAll(bareRegex));
    const validBare = bareMatches.filter((match) => {
      if (!hasWordBoundaries(processed, match)) return false;
      if (isInProtectedRegion(match.index!, getProtectedRegions(processed))) return false;
      return Boolean(memberByKey[match[1].toLowerCase()]);
    });
    for (let i = validBare.length - 1; i >= 0; i--) {
      const match = validBare[i];
      const member = memberByKey[match[1].toLowerCase()];
      processed =
        processed.substring(0, match.index) +
        `<<<MENTION_USER:${member.address}>>>` +
        processed.substring(match.index! + match[0].length);
    }
  }

  return processed;
}

/**
 * Convert role mentions into tokens. Mobile resolves directly against the
 * `roles` prop: both `@<roleId>` (canonical wire format, angle-bracketed UUID)
 * and `@roleTag` (legacy / human-typed) are matched.
 */
export function processRoleMentions(text: string, roles: Role[] = []): string {
  if (roles.length === 0) return text;

  let processed = text;

  // @<roleId> — canonical. roleId is a UUID, angle-bracket wrapped.
  roles.forEach((role) => {
    const escapedId = escapeRegex(role.roleId);
    const regex = new RegExp(`@<${escapedId}>`, 'g');
    const matches = Array.from(processed.matchAll(regex));
    const valid = matches.filter(
      (match) =>
        !isInProtectedRegion(match.index!, getProtectedRegions(processed)) &&
        hasWordBoundaries(processed, match)
    );
    for (let i = valid.length - 1; i >= 0; i--) {
      const match = valid[i];
      processed =
        processed.substring(0, match.index) +
        `<<<MENTION_ROLE:${role.roleTag}:${role.displayName}>>>` +
        processed.substring(match.index! + match[0].length);
    }
  });

  // @roleTag — legacy / human-typed. Match the exact tag, word-bounded.
  roles.forEach((role) => {
    const escapedTag = escapeRegex(role.roleTag);
    const regex = new RegExp(`@${escapedTag}(?!\\w)`, 'g');
    const matches = Array.from(processed.matchAll(regex));
    const valid = matches.filter(
      (match) =>
        !isInProtectedRegion(match.index!, getProtectedRegions(processed)) &&
        hasWordBoundaries(processed, match)
    );
    for (let i = valid.length - 1; i >= 0; i--) {
      const match = valid[i];
      processed =
        processed.substring(0, match.index) +
        `<<<MENTION_ROLE:${role.roleTag}:${role.displayName}>>>` +
        processed.substring(match.index! + match[0].length);
    }
  });

  return processed;
}

/**
 * Convert `#<channelId>` channel mentions into tokens (matched against the
 * channels prop). Mirrors desktop's `processChannelMentions`.
 */
export function processChannelMentions(text: string, channels: Channel[] = []): string {
  if (channels.length === 0) return text;

  let processed = text;
  channels.forEach((channel) => {
    const escapedId = escapeRegex(channel.channelId);
    const regex = new RegExp(`#<${escapedId}>`, 'g');
    const matches = Array.from(processed.matchAll(regex));
    const valid = matches.filter(
      (match) =>
        !isInProtectedRegion(match.index!, getProtectedRegions(processed)) &&
        hasWordBoundaries(processed, match)
    );
    for (let i = valid.length - 1; i >= 0; i--) {
      const match = valid[i];
      processed =
        processed.substring(0, match.index) +
        `<<<MENTION_CHANNEL:${channel.channelId}:${channel.channelName}>>>` +
        processed.substring(match.index! + match[0].length);
    }
  });

  return processed;
}

// ---------------------------------------------------------------------------
// URL / header / code-fence normalization
// ---------------------------------------------------------------------------

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

/**
 * Convert bare URLs to `[url](url)` markdown links, skipping code regions and
 * existing markdown links. Mirrors desktop's `processURLs`.
 */
export function processURLs(text: string): string {
  const protectedRegions = getProtectedRegions(text);

  // Also protect existing markdown links: [text](url) and ![alt](url).
  const mdLinkRegex = /!?\[[^\]]*\]\([^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRegex.exec(text)) !== null) {
    protectedRegions.push({ start: m.index, end: m.index + m[0].length });
  }

  const matches: Array<{ start: number; end: number; url: string }> = [];
  URL_REGEX.lastIndex = 0;
  while ((m = URL_REGEX.exec(text)) !== null) {
    if (!isInProtectedRegion(m.index, protectedRegions)) {
      matches.push({ start: m.index, end: m.index + m[0].length, url: m[0] });
    }
  }

  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end, url } = matches[i];
    result = result.substring(0, start) + `[${url}](${url})` + result.substring(end);
  }
  return result;
}

/**
 * Rewrite `#`/`##` headers to `###` (the renderer only supports one header
 * level). Code blocks are protected via placeholders. Mirrors desktop's
 * `convertHeadersToH3`.
 */
export function convertHeadersToH3(text: string): string {
  const codeBlocks: string[] = [];
  const withPlaceholders = text.replace(/```[\s\S]*?```/g, (block) => {
    codeBlocks.push(block);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // ## or # at line start (but not already ###). Order matters: handle the
  // 1-2 hash cases, leaving 3+ alone.
  const converted = withPlaceholders.replace(/^(#{1,2})(?!#)(\s+)/gm, '###$2');

  return converted.replace(/__CODE_BLOCK_(\d+)__/g, (_, idx) => codeBlocks[Number(idx)]);
}

/**
 * Append a closing fence if the message has an odd number of ``` delimiters.
 * Mirrors desktop's `fixUnclosedCodeBlocks`.
 */
export function fixUnclosedCodeBlocks(text: string): string {
  const parts = text.split('```');
  if (parts.length % 2 === 0) {
    const lastPart = parts[parts.length - 1];
    return text + (lastPart.endsWith('\n') ? '```' : '\n```');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Pipeline + markdown detection
// ---------------------------------------------------------------------------

/**
 * Run the full preprocessing pipeline in the same order as desktop (minus the
 * features deferred on mobile: invite links, standalone YouTube, message links).
 * Returns text with mentions tokenized, URLs auto-linked, headers normalized,
 * and code fences balanced — ready for the markdown renderer.
 */
export function prepareMessageContent(text: string, opts: PreprocessOptions = {}): string {
  let processed = text;
  processed = processMentions(processed, opts.members);
  processed = processRoleMentions(processed, opts.roles);
  processed = processChannelMentions(processed, opts.channels);
  processed = processURLs(processed);
  processed = convertHeadersToH3(processed);
  processed = fixUnclosedCodeBlocks(processed);
  return processed;
}

// Block/inline markdown syntax that warrants the markdown renderer. Bare URLs,
// plain `@mentions`, `#channels` and `:emoji:` do NOT count — those are handled
// fine by the cheaper MentionableText path, so a normal chat line never pays
// the markdown cost.
const MARKDOWN_SYNTAX_REGEX = new RegExp(
  [
    '\\*\\*[^*]+\\*\\*', // **bold**
    '__[^_]+__', // __bold__
    '(?:^|[^*])\\*[^*\\s][^*]*\\*', // *italic*
    '(?:^|[^_])_[^_\\s][^_]*_', // _italic_
    '~~[^~]+~~', // ~~strikethrough~~
    '`[^`]+`', // `inline code`
    '```', // fenced code
    '\\|\\|[^|]+\\|\\|', // ||spoiler||
    '^#{1,6}\\s', // # heading
    '^>\\s', // > blockquote
    '^[-*+]\\s', // - list item
    '^\\d+\\.\\s', // 1. ordered list
    '^---+$', // --- thematic break
  ].join('|'),
  'm'
);

/**
 * Cheap test for whether `text` contains any markdown that requires the full
 * renderer. Messages with none route through `MentionableText` unchanged, so
 * the common case (a plain chat line) pays no markdown cost.
 */
export function hasMarkdown(text: string): boolean {
  if (!text) return false;
  return MARKDOWN_SYNTAX_REGEX.test(text);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMemberKeyMap(members: SpaceMember[]): Record<string, SpaceMember> {
  const map: Record<string, SpaceMember> = {};
  members.forEach((m) => {
    if (m.display_name) map[m.display_name.toLowerCase()] = m;
    if (m.name) map[m.name.toLowerCase()] = m;
    if (m.address) map[m.address.toLowerCase()] = m;
  });
  return map;
}
