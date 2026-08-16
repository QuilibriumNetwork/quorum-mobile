/**
 * forgetAnnouncedNames — un-stick a test device whose rosters hold an
 * unownable announced `.q`.
 *
 * ## The trap this exists to undo
 *
 * "Give MYSELF a .q" is a REAL product action: it broadcasts the name, and
 * every device that hears it stores `claimed_primary_username` on that member's
 * roster row. A stored announcement always outranks anything the fake-QNS
 * overlay injects, because the overlay only patches the public-profile READ and
 * because presence — not truthiness — is how an un-election is expressed.
 *
 * The consequence is that a single press permanently removes that account from
 * every "give everyone a .q" sweep on every device that heard it. "Clear" does
 * not help: it announces an EMPTY name, which is still an announcement, so the
 * overlay stays outranked.
 *
 * That is a defensible product rule and a terrible testing property. This wipes
 * the stored announcements locally so the overlay can reach those rows again.
 *
 * ## What it does NOT do
 *
 * Nothing leaves the device, and nothing is un-announced for anybody else. The
 * sender still believes it elected that name, and it will re-announce on its
 * next profile change (the broadcast gate dedupes by payload signature, so an
 * unchanged profile will not re-send). If a wiped name reappears, that is the
 * sender re-announcing, not this failing.
 *
 * Dev-only.
 */

/** The roster row fields this touches. Loose on purpose — the stored shape
 *  carries many more fields, and all of them must survive untouched. */
export interface AnnouncedNameRow {
  address?: string;
  claimed_primary_username?: string | null;
}

export interface RosterStore {
  /** Every space this device knows about. */
  spaceIds(): string[];
  members(spaceId: string): Promise<AnnouncedNameRow[]>;
  /** Replaces the row wholesale, matching `saveSpaceMember`. */
  saveMember(spaceId: string, member: AnnouncedNameRow): Promise<void>;
}

export interface ForgetResult {
  /** Spaces that held at least one announcement. */
  spacesTouched: number;
  /** Rows rewritten. */
  rowsCleared: number;
  /** Spaces whose roster could not be read or written. Surfaced rather than
   *  swallowed: a partial wipe that reports success would leave the operator
   *  believing a still-stuck account is a product bug. */
  failures: string[];
}

/**
 * Strip `claimed_primary_username` from every roster row that carries it.
 *
 * Deletes the KEY rather than setting it to `''`. That distinction is the whole
 * point: an empty string is a present announcement (an un-election) and would
 * keep outranking the overlay, so writing one here would look like a repair
 * while changing nothing.
 */
export async function forgetAnnouncedNames(store: RosterStore): Promise<ForgetResult> {
  const result: ForgetResult = { spacesTouched: 0, rowsCleared: 0, failures: [] };

  for (const spaceId of store.spaceIds()) {
    let rows: AnnouncedNameRow[];
    try {
      rows = await store.members(spaceId);
    } catch {
      result.failures.push(spaceId);
      continue;
    }

    let touched = false;
    for (const row of rows) {
      if (!row || !('claimed_primary_username' in row)) continue;
      if (row.claimed_primary_username === undefined) continue;

      const { claimed_primary_username: _dropped, ...rest } = row;
      try {
        await store.saveMember(spaceId, rest as AnnouncedNameRow);
        result.rowsCleared += 1;
        touched = true;
      } catch {
        result.failures.push(spaceId);
      }
    }
    if (touched) result.spacesTouched += 1;
  }

  return result;
}

/**
 * The DM half of the same repair.
 *
 * A DM carries no roster, so a partner's announced claim lands on the
 * CONVERSATION row instead (`dm-update-profile` → `claimed_primary_username`,
 * see `DMChatArea`). Clearing only space rosters therefore leaves every DM
 * surface still stuck, which looks exactly like the repair not working at all.
 *
 * Same delete-the-key rule as above, for the same reason.
 */
export interface ConversationStore {
  conversations(): Promise<AnnouncedNameRow[]>;
  save(row: AnnouncedNameRow): Promise<void>;
}

export async function forgetConversationClaims(
  store: ConversationStore,
): Promise<{ rowsCleared: number; failed: boolean }> {
  let rows: AnnouncedNameRow[];
  try {
    rows = await store.conversations();
  } catch {
    return { rowsCleared: 0, failed: true };
  }

  let rowsCleared = 0;
  let failed = false;
  for (const row of rows) {
    if (!row || !('claimed_primary_username' in row)) continue;
    if (row.claimed_primary_username === undefined) continue;
    const { claimed_primary_username: _dropped, ...rest } = row;
    try {
      await store.save(rest as AnnouncedNameRow);
      rowsCleared += 1;
    } catch {
      failed = true;
    }
  }
  return { rowsCleared, failed };
}
