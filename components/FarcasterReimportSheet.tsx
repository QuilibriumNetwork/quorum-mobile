/**
 * FarcasterReimportSheet — focused recovery UI used when the device's
 * SecureStore is missing the Farcaster custody/signer keys but the
 * user object (MMKV) still claims a Farcaster account. The user pastes
 * their Farcaster recovery phrase; we derive the keys, confirm the
 * lookup matches a real FID, and persist the keys back to SecureStore.
 *
 * This is a separate flow from the main onboarding/farcaster-setup
 * screen because that one is coupled to OnboardingContext and assumes
 * we're walking the user through the full onboarding state machine.
 * Here we just want to top up the keychain.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useTheme } from '@/theme';
import {
  deriveFarcasterKeys,
  lookupFarcasterAccount,
  validateFarcasterMnemonic,
} from '@/services/onboarding/farcasterService';
import {
  storeFarcasterAuthToken,
  storeFarcasterAuthTokenExpiresAt,
  storeFarcasterCustodyKey,
  storeFarcasterFid,
  storeFarcasterSignerKey,
} from '@/services/onboarding/secureStorage';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called after we successfully store keys so the parent can refresh
   *  its token state. */
  onImported: () => void;
}

export default function FarcasterReimportSheet({ visible, onClose, onImported }: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [mnemonic, setMnemonic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleImport = async () => {
    const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length !== 12 && words.length !== 24) {
      setError('Recovery phrase must be 12 or 24 words.');
      return;
    }
    if (!validateFarcasterMnemonic(words)) {
      setError('That doesn’t look like a valid recovery phrase.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const keys = deriveFarcasterKeys(words);
      const account = await lookupFarcasterAccount(
        keys.custodyAddress,
        keys.custodyPrivateKey,
      );
      if (!account?.fid) {
        setError(
          'No Farcaster account was found for that recovery phrase. Double-check you used the Farcaster phrase (not your Quorum one).',
        );
        return;
      }
      const writes = [
        storeFarcasterCustodyKey(keys.custodyPrivateKey),
        storeFarcasterSignerKey(keys.signerPrivateKey),
        storeFarcasterFid(account.fid),
      ];
      if (account.authToken) {
        writes.push(storeFarcasterAuthToken(account.authToken));
        if (account.authTokenExpiresAt != null) {
          writes.push(storeFarcasterAuthTokenExpiresAt(account.authTokenExpiresAt));
        }
      }
      await Promise.all(writes);
      setMnemonic('');
      onImported();
      onClose();
    } catch (e) {
      setError(`Couldn’t import: ${(e as Error)?.message ?? 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.45)' }]}>
        {/* Bottom inset so the Cancel/Import buttons clear the system nav bar. */}
        <View
          style={[
            styles.card,
            // Additive so the action buttons clear the nav bar with a real gap.
            { backgroundColor: theme.colors.surface1, paddingBottom: insets.bottom + Skin.space(20) },
          ]}
        >
          <Text style={[styles.title, { color: theme.colors.textStrong }]}>
            Re-import Farcaster
          </Text>
          <Text style={[styles.body, { color: theme.colors.textSubtle /* secondary text → subtle (muted is unreadable in light) */ }]}>
            Paste your Farcaster recovery phrase. We derive the signing keys
            locally and store them in this device&apos;s keychain.
          </Text>
          <TextInput
            value={mnemonic}
            onChangeText={(t) => {
              setMnemonic(t);
              if (error) setError(null);
            }}
            placeholder="12 or 24 words separated by spaces"
            placeholderTextColor={theme.colors.textMuted}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[
              styles.input,
              {
                color: theme.colors.textMain,
                backgroundColor: theme.colors.bgButtonSubtle,
                borderColor: theme.colors.border,
              },
            ]}
          />
          {error ? (
            <Text style={[styles.error, { color: theme.colors.danger ?? '#FF3B30' }]}>
              {error}
            </Text>
          ) : null}
          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={onClose}
              disabled={busy}
              style={[styles.action, { borderColor: theme.colors.border }]}
            >
              <Text style={[styles.actionText, { color: theme.colors.textMain }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => void handleImport()}
              disabled={busy}
              style={[
                styles.action,
                {
                  backgroundColor: theme.colors.primary,
                  opacity: busy ? 0.6 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={[styles.actionText, { color: '#fff' }]}>Import</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  card: {
    padding: Skin.space(20),
    // paddingBottom applied inline from the real safe-area inset.
    borderTopLeftRadius: Skin.radius(16),
    borderTopRightRadius: Skin.radius(16),
    gap: Skin.space(12),
  },
  title: { fontSize: Skin.font(18), fontWeight: '600' },
  body: { fontSize: Skin.font(14), lineHeight: Skin.font(20) },
  input: {
    minHeight: 100,
    borderWidth: Skin.border(1),
    borderRadius: Skin.radius(10),
    padding: Skin.space(12),
    fontSize: Skin.font(15),
    textAlignVertical: 'top',
  },
  error: { fontSize: Skin.font(13) },
  actionRow: { flexDirection: 'row', gap: Skin.space(8), marginTop: Skin.space(4) },
  action: {
    flex: 1,
    paddingVertical: Skin.space(12),
    borderRadius: Skin.radius(10),
    borderWidth: Skin.border(1),
    borderColor: 'transparent',
    alignItems: 'center',
  },
  actionText: { fontSize: Skin.font(15), fontWeight: '600' },
}));
