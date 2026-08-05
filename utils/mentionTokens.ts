/**
 * The one parser for mention tokens in message text.
 *
 * Messages carry mentions in wire format — `@<QmAbc…>` for a user, `@everyone`,
 * `@roleTag` for a role — and every surface that shows message text has to turn
 * those back into something a person can read.
 *
 * The chat view has always done this, but the logic lived inside
 * `MentionableText` as a component-local regex, so the notification panel could
 * not call it and simply rendered the raw text. A mention-only message therefore
 * showed as a bare 40-character hash and told the user nothing at all. This file
 * is that parser, lifted out so both callers share it — two regexes for one wire
 * format is how they drift.
 *
 * The tokenizer deliberately does NOT decide what a token refers to. `@design`
 * is indistinguishable from `@someLegacyHandle` by shape alone; only a lookup
 * against the space's members and roles can tell them apart, and the two callers
 * have different lookups available (the chat view holds the full roster; the
 * notification write path can fetch one member at a time). So this file finds
 * and rewrites; callers resolve.
 */

import { truncateAddress } from './formatAddress';

/**
 * Group 1: bracketed canonical `@<address>`. Group 2: `@everyone`.
 * Group 3: legacy bare `@address` — ALSO how role tags arrive, which is why
 * shape alone cannot classify it.
 */
export const MENTION_REGEX = /@<([^>]+)>|@(everyone)|@([a-zA-Z0-9_.\-]+)/g;

export type MentionTokenKind =
  /** `@everyone`. */
  | 'everyone'
  /** `@<address>` — canonical, unambiguously a user. */
  | 'address'
  /** `@word` — a role tag, or a legacy bare address. Caller decides. */
  | 'bare';

export interface MentionToken {
  /** The whole matched substring, e.g. `@<QmAbc…>`. */
  raw: string;
  start: number;
  /** Exclusive, so `text.slice(start, end) === raw`. */
  end: number;
  /** `'everyone'`, the address inside the brackets, or the bare word. */
  key: string;
  kind: MentionTokenKind;
}

export function findMentionTokens(text: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  if (!text) return tokens;
  // The regex is module-level and stateful (/g), so reset before every scan —
  // a leftover lastIndex silently skips the start of the next string.
  MENTION_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_REGEX.exec(text)) !== null) {
    const kind: MentionTokenKind = match[1] ? 'address' : match[2] ? 'everyone' : 'bare';
    tokens.push({
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      key: match[1] ?? match[2] ?? match[3] ?? '',
      kind,
    });
  }
  return tokens;
}

/**
 * How long a bare `@word` has to be before we treat it as an address that
 * failed to resolve rather than as a role tag or handle. Real role tags are
 * short; a Qm address is 46 characters. 20 sits far from both.
 */
const BARE_ADDRESS_MIN_LENGTH = 20;

/**
 * Rewrite mention tokens into readable plain text.
 *
 * `resolve` maps an address to a display name and returns undefined when it
 * cannot. An unresolved address is TRUNCATED rather than passed through whole —
 * mirroring how the notification path already refuses to surface a raw hash for
 * the sender. Showing `@Qm3f4a…8b2` is little use, but it is at least a name
 * shape; a full hash is a wall of noise that pushes the actual message off the
 * row.
 *
 * Roles and unknown short handles are left exactly as written: `@design` is
 * already what the sender typed and what the reader expects to see.
 */
export function renderMentionsAsPlainText(
  text: string,
  resolve: (address: string) => string | undefined = () => undefined,
): string {
  const tokens = findMentionTokens(text);
  if (tokens.length === 0) return text;

  let out = '';
  let cursor = 0;
  for (const token of tokens) {
    out += text.slice(cursor, token.start);
    out += replacementFor(token, resolve);
    cursor = token.end;
  }
  return out + text.slice(cursor);
}

function replacementFor(
  token: MentionToken,
  resolve: (address: string) => string | undefined,
): string {
  if (token.kind === 'everyone') return '@everyone';

  const resolved = resolve(token.key)?.trim();
  if (resolved) return `@${resolved}`;

  if (token.kind === 'address') return `@${truncateAddress(token.key, 'short')}`;

  // Bare and unresolved: a role tag or handle, unless it is long enough that it
  // is clearly an address someone wrote without brackets.
  return token.key.length >= BARE_ADDRESS_MIN_LENGTH
    ? `@${truncateAddress(token.key, 'short')}`
    : token.raw;
}

/** Every distinct address a message text mentions, in order of first mention. */
export function mentionedAddresses(text: string): string[] {
  const seen = new Set<string>();
  for (const token of findMentionTokens(text)) {
    if (token.kind === 'address') seen.add(token.key);
    else if (token.kind === 'bare' && token.key.length >= BARE_ADDRESS_MIN_LENGTH) {
      seen.add(token.key);
    }
  }
  return [...seen];
}
