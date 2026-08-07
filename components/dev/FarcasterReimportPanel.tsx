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
 * the broken keychain state, and the surrounding screen is the notifications tab
 * rather than the feed. It opens the real sheet component so its KEYBOARD and
 * LAYOUT behaviour can be exercised — which is safe to test here precisely
 * because the sheet is an RN <Modal>, i.e. its own window, so what is behind it
 * cannot change how it lays out.
 *
 * Do not use it to verify the import ITSELF. Pressing Import runs the real
 * derivation and really writes keys to SecureStore. For a keyboard test, type
 * gibberish — the word-count check rejects it without touching the keychain.
 *
 * Only ever mounted from a `__DEV__` gate at the call site (see the
 * notifications tab); there is no separate internal gate here, matching
 * DmBurstSheet and FarcasterDismissalPanel.
 */

import React, { useState } from 'react';
import { StyleSheet } from 'react-native';
import { DevButton, DevButtonRow, DevPanel, DevWarning } from '@/components/dev/DevPanel';
import FarcasterReimportSheet from '@/components/FarcasterReimportSheet';
import * as Skin from '@/theme/skins/geometry';

export function FarcasterReimportPanel() {
  const [open, setOpen] = useState(false);
  const styles = React.useMemo(() => createStyles(), []);

  return (
    <DevPanel
      title="Farcaster re-import sheet"
      hint="Opens the recovery sheet you otherwise can't reach without a broken keychain. For testing its keyboard/layout only."
      // Collapsible (the default) like the dismissal panel above it: three rows
      // sitting open permanently would push the real notification list down. No
      // badge, because unlike that panel this one never changes app state.
      style={styles.panel}
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

const createStyles = () =>
  StyleSheet.create({
    panel: {
      marginHorizontal: Skin.space(12),
      marginBottom: Skin.space(8),
    },
  });
