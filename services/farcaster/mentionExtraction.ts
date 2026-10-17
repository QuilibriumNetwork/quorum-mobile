/**
 * Mention extraction — reverse of the read-side substitution.
 *
 * Legacy `client.farcaster.xyz/v2/casts` accepts `@username` inline and
 * resolves to FIDs server-side. Hypersnap stores the text with each
 * resolved mention stripped, accompanied by an aligned
 * (mentions, mentionsPositions) pair where positions are UTF-8 byte
 * offsets *into the stored text*.
 *
 * When we publish via hypersnap from a composer the user has typed
 * `@username` into, we have to do that translation client-side:
 *   1. find every `@username` token in the composed text,
 *   2. resolve each to a FID through Hypersnap,
 *   3. strip the `@username` substring from the text,
 *   4. record the byte offset (in the *stripped* text) where the
 *      mention used to start.
 *
 * Unresolvable handles are left inline as plain `@username` literals —
 * better than dropping them entirely.
 */

import { QueryClient } from '@tanstack/react-query';
import { DEFAULT_HYPERSNAP_BASE_URL, getDefaultHypersnapClient } from '@quilibrium/quorum-shared';

/** Pattern that matches a composed @-handle. Same character class as the
 *  composer's autocomplete trigger (`MentionAutocomplete.getMentionInfo`):
 *  alphanumeric + `.`, `_`, `-`. Anchored to a non-handle char on the
 *  left so emails / `foo@bar.com` don't false-positive. */
const HANDLE_RE = /(^|[^a-zA-Z0-9._-])@([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)/g;

export interface ExtractMentionsResult {
  /** Text with every resolved `@username` stripped — what gets stored
   *  in `castAddBody.text`. */
  text: string;
  /** Aligned with `mentionsPositions`. FIDs in insertion order. */
  mentions: number[];
  /** UTF-8 byte offsets in the stripped text where each `@username`
   *  was removed. */
  mentionsPositions: number[];
}

/**
 * Resolve a Farcaster username to a FID through Hypersnap, uncached. Handles
 * both kinds of username: an fname (`alice`) via the user lookup, and an ENS
 * name (`alice.eth`) via the hub's username proofs, which the user lookup does
 * not cover. The name is never rewritten: `alice.eth` and `alice` can be
 * different accounts. Null for unknown names or on network failure.
 */
export async function lookupFidByUsername(username: string): Promise<number | null> {
  const name = username.trim().replace(/^@/, '');
  if (!name) return null;
  if (!name.includes('.')) {
    try {
      const u = await getDefaultHypersnapClient().getUserByUsername(name);
      if (u?.fid && Number.isFinite(u.fid)) return u.fid;
    } catch {
      // Fall through to the username-proof lookup.
    }
  }
  try {
    const res = await fetch(
      `${DEFAULT_HYPERSNAP_BASE_URL}/v1/userNameProofByName?name=${encodeURIComponent(name.toLowerCase())}`,
      { headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { fid?: number };
    return typeof json.fid === 'number' && json.fid > 0 ? json.fid : null;
  } catch {
    return null;
  }
}

/** {@link lookupFidByUsername}, cached on the supplied React Query client so
 *  the same handle isn't re-resolved across composers / per keystroke.
 *
 *  Returns `null` for unknown handles — caller should leave the `@…`
 *  inline rather than silently dropping it. */
export async function resolveFidByUsername(
  qc: QueryClient,
  username: string,
): Promise<number | null> {
  if (!username) return null;
  return qc.fetchQuery({
    queryKey: ['farcaster', 'fid-by-username', username.toLowerCase()] as const,
    queryFn: () => lookupFidByUsername(username),
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** Count UTF-8 bytes for the given JS string. */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Walk the composed text left-to-right, collect every `@username`
 * occurrence, resolve in parallel, then rebuild the stripped text +
 * aligned (mentions, mentionsPositions) arrays.
 *
 * Pure function modulo the network calls inside `resolveFidByUsername` —
 * easy to unit test against a mock resolver.
 */
export async function extractMentions(
  composedText: string,
  qc: QueryClient,
): Promise<ExtractMentionsResult> {
  if (!composedText.includes('@')) {
    return { text: composedText, mentions: [], mentionsPositions: [] };
  }

  // First pass: collect all @-handle matches with their char offsets.
  HANDLE_RE.lastIndex = 0;
  const raw: { handleStart: number; handleEnd: number; username: string }[] = [];
  for (;;) {
    const m = HANDLE_RE.exec(composedText);
    if (!m) break;
    const username = m[2];
    // m.index is the position of the *prefix* boundary char (or -1 of
    // string start). The `@` itself sits at m.index + m[1].length.
    const handleStart = m.index + m[1].length;
    const handleEnd = handleStart + 1 + username.length; // `@` + username chars
    raw.push({ handleStart, handleEnd, username });
  }
  if (raw.length === 0) {
    return { text: composedText, mentions: [], mentionsPositions: [] };
  }

  // Second pass: resolve each handle to a FID in parallel.
  const fids = await Promise.all(
    raw.map((r) => resolveFidByUsername(qc, r.username)),
  );

  // Third pass: rebuild stripped text + aligned arrays. Walk left to
  // right and track the byte offset in the OUTPUT (stripped) text.
  const out: string[] = [];
  const mentions: number[] = [];
  const positions: number[] = [];
  let cursor = 0;
  let outByteLen = 0;
  for (let i = 0; i < raw.length; i++) {
    const { handleStart, handleEnd } = raw[i];
    const fid = fids[i];
    // Emit the segment between the previous handle and this one.
    const segment = composedText.slice(cursor, handleStart);
    out.push(segment);
    outByteLen += utf8ByteLength(segment);
    if (fid != null) {
      // Resolved — strip the `@username`, record byte position.
      mentions.push(fid);
      positions.push(outByteLen);
    } else {
      // Unresolved — keep `@username` inline.
      const handle = composedText.slice(handleStart, handleEnd);
      out.push(handle);
      outByteLen += utf8ByteLength(handle);
    }
    cursor = handleEnd;
  }
  out.push(composedText.slice(cursor));

  return { text: out.join(''), mentions, mentionsPositions: positions };
}
