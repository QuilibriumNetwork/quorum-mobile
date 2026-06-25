/**
 * Shared edit-history logic for message edits (DM + space), so the send,
 * optimistic-cache, and receive paths can't drift apart.
 *
 * Mirrors desktop (`MessageService.ts` ~1100-1160):
 * - `saveEditHistory` OFF  → no prior versions are retained (`edits: []`).
 * - `saveEditHistory` ON   → the new version is appended to `edits`.
 * - On the RECEIVE path, a replayed edit-message (same `editNonce` already
 *   applied) is a no-op so a duplicate delivery can't clobber stored history.
 *   `lastModifiedHash` records the applied nonce to make that check possible.
 */

import type { Message } from '@quilibrium/quorum-shared';

type EditEntry = NonNullable<Message['edits']>[number];

/**
 * Build the `edits` array for an edited message on the SEND / optimistic path,
 * where the editing device applies its own edit exactly once (no replay risk).
 *
 * @param existingEdits prior `edits` on the message (may be undefined)
 * @param newText       the edited text
 * @param editedAt      timestamp of this edit
 * @param saveEditHistory whether to retain prior versions
 */
export function buildLocalEdits(
  existingEdits: Message['edits'] | undefined,
  newText: string | string[],
  editedAt: number,
  saveEditHistory: boolean,
): EditEntry[] {
  if (!saveEditHistory) return [];
  return [
    ...(existingEdits || []),
    { text: newText, modifiedDate: editedAt, lastModifiedHash: '' },
  ];
}

/** Result of applying a received edit to a stored/cached message. */
export interface AppliedEdit {
  /** When false, the edit was already applied — leave the message untouched. */
  changed: boolean;
  modifiedDate: number;
  /** Records the applied nonce so a later replay is detected and skipped. */
  lastModifiedHash: string;
  edits: EditEntry[];
}

/**
 * Decide how a RECEIVED edit-message should mutate a message's edit metadata.
 *
 * Returns `changed: false` when this exact edit (by `editNonce`) was already
 * applied — the caller must then make NO change, preventing a replayed
 * edit-message from wiping previously-stored history. When `editNonce` is empty
 * (legacy senders that don't stamp one) the guard is skipped and the edit is
 * always applied, matching the prior always-apply behavior.
 */
export function applyReceivedEdit(
  current: { edits?: Message['edits']; lastModifiedHash?: string },
  params: { newText: string | string[]; editedAt: number; editNonce?: string; saveEditHistory: boolean },
): AppliedEdit {
  const { newText, editedAt, editNonce, saveEditHistory } = params;

  // Replay guard: same edit already applied → no-op (don't touch edits).
  if (editNonce && current.lastModifiedHash === editNonce) {
    return {
      changed: false,
      modifiedDate: editedAt,
      lastModifiedHash: current.lastModifiedHash ?? '',
      edits: current.edits ?? [],
    };
  }

  return {
    changed: true,
    modifiedDate: editedAt,
    lastModifiedHash: editNonce ?? '',
    edits: saveEditHistory
      ? [
          ...(current.edits || []),
          { text: newText, modifiedDate: editedAt, lastModifiedHash: editNonce ?? '' },
        ]
      : [],
  };
}
