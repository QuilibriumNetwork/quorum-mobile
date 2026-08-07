/**
 * FarcasterReimportPanel — dev-build-only opener for FarcasterReimportSheet.
 *
 * WHY THIS EXISTS. The re-import sheet is a corrupted-keychain recovery UI: it
 * only appears on the feed tab when the profile still claims a Farcaster account
 * (fid in MMKV) but the custody key is gone from SecureStore. Nothing in the app
 * produces that state on purpose — the one function that deletes the custody key
 * is `clearAllSecureStorage()` ("Reset App Data"), which also deletes the fid and
 * the Quorum identity, so it lands you in `no-account` and renders the normal
 * feed instead. The screen is therefore unreachable in a healthy build, which is
 * exactly how it shipped with a keyboard that covered the whole sheet and could
 * not be dismissed by any means (quorum-mobile#78).
 *
 * So the point of this panel is narrow and worth stating: it does NOT simulate
 * the broken keychain state, and the surrounding screen is the settings screen
 * rather than the feed. It opens the real sheet component so its KEYBOARD and
 * LAYOUT behaviour can be exercised — which is safe to test from here precisely
 * because the sheet is an RN <Modal>, i.e. its own window, so what is behind it
 * cannot change how it lays out.
 *
 * Do not use it to verify the import ITSELF. Pressing Import runs the real
 * derivation and really writes keys to SecureStore. For a keyboard test, type
 * gibberish — the word-count check rejects it without touching the keychain.
 *
 * Lives in ProfileModal's developer section, next to QnsFakePanel: these panels
 * sit beside the SUBJECT they instrument, and the Farcaster account controls are
 * on that screen. (It was first put on the notifications tab merely because the
 * other Farcaster dev panel is there — but that one belongs there because it is
 * about notifications, which this is not.)
 *
 * Only ever mounted from a `__DEV__` gate at the call site; there is no separate
 * internal gate here, matching DmBurstSheet, QnsFakePanel and
 * FarcasterDismissalPanel.
 */

import React, { useState } from 'react';
import { DevButton, DevButtonRow, DevPanel, DevWarning } from '@/components/dev/DevPanel';
import FarcasterReimportSheet from '@/components/FarcasterReimportSheet';

export function FarcasterReimportPanel() {
  const [open, setOpen] = useState(false);

  return (
    <DevPanel
      title="Farcaster re-import sheet"
      hint="Opens the recovery sheet you otherwise can't reach without a broken keychain. For testing its keyboard/layout only."
      // No `style`: DevModeSection's container owns the horizontal padding, same
      // as the Developer and Fake QNS panels. Passing a marginHorizontal here
      // (copied from the notifications-tab panel, which does need its own) inset
      // this box further than its neighbours.
      //
      // Collapsible (the default) — three rows sitting open permanently would
      // push the Danger Zone down. No badge: unlike Fake QNS this never changes
      // app state, so a folded panel cannot hide anything in effect.
    >
      <DevWarning>
        Import really writes keys to SecureStore. Type gibberish to test the
        keyboard — the word-count check rejects it before any keychain write.
      </DevWarning>
      {/* In a DevButtonRow so it sizes to its label like every other dev
          button — a bare DevButton stretches to the panel width. */}
      <DevButtonRow>
        <DevButton label="Open" onPress={() => setOpen(true)} />
      </DevButtonRow>
      <FarcasterReimportSheet
        visible={open}
        onClose={() => setOpen(false)}
        onImported={() => setOpen(false)}
      />
    </DevPanel>
  );
}
