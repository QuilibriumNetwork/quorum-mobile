/**
 * Does a claimed `.q` name actually belong to the account claiming it?
 *
 * A `primary_username` is a SELF-REPORTED field. It arrives in someone else's
 * profile or broadcast, signed by them, and a signature proves who sent a
 * payload rather than that its contents are true. Nothing upstream checks it:
 * the server intends to and its check is broken, and the space/DM broadcast
 * removes the server from the loop entirely. So the receiving client is the
 * only party in a position to ask whether the claim holds.
 *
 * The check itself is one comparison:
 *
 *     claimed name ──resolve──▶ resolveKey (ed448 public key)
 *                                    │  deriveAddress()
 *                                    ▼
 *                          derived Qm address  ===  the address it arrived with?
 *
 * ## Pure, synchronous, and boolean on purpose
 *
 * No network here. Callers resolve names upstream, in one batched request, and
 * hand the record in. That keeps this testable without mocking anything and
 * keeps the name resolver downstream of it unaware that verification exists.
 *
 * Boolean rather than tri-state, deliberately. "Verified", "not verified" and
 * "could not tell" collapse to two outcomes because the moment a caller can
 * distinguish "could not tell" from "no", somebody will render it
 * optimistically — and an optimistic `.q`, even for the instant before a lookup
 * returns, is the entire attack. A screenshot does not expire.
 *
 * ## Every ambiguous case is FALSE, because the errors are not symmetric
 *
 * Withholding a `.q` from its rightful owner is invisible and self-correcting:
 * they render under their global name until a lookup succeeds. Granting one to
 * an impersonator is undetectable by the viewer and permanent. So no record, no
 * key, a malformed key, a missing address — all false.
 */

import { base64ToHex } from '@/utils/encoding';
import { deriveAddress } from '@/utils/deriveAddress';

/**
 * The parts of a QNS `NameRecord` this needs.
 *
 * Structural rather than importing `NameRecord`, so a caller can pass a row
 * from anywhere that carries the key without the record having to be the exact
 * API type — and so this module does not pull the QNS client into its imports.
 */
export interface ResolvedNameKey {
  /** Hex-encoded ed448 public key. What `/resolve` and `/resolve/batch` return. */
  resolveKey?: string | null;
  /** Base64-encoded, same key. What `/bucket/{tag}` returns instead. */
  resolve_key?: string | null;
}

/**
 * Read whichever spelling of the key the record carries, as hex.
 *
 * Both are handled because the two endpoints disagree about encoding and about
 * casing, and treating the bucket spelling as absent would silently unverify
 * every record that arrived that way. The symptom would be "my name lost its
 * `.q`" with nothing logged anywhere — the worst shape of bug this feature can
 * produce, because it looks exactly like the feature simply not working.
 */
function readKeyAsHex(record: ResolvedNameKey | null | undefined): string | undefined {
  const hex = (record?.resolveKey ?? '').trim();
  if (hex) return hex.replace(/^0x/i, '');

  const b64 = (record?.resolve_key ?? '').trim();
  if (!b64) return undefined;
  try {
    return base64ToHex(b64).replace(/^0x/i, '');
  } catch {
    return undefined;
  }
}

/**
 * True only when `record` proves the name resolves to `claimantAddress`.
 *
 * `claimantAddress` is the address the claim arrived attached to — the roster
 * row's address, the message sender's address. Never a value taken from the
 * same payload as the claim itself, which would let a forger supply both sides
 * of the comparison.
 */
export function claimedNameBelongsTo(
  record: ResolvedNameKey | null | undefined,
  claimantAddress: string | null | undefined,
): boolean {
  const address = (claimantAddress ?? '').trim();
  if (!address) return false;

  const keyHex = readKeyAsHex(record);
  if (!keyHex) return false;

  let derived: string;
  try {
    derived = deriveAddress(keyHex);
  } catch {
    // Malformed key: odd-length hex, non-hex characters, wrong length. Fail
    // closed rather than propagate — this runs on the path that produces a
    // message list, and a throw here renders as a blank screen, which is a
    // far worse outcome than a name missing its suffix.
    return false;
  }

  // Exact comparison. base58 is case-SIGNIFICANT, so the reflex from hex and
  // Ethereum work — lowercase both sides before comparing — would make
  // near-miss addresses verify against each other.
  return derived === address;
}
