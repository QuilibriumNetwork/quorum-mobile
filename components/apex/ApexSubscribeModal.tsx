/**
 * ApexSubscribeModal - Subscribe to (or renew) Quorum Apex.
 *
 * Apex is a $25/month subscription paid in wQUIL, SNAP, or USDC on
 * Ethereum mainnet. The payment is split 5 ways through the ApexSplitter
 * contract — 1/5 to Q Inc and 1/5 each to four spaces of the
 * subscriber's choosing (spaces that have published an Apex config
 * accepting the chosen token).
 *
 * Progressive disclosure (mirrors TipModal): pick a token → quote loads →
 * pick exactly 4 spaces → confirm wallet → pay. Errors render inline
 * (BaseModal sits above root toasts); success toasts fire after close.
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useApexEligibleSpaces, useApexSubscription, type ApexEligibleSpace } from '@/hooks/useApex';
import { getWalletPrivateKey } from '@/hooks/useQNSPayment';
import { useWalletKeys } from '@/hooks/useWallet';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import { useWarpcastWallet } from '@/hooks/useWarpcastWallet';
import {
  APEX_CHAIN_ID,
  APEX_PRICE_USD,
  APEX_TOKENS,
  isApexSplitterDeployed,
  type ApexToken,
} from '@/services/apex/config';
import { getApexQuote } from '@/services/apex/apexPricing';
import { payApexSubscription } from '@/services/apex/apexPaymentService';
import { getQuorumClient } from '@/services/api/quorumClient';
import { USDC_ICON_URL } from '@/services/wallet/balanceService';
import { getLocalTokenIconUri } from '@/services/wallet/tokenIcons';
import WalletSelector from '@/components/wallet/WalletSelector';
import { useTheme, type AppTheme } from '@/theme';
import { getErrorMessage } from '@/utils/error';
import { truncateAddress } from '@/utils/formatAddress';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEBUG_APEX_SPACES,
  clearDebugApexSubscription,
  isDebugSpaceAddress,
  setDebugApexSubscription,
} from '@/services/apex/apexDebug';
import React from 'react';
import { ActivityIndicator, Alert, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { APEX_GOLD } from '@/components/ui/ApexAvatarRing';
import { SpaceIcon } from '@/components/ui/SpaceIcon';
import * as Skin from '@/theme/skins/geometry';

interface ApexSubscribeModalProps {
  visible: boolean;
  onClose: () => void;
  mode: 'subscribe' | 'renew';
}

const REQUIRED_SPACES = 4;
const PERIOD_MS = 30 * 86_400_000;

const TOKEN_ORDER: ApexToken[] = ['wQUIL', 'SNAP', 'USDC'];

/** Icon URI per Apex token — bundled art for wQUIL/SNAP, CDN for USDC. */
function getApexTokenIconUri(token: ApexToken): string | undefined {
  if (token === 'USDC') return USDC_ICON_URL;
  return getLocalTokenIconUri(APEX_TOKENS[token].address);
}

export default function ApexSubscribeModal({ visible, onClose, mode }: ApexSubscribeModalProps) {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const { refetch: fetchKeys } = useWalletKeys();
  const { activeWallet, activeType } = useWalletSelection();
  const { importedWallet } = useWarpcastWallet();
  const { subscription } = useApexSubscription();

  const [selectedToken, setSelectedToken] = React.useState<ApexToken | null>(null);
  const [selectedSpaces, setSelectedSpaces] = React.useState<string[]>([]);
  const [isPaying, setIsPaying] = React.useState(false);
  const [payError, setPayError] = React.useState<string | null>(null);

  const styles = createStyles(theme);
  const splitterDeployed = isApexSplitterDeployed(APEX_CHAIN_ID);

  // Renew mode: preselect the current subscription's token + spaces (the
  // user may still change both — a renewal payment sets a fresh lineup).
  React.useEffect(() => {
    if (!visible) {
      setSelectedToken(null);
      setSelectedSpaces([]);
      setIsPaying(false);
      setPayError(null);
      return;
    }
    if (mode === 'renew' && subscription) {
      setSelectedToken(subscription.token);
      setSelectedSpaces(subscription.space_addresses.slice(0, REQUIRED_SPACES));
    }
    // Intentionally keyed on visibility only — re-running on background
    // subscription refetches would clobber in-progress selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mode]);

  // $25 → token units quote for the selected token
  const {
    data: quote,
    isLoading: isQuoteLoading,
    isError: isQuoteError,
    refetch: refetchQuote,
  } = useQuery({
    queryKey: ['apex', 'quote', selectedToken],
    queryFn: () => getApexQuote(selectedToken!),
    enabled: visible && !!selectedToken,
    staleTime: 60_000,
    retry: false,
  });

  // Spaces accepting the selected token. The hook needs a token, so feed
  // it a default pre-selection; the list isn't rendered until one is picked.
  const { data: realEligibleSpaces, isLoading: isSpacesLoading } = useApexEligibleSpaces(
    selectedToken ?? 'wQUIL'
  );

  // DEV-ONLY: while the backend has no apex-configs, the slot picker is a
  // dead end (every token shows "no spaces"). Inject mock spaces so the
  // selection UI and the debug activation below remain exercisable. The
  // mocks carry invalid payout addresses, and the real pay path rejects
  // them explicitly — they can never be paid to.
  const eligibleSpaces = React.useMemo(() => {
    if (__DEV__ && !isSpacesLoading && (realEligibleSpaces ?? []).length === 0) {
      return DEBUG_APEX_SPACES;
    }
    return realEligibleSpaces;
  }, [realEligibleSpaces, isSpacesLoading]);

  // Keep the selection consistent with the visible list — a renew
  // preselection may contain spaces that since dropped Apex (or changed
  // token); they'd otherwise count toward 4/4 with no row to deselect.
  React.useEffect(() => {
    if (!visible || !eligibleSpaces) return;
    setSelectedSpaces((prev) => {
      const next = prev.filter((address) =>
        eligibleSpaces.some((s) => s.spaceAddress === address)
      );
      return next.length === prev.length ? prev : next;
    });
  }, [visible, eligibleSpaces]);

  const handleSelectToken = (token: ApexToken) => {
    if (isPaying || token === selectedToken) return;
    setSelectedToken(token);
    // Eligibility is per-token — a space accepting wQUIL may not accept
    // SNAP — so switching tokens resets the space selection.
    setSelectedSpaces([]);
    setPayError(null);
  };

  // Slot-based selection: each tap assigns one of the four slots to a
  // space, and the SAME space may hold multiple slots — all four going to
  // one space is a fully supported choice (its owner then receives 4/5 of
  // the payment). The minus control on a selected row releases one slot.
  const handleAddSpaceSlot = (spaceAddress: string) => {
    if (isPaying) return;
    setPayError(null);
    setSelectedSpaces((prev) =>
      prev.length >= REQUIRED_SPACES ? prev : [...prev, spaceAddress]
    );
  };

  const handleRemoveSpaceSlot = (spaceAddress: string) => {
    if (isPaying) return;
    setPayError(null);
    setSelectedSpaces((prev) => {
      const index = prev.lastIndexOf(spaceAddress);
      if (index === -1) return prev;
      return [...prev.slice(0, index), ...prev.slice(index + 1)];
    });
  };

  const isReadyToPay =
    splitterDeployed &&
    !!selectedToken &&
    !!quote &&
    selectedSpaces.length === REQUIRED_SPACES &&
    !!activeWallet &&
    !!user?.address;

  const getButtonLabel = () => {
    if (!splitterDeployed) return 'Payments not yet live';
    if (!selectedToken) return 'Select a token';
    if (isQuoteLoading) return 'Fetching price…';
    if (isQuoteError || !quote) return "Couldn't fetch price";
    if (selectedSpaces.length !== REQUIRED_SPACES) {
      return `Assign ${REQUIRED_SPACES} slots (${selectedSpaces.length}/${REQUIRED_SPACES})`;
    }
    if (!activeWallet) return 'No wallet available';
    return `${mode === 'renew' ? 'Renew' : 'Subscribe'} — ${quote.totalDisplay} ${selectedToken}/month`;
  };

  const executePayment = async () => {
    if (!isReadyToPay || isPaying || !selectedToken || !quote) return;

    // Resolve the selected spaces' payout addresses, preserving selection order.
    const chosen = selectedSpaces
      .map((address) => (eligibleSpaces ?? []).find((s) => s.spaceAddress === address))
      .filter((s): s is ApexEligibleSpace => !!s);
    if (chosen.length !== REQUIRED_SPACES) {
      setPayError('One of your selected spaces is no longer available — please reselect.');
      return;
    }
    if (chosen.some((s) => isDebugSpaceAddress(s.spaceAddress))) {
      setPayError(
        'Debug spaces can only be activated with "Skip payment" below — real payments to them are blocked.'
      );
      return;
    }

    setIsPaying(true);
    setPayError(null);

    let txHash: string;
    try {
      const privateKey = await getWalletPrivateKey(activeType, importedWallet, fetchKeys);
      const result = await payApexSubscription({
        privateKey,
        token: selectedToken,
        recipientPayoutAddresses: [
          chosen[0].payoutAddress,
          chosen[1].payoutAddress,
          chosen[2].payoutAddress,
          chosen[3].payoutAddress,
        ],
        amountEachUnits: quote.amountEachUnits,
        quorumAddress: user!.address,
      });
      txHash = result.txHash;
    } catch (error) {
      setIsPaying(false);
      setPayError(getErrorMessage(error) || 'Payment failed. Please try again.');
      return;
    }

    // Payment succeeded — register the subscription. A failure here must
    // NOT be swallowed: the user paid, so surface the tx hash for support.
    try {
      const periodStart = Date.now();
      await getQuorumClient().registerApexSubscription({
        address: user!.address,
        tx_hash: txHash,
        chain_id: APEX_CHAIN_ID,
        token: selectedToken,
        amount_each: quote.amountEachUnits.toString(),
        space_addresses: selectedSpaces,
        period_start: periodStart,
        period_end: periodStart + PERIOD_MS,
      });
    } catch (error) {
      setIsPaying(false);
      Alert.alert(
        'Payment sent, registration failed',
        `Your payment went through but we couldn't register your Apex subscription. ` +
          `Please contact support with this transaction hash:\n\n${txHash}\n\n` +
          `(${getErrorMessage(error) || 'registration request failed'})`
      );
      return;
    }

    queryClient.invalidateQueries({ queryKey: ['apex', 'subscription'] });
    setIsPaying(false);
    // Close modal first so the toast is visible (Modal renders in a
    // separate view hierarchy above root toasts).
    onClose();
    showToast({
      type: 'success',
      title: mode === 'renew' ? 'Apex renewed' : 'Welcome to Apex ✨',
      message:
        mode === 'renew'
          ? 'Your subscription and supported spaces are updated.'
          : 'Your gold ring is live and your 4 spaces are getting paid.',
      txHash,
    });
  };

  // DEV-ONLY: activate (or clear) a local fake subscription without paying
  // or touching the server — for walking the full Apex UX on the simulator.
  const debugActivate = (expired: boolean) => {
    if (!__DEV__ || !user?.address) return;
    const token = selectedToken ?? 'USDC';
    // Use the chosen slots; pad to 4 with debug spaces so a partial (or
    // empty) selection still activates.
    const spaceAddresses = [...selectedSpaces];
    let mockIndex = 0;
    while (spaceAddresses.length < REQUIRED_SPACES) {
      spaceAddresses.push(DEBUG_APEX_SPACES[mockIndex % DEBUG_APEX_SPACES.length].spaceAddress);
      mockIndex += 1;
    }
    setDebugApexSubscription({
      address: user.address,
      token,
      spaceAddresses,
      expired,
    });
    queryClient.invalidateQueries({ queryKey: ['apex', 'subscription'] });
    onClose();
    showToast({
      type: 'success',
      title: expired ? 'Debug: expired subscription set' : 'Debug: Apex activated',
      message: 'Local only — no payment, no server registration.',
    });
  };

  const debugClear = () => {
    if (!__DEV__) return;
    clearDebugApexSubscription();
    queryClient.invalidateQueries({ queryKey: ['apex', 'subscription'] });
    onClose();
    showToast({ type: 'success', title: 'Debug: Apex state cleared' });
  };

  const renderTokenCard = (token: ApexToken) => {
    const isSelected = selectedToken === token;
    const iconUri = getApexTokenIconUri(token);
    return (
      <TouchableOpacity
        key={token}
        style={[styles.tokenCard, isSelected && styles.tokenCardSelected]}
        onPress={() => handleSelectToken(token)}
        disabled={isPaying}
      >
        {iconUri ? (
          <Image source={{ uri: iconUri }} style={styles.tokenIcon} />
        ) : (
          <View style={[styles.tokenIcon, styles.tokenIconPlaceholder]}>
            <Text style={styles.tokenIconPlaceholderText}>{token.charAt(0)}</Text>
          </View>
        )}
        <Text style={[styles.tokenSymbol, isSelected && styles.tokenSymbolSelected]}>{token}</Text>
      </TouchableOpacity>
    );
  };

  const renderSpaceRow = (space: ApexEligibleSpace) => {
    const slotCount = selectedSpaces.filter((a) => a === space.spaceAddress).length;
    const selectionFull = selectedSpaces.length >= REQUIRED_SPACES;
    return (
      <TouchableOpacity
        key={space.spaceAddress}
        style={[styles.spaceRow, slotCount > 0 && styles.spaceRowSelected]}
        onPress={() => handleAddSpaceSlot(space.spaceAddress)}
        disabled={isPaying || selectionFull}
      >
        {space.iconUrl ? (
          <Image source={{ uri: space.iconUrl }} style={styles.spaceIcon} />
        ) : (
          <SpaceIcon name={space.name} size={36} style={styles.spaceIcon} />
        )}
        <View style={styles.spaceInfo}>
          <Text style={styles.spaceName} numberOfLines={1}>
            {space.name || truncateAddress(space.spaceAddress)}
          </Text>
          <Text style={styles.spacePayout} numberOfLines={1}>
            {space.subscriberCount != null
              ? `${space.subscriberCount} subscriber${space.subscriberCount === 1 ? '' : 's'} · `
              : ''}
            Payout: {truncateAddress(space.payoutAddress)}
          </Text>
        </View>
        {slotCount > 0 ? (
          <View style={styles.slotControls}>
            <TouchableOpacity
              onPress={() => handleRemoveSpaceSlot(space.spaceAddress)}
              disabled={isPaying}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={`Remove one slot from ${space.name || 'space'}`}
            >
              <IconSymbol name="minus.circle" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
            <View style={styles.slotCountBadge}>
              <Text style={styles.slotCountText}>×{slotCount}</Text>
            </View>
          </View>
        ) : (
          <IconSymbol
            name="plus.circle"
            size={22}
            color={selectionFull ? theme.colors.textMuted : APEX_GOLD}
          />
        )}
      </TouchableOpacity>
    );
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.85} avoidKeyboard>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <IconSymbol name="crown.fill" size={20} color={APEX_GOLD} />
          <Text style={styles.title}>{mode === 'renew' ? 'Renew Apex' : 'Quorum Apex'}</Text>
        </View>
        <TouchableOpacity onPress={onClose}>
          <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.pitchText}>
          ${APEX_PRICE_USD}/month — support {REQUIRED_SPACES} communities of your choice and get a
          gold ring on your profile.
        </Text>
        {mode === 'renew' && (
          <Text style={styles.renewHint}>Renewing lets you choose new spaces.</Text>
        )}

        {/* Step 1: Token */}
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Pay with</Text>
          <View style={styles.tokenCardsRow}>{TOKEN_ORDER.map(renderTokenCard)}</View>

          {selectedToken && (
            <View style={styles.quoteBox}>
              {isQuoteLoading ? (
                <View style={styles.quoteLoadingRow}>
                  <ActivityIndicator size="small" color={theme.colors.textMuted} />
                  <Text style={styles.quoteMuted}>Fetching price…</Text>
                </View>
              ) : isQuoteError || !quote ? (
                <TouchableOpacity onPress={() => refetchQuote()}>
                  <Text style={styles.quoteError}>Couldn't fetch price — tap to retry</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <Text style={styles.quoteMain}>
                    ${APEX_PRICE_USD} ≈ {quote.totalDisplay} {selectedToken}
                  </Text>
                  <Text style={styles.quoteMuted}>
                    each space owner receives {quote.amountEachDisplay} {selectedToken}
                  </Text>
                </>
              )}
            </View>
          )}
        </View>

        {/* Step 2: Spaces */}
        {selectedToken && (
          <View style={styles.inputGroup}>
            <View style={styles.spacesLabelRow}>
              <Text style={styles.inputLabel}>Assign your {REQUIRED_SPACES} slots</Text>
              <Text
                style={[
                  styles.selectionCount,
                  selectedSpaces.length === REQUIRED_SPACES && styles.selectionCountComplete,
                ]}
              >
                {selectedSpaces.length}/{REQUIRED_SPACES} assigned
              </Text>
            </View>
            <Text style={styles.slotsHint}>
              Tap a space to give it a slot — the same space can hold more than one, even all
              four.
            </Text>

            {isSpacesLoading ? (
              <View style={styles.spacesLoading}>
                <ActivityIndicator size="small" color={theme.colors.textMuted} />
              </View>
            ) : (eligibleSpaces ?? []).length === 0 ? (
              <Text style={styles.emptySpacesText}>
                No spaces accept {selectedToken} yet — space owners can enable Apex in their space
                settings.
              </Text>
            ) : (
              <>
                {__DEV__ && eligibleSpaces === DEBUG_APEX_SPACES && (
                  <Text style={styles.debugHint}>
                    Showing debug spaces — no real space published an Apex config accepting{' '}
                    {selectedToken} (or the server isn't reachable).
                  </Text>
                )}
                {(eligibleSpaces ?? []).map(renderSpaceRow)}
              </>
            )}
          </View>
        )}

        {/* Step 3: Wallet (Ethereum mainnet only) */}
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Wallet</Text>
          <WalletSelector hideIfSingle={false} />
          <Text style={styles.chainHint}>Payment is on Ethereum mainnet.</Text>
        </View>

        {payError && <Text style={styles.payErrorText}>{payError}</Text>}

        {/* Step 4: Pay */}
        {isPaying ? (
          <View style={styles.payButton}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.payButton, !isReadyToPay && styles.payButtonDisabled]}
            onPress={executePayment}
            disabled={!isReadyToPay}
          >
            <Text style={styles.payButtonText}>{getButtonLabel()}</Text>
          </TouchableOpacity>
        )}

        {/* DEV-ONLY debug panel — never rendered in release builds. */}
        {__DEV__ && (
          <View style={styles.debugBox}>
            <Text style={styles.debugTitle}>Debug (dev builds only)</Text>
            <Text style={styles.debugHint}>
              Walk the Apex flow without paying. Empty slot picks are padded
              with debug spaces; state is local-only.
            </Text>
            <View style={styles.debugButtonRow}>
              <TouchableOpacity style={styles.debugButton} onPress={() => debugActivate(false)}>
                <Text style={styles.debugButtonText}>Skip payment & activate</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.debugButton} onPress={() => debugActivate(true)}>
                <Text style={styles.debugButtonText}>Set expired</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.debugButton} onPress={debugClear}>
                <Text style={styles.debugButtonText}>Clear</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(16),
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    title: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    content: {
      flex: 1,
      paddingHorizontal: Skin.space(20),
    },
    pitchText: {
      fontSize: Skin.font(13),
      lineHeight: Skin.font(18),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
    },
    debugBox: {
      marginTop: Skin.space(16),
      marginBottom: Skin.space(24),
      padding: Skin.space(12),
      borderRadius: Skin.radius(10),
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: theme.colors.warning,
    },
    debugTitle: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.warning,
      marginBottom: Skin.space(4),
    },
    debugHint: {
      fontSize: Skin.font(11),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
    },
    debugButtonRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(8),
    },
    debugButton: {
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(10),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.warning,
    },
    debugButtonText: {
      fontSize: Skin.font(12),
      color: theme.colors.warning,
    },
    renewHint: {
      fontSize: Skin.font(13),
      color: APEX_GOLD,
      marginBottom: Skin.space(8),
    },
    inputGroup: {
      marginTop: Skin.space(12),
      marginBottom: Skin.space(8),
    },
    inputLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    tokenCardsRow: {
      flexDirection: 'row',
      gap: Skin.space(10),
    },
    tokenCard: {
      flex: 1,
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(14),
      gap: Skin.space(8),
      borderWidth: Skin.border(1),
      borderColor: 'transparent',
    },
    tokenCardSelected: {
      borderColor: APEX_GOLD,
      backgroundColor: APEX_GOLD + '15',
    },
    tokenIcon: {
      width: 32,
      height: 32,
      borderRadius: Skin.radius(16),
    },
    tokenIconPlaceholder: {
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tokenIconPlaceholderText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMuted,
    },
    tokenSymbol: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    tokenSymbolSelected: {
      color: APEX_GOLD,
    },
    quoteBox: {
      marginTop: Skin.space(10),
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      gap: Skin.space(2),
    },
    quoteLoadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    quoteMain: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    quoteMuted: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
    },
    quoteError: {
      fontSize: Skin.font(13),
      color: theme.colors.danger,
    },
    spacesLabelRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    selectionCount: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
    },
    selectionCountComplete: {
      color: APEX_GOLD,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    spacesLoading: {
      paddingVertical: Skin.space(16),
      alignItems: 'center',
    },
    emptySpacesText: {
      fontSize: Skin.font(13),
      lineHeight: Skin.font(18),
      color: theme.colors.textMuted,
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(14),
    },
    spaceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      marginBottom: Skin.space(8),
      gap: Skin.space(12),
      borderWidth: Skin.border(1),
      borderColor: 'transparent',
    },
    spaceRowSelected: {
      borderColor: APEX_GOLD,
    },
    spaceIcon: {
      width: 36,
      height: 36,
      borderRadius: Skin.radius(8),
    },
    spaceInfo: {
      flex: 1,
      gap: Skin.space(2),
    },
    spaceName: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    spacePayout: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
    },
    slotsHint: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
    },
    slotControls: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    slotCountBadge: {
      minWidth: 30,
      paddingHorizontal: Skin.space(6),
      paddingVertical: Skin.space(2),
      borderRadius: Skin.radius(10),
      backgroundColor: APEX_GOLD + '26',
      alignItems: 'center',
    },
    slotCountText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: APEX_GOLD,
    },
    chainHint: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
    },
    payErrorText: {
      fontSize: Skin.font(13),
      color: theme.colors.danger,
      marginTop: Skin.space(8),
    },
    payButton: {
      backgroundColor: APEX_GOLD,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: Skin.space(12),
      marginBottom: Skin.space(24),
      minHeight: 56,
    },
    payButtonDisabled: {
      opacity: 0.5,
    },
    payButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#1A1505',
    },
  });
