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

import React, { useCallback, useState } from 'react';
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConfirmActions } from '@/components/shared/ConfirmActions';
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
  const { height: windowHeight } = useWindowDimensions();
  const [mnemonic, setMnemonic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An RN <Modal> is its own window: iOS never resizes it for the keyboard, and
  // on Android KeyboardProvider puts modal windows in SOFT_INPUT_ADJUST_NOTHING
  // (react-native-keyboard-controller's ModalAttachedWatcher). This card is
  // bottom-anchored, so unless we lift it by hand the keyboard draws straight
  // over the input AND both buttons. Same approach as CenterModal.
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const shownKeyboardHeight = useKeyboardState((s) => (s.isVisible ? s.height : 0));

  const cardAnimatedStyle = useAnimatedStyle(() => ({
    // `height` runs 0 -> -keyboardHeight (keyboard-controller convention), so it
    // is already an upward shift. Adding the bottom inset back cancels the
    // card's own safe-area padding, which the keyboard is now covering anyway.
    transform: [{ translateY: keyboardHeight.value + keyboardProgress.value * insets.bottom }],
  }));

  // Once lifted, a tall card (24-word phrase + an error line) could run off the
  // top of a short screen. Cap it and let the content scroll instead.
  const cardMaxHeight = windowHeight - shownKeyboardHeight - insets.top - Skin.space(24);

  // The original defect was that there was no way out: the keyboard covered the
  // whole sheet and tapping outside did nothing. Tapping the backdrop now drops
  // the keyboard first, so a half-typed phrase survives; a second tap closes.
  const handleBackdropPress = useCallback(() => {
    if (shownKeyboardHeight > 0) {
      Keyboard.dismiss();
      return;
    }
    onClose();
  }, [shownKeyboardHeight, onClose]);

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
      // deriveFarcasterKeys is heavy SYNCHRONOUS crypto (BIP-39/32) that blocks
      // the JS thread. Yield one tick first so React can paint the spinner before
      // the thread locks up — otherwise the button looks dead for 20-30s.
      await new Promise((resolve) => setTimeout(resolve, 0));
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
        {/* Tap-outside target. Sits behind the card, which is the only child in
            normal flow and therefore still pinned to the bottom. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={handleBackdropPress}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
        {/* Bottom inset so the Cancel/Import buttons clear the system nav bar. */}
        <Animated.View
          style={[
            styles.card,
            // Additive so the action buttons clear the nav bar with a real gap.
            {
              backgroundColor: theme.colors.surface1,
              paddingBottom: insets.bottom + Skin.space(20),
              maxHeight: cardMaxHeight,
            },
            cardAnimatedStyle,
          ]}
        >
          <ScrollView
            style={styles.cardScroll}
            contentContainerStyle={styles.cardScrollContent}
            // "handled" lets a tap on the card's own padding dismiss the
            // keyboard while still delivering taps to the buttons.
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
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
              // A multiline input defaults to inserting a newline on Return, which
              // left this keyboard with no dismiss key at all. A recovery phrase is
              // one line of space-separated words, so trading the newline for a
              // working Done key costs nothing. Pasting a phrase that contains
              // newlines is unaffected — RN only applies this to typed Returns.
              submitBehavior="blurAndSubmit"
              returnKeyType="done"
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
            {/* The shared cancel/confirm pair, not a hand-rolled row — this
                sheet was one of the places that had drifted. */}
            <ConfirmActions
              confirmLabel="Import"
              variant="primary"
              surface="sheet"
              onConfirm={() => void handleImport()}
              onCancel={onClose}
              cancelDisabled={busy}
              confirmDisabled={busy}
              confirmLoading={busy}
              style={styles.actionRow}
            />
          </ScrollView>
        </Animated.View>
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
  },
  // flexShrink so the scroll actually honours the card's maxHeight instead of
  // pushing past it.
  cardScroll: { flexShrink: 1 },
  cardScrollContent: { gap: Skin.space(12) },
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
  // Spacing only. Row direction, gap and the buttons themselves belong to
  // ConfirmActions — its `style` prop is for the host's own layout.
  actionRow: { marginTop: Skin.space(4) },
}));
