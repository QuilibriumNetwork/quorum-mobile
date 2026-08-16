/**
 * announcedNameStatus — which accounts on THIS device carry a stored
 * announcement, and are therefore unreachable by the fake-QNS overlay.
 *
 * ## Why this exists
 *
 * "Everyone got a `.q` except this one person" has exactly one common cause,
 * and it is invisible: that account once used "Announce for real", so this
 * device stored a `claimed_primary_username` for them, and a stored
 * announcement always outranks the overlay. Two sessions were spent deciding
 * whether that was a product bug. It was not.
 *
 * `forgetAnnouncedNames` already repairs it. The gap this closes is that the
 * repair was the only way to find out — you had to run it and read the count
 * afterwards, which is a destructive test for a diagnostic question. This
 * answers the question without changing anything.
 *
 * ## It reports the address, not just self
 *
 * The stuck account is normally somebody ELSE as seen from the device doing the
 * sweep — the announcement originated on the account's own device and travelled
 * here. A self-only check would therefore have answered "no" on the very device
 * where the symptom was visible. Scanning every row makes the offending account
 * name itself.
 *
 * ## An empty claim is a finding, not an absence
 *
 * `''` is an un-election: still a present announcement, still outranking the
 * overlay. It reads as "nothing there" and is the single most misleading state
 * this can be in, because it is what "Clear" leaves behind. It is reported.
 *
 * ## The predicate is deliberately IDENTICAL to the repair's
 *
 * Key present and value not `undefined` — including `null`. If this used a
 * different rule the panel would report a count the repair could not clear (or
 * clear rows it never reported), and a diagnostic that disagrees with its own
 * fix is worse than no diagnostic. Pinned by a test.
 *
 * Dev-only.
 */

import type { AnnouncedNameRow, ConversationStore, RosterStore } from './forgetAnnouncedNames';

export interface AnnouncedClaimRow {
  address: string;
  /** Distinct values seen, in scan order. `''` is meaningful — see above. */
  claims: string[];
  /** Space ids, and `'DM'` for the conversation row. */
  where: string[];
}

export interface AnnouncedScan {
  rows: AnnouncedClaimRow[];
  /** Space ids (or `'DM'`) whose rows could not be read. Surfaced rather than
   *  swallowed: an unreadable roster means "unknown", and reporting it as
   *  "clean" would send someone back to hunting a product bug. */
  failures: string[];
}

/**
 * Does this row carry a stored announcement?
 *
 * Exported so the repair's own predicate can be pinned against it. Presence of
 * the key, not truthiness of the value.
 */
export function hasStoredClaim(row: AnnouncedNameRow | null | undefined): boolean {
  if (!row || !('claimed_primary_username' in row)) return false;
  return row.claimed_primary_username !== undefined;
}

/**
 * Read-only. Nothing is written and nothing is fetched — this is a local
 * storage scan, so it is safe to run before concluding anything.
 */
export async function scanAnnouncedNames(
  roster: RosterStore,
  // Only the read half is needed; taking the full store would force the caller
  // to supply a `save` this never calls.
  conversations: Pick<ConversationStore, 'conversations'>,
): Promise<AnnouncedScan> {
  const byAddress = new Map<string, AnnouncedClaimRow>();
  const failures: string[] = [];

  const record = (row: AnnouncedNameRow | null | undefined, where: string) => {
    if (!row?.address || !hasStoredClaim(row)) return;
    // `null` normalises to `''` — both are "present but names nobody", and the
    // repair treats them the same way.
    const claim = (row.claimed_primary_username ?? '').trim();

    const existing = byAddress.get(row.address);
    if (!existing) {
      byAddress.set(row.address, { address: row.address, claims: [claim], where: [where] });
      return;
    }
    // Distinct values only. Two spaces holding the same claim is the normal
    // case and listing it twice would read as a conflict.
    if (!existing.claims.includes(claim)) existing.claims.push(claim);
    if (!existing.where.includes(where)) existing.where.push(where);
  };

  for (const spaceId of roster.spaceIds()) {
    let rows: AnnouncedNameRow[];
    try {
      rows = await roster.members(spaceId);
    } catch {
      failures.push(spaceId);
      continue;
    }
    for (const row of rows) record(row, spaceId);
  }

  try {
    for (const row of await conversations.conversations()) record(row, 'DM');
  } catch {
    failures.push('DM');
  }

  return { rows: [...byAddress.values()], failures };
}

/**
 * One human-readable line per stuck account.
 *
 * Pure and separately tested because the empty-claim wording is the part that
 * has to survive edits: a line that renders `''` as blank would reproduce the
 * exact confusion this module exists to remove.
 *
 * `shorten` is injected rather than imported so this stays free of the theme
 * and formatting stack, and so a test can pin the wording without pinning the
 * truncation preset.
 */
export function describeAnnouncedRow(
  row: AnnouncedClaimRow,
  selfAddress: string | undefined,
  shorten: (address: string) => string,
): string {
  const who = row.address === selfAddress ? `me (${shorten(row.address)})` : shorten(row.address);
  const claims = row.claims
    .map((c) => (c ? `"${c}.q"` : 'EMPTY — un-election, still outranks the overlay'))
    .join(' / ');
  const spaces = row.where.filter((w) => w !== 'DM').length;
  const where = [
    spaces ? `${spaces} space${spaces === 1 ? '' : 's'}` : null,
    row.where.includes('DM') ? 'DM' : null,
  ]
    .filter(Boolean)
    .join(', ');
  return `${who} — ${claims} · ${where}`;
}
