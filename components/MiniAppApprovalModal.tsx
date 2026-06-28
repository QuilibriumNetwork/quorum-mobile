/**
 * MiniAppApprovalModal - Approval UI for mini app wallet requests
 *
 * Displays transaction and message signing requests for user approval.
 *
 * SECURITY: This modal only handles user approval. The actual signing is
 * performed in the parent component's resolve callback via SecureSigningService.
 * Private keys are never passed to or handled by this modal.
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { Button } from '@/components/ui/Button';
import WalletSelector from '@/components/wallet/WalletSelector';
import { useTheme, type AppTheme } from '@/theme';
import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  TransactionForApproval,
  MessageForApproval,
  TypedDataForApproval,
  formatTransactionForDisplay,
  EthereumProviderService,
} from '@/services/miniapp/ethereumProvider';
import type { TxSimulationResult } from '@/services/miniapp/txSimulationService';
import { formatEther } from 'viem';
import * as Skin from '@/theme/skins/geometry';

// Request types
export type ApprovalRequestType = 'transaction' | 'message' | 'typedData';

export interface ApprovalRequest {
  type: ApprovalRequestType;
  transaction?: TransactionForApproval;
  message?: MessageForApproval;
  typedData?: TypedDataForApproval;
  appName?: string;
  appIcon?: string;
  /**
   * Pre-sign simulation result for transaction requests. `undefined` while
   * the simulation is still running; the modal shows a "Checking…" row
   * until it resolves. Only `will-revert` / `insufficient-funds` surface a
   * danger banner — `ok`/`unknown` render nothing.
   */
  simulation?: TxSimulationResult;
  /**
   * Called with user's approval decision.
   * The callback may be async (e.g., to perform signing after approval).
   */
  resolve: (approved: boolean) => void | Promise<void>;
}

interface MiniAppApprovalModalProps {
  visible: boolean;
  request: ApprovalRequest | null;
  onClose: () => void;
}

export default function MiniAppApprovalModal({
  visible,
  request,
  onClose,
}: MiniAppApprovalModalProps) {
  const { theme, isDark } = useTheme();
  const [isProcessing, setIsProcessing] = React.useState(false);

  const styles = createStyles(theme, isDark);

  const handleApprove = async () => {
    if (!request) return;
    setIsProcessing(true);
    try {
      // Await the resolve in case it performs async signing
      await request.resolve(true);
    } finally {
      setIsProcessing(false);
      onClose();
    }
  };

  const handleReject = () => {
    if (!request) return;
    request.resolve(false);
    onClose();
  };

  if (!request) return null;

  const renderTransactionDetails = () => {
    if (!request.transaction) return null;
    const tx = request.transaction;
    const formatted = formatTransactionForDisplay(tx);

    return (
      <View style={styles.detailsContainer}>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Network</Text>
          <View style={styles.chainBadge}>
            <Text style={styles.chainBadgeText}>{formatted.chainName}</Text>
          </View>
        </View>

        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>To</Text>
          <Text style={styles.detailValue} numberOfLines={1}>
            {tx.to ? `${tx.to.slice(0, 10)}...${tx.to.slice(-8)}` : 'Contract Creation'}
          </Text>
        </View>

        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Value</Text>
          <Text style={styles.detailValueHighlight}>{formatted.value}</Text>
        </View>

        {tx.data && tx.data !== '0x' && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Data</Text>
            <Text style={styles.detailValue} numberOfLines={1}>
              {tx.data.length > 20 ? `${tx.data.slice(0, 20)}...` : tx.data}
            </Text>
          </View>
        )}

        {tx.gas && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Gas Limit</Text>
            <Text style={styles.detailValue}>{tx.gas.toString()}</Text>
          </View>
        )}
      </View>
    );
  };

  const renderMessageDetails = () => {
    if (!request.message) return null;
    const msg = request.message;

    return (
      <View style={styles.detailsContainer}>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Account</Text>
          <Text style={styles.detailValue} numberOfLines={1}>
            {`${msg.account.slice(0, 10)}...${msg.account.slice(-8)}`}
          </Text>
        </View>

        <View style={styles.messageContainer}>
          <Text style={styles.detailLabel}>Message</Text>
          <ScrollView style={styles.messageScroll} nestedScrollEnabled>
            <Text style={styles.messageText}>{msg.message}</Text>
          </ScrollView>
        </View>
      </View>
    );
  };

  const renderTypedDataDetails = () => {
    if (!request.typedData) return null;
    const data = request.typedData;

    return (
      <View style={styles.detailsContainer}>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Account</Text>
          <Text style={styles.detailValue} numberOfLines={1}>
            {`${data.account.slice(0, 10)}...${data.account.slice(-8)}`}
          </Text>
        </View>

        {data.domain && 'name' in data.domain && data.domain.name != null && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Domain</Text>
            <Text style={styles.detailValue}>{String(data.domain.name)}</Text>
          </View>
        )}

        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Type</Text>
          <Text style={styles.detailValue}>{data.primaryType}</Text>
        </View>

        <View style={styles.messageContainer}>
          <Text style={styles.detailLabel}>Data</Text>
          <ScrollView style={styles.messageScroll} nestedScrollEnabled>
            <Text style={styles.messageText}>
              {JSON.stringify(data.message, null, 2)}
            </Text>
          </ScrollView>
        </View>
      </View>
    );
  };

  const getTitle = () => {
    switch (request.type) {
      case 'transaction':
        return 'Confirm Transaction';
      case 'message':
        return 'Sign Message';
      case 'typedData':
        return 'Sign Typed Data';
      default:
        return 'Approve Request';
    }
  };

  const getIcon = () => {
    switch (request.type) {
      case 'transaction':
        return 'arrow.up.right.circle.fill';
      case 'message':
      case 'typedData':
        return 'signature';
      default:
        return 'checkmark.circle.fill';
    }
  };

  const renderSimulation = () => {
    if (request.type !== 'transaction') return null;
    const sim = request.simulation;

    // Still simulating.
    if (sim === undefined) {
      return (
        <View style={styles.simCheckingRow}>
          <ActivityIndicator size="small" color={theme.colors.textMuted} />
          <Text style={styles.simCheckingText}>Checking transaction…</Text>
        </View>
      );
    }

    // Only the failure states get a banner; ok/unknown stay quiet.
    if (sim.status !== 'will-revert' && sim.status !== 'insufficient-funds') {
      return null;
    }

    return (
      <View style={styles.simDangerContainer}>
        <IconSymbol name="exclamationmark.triangle.fill" size={16} color="#EF4444" />
        <Text style={styles.simDangerText}>
          {sim.warning ?? 'This transaction is likely to fail.'}
        </Text>
      </View>
    );
  };

  const getWarningText = () => {
    switch (request.type) {
      case 'transaction':
        return 'This will send a transaction from your wallet. Make sure you trust this app.';
      case 'message':
      case 'typedData':
        return 'This app is requesting your signature. Only sign messages from apps you trust.';
      default:
        return '';
    }
  };

  return (
    <BaseModal visible={visible} onClose={handleReject} height={0.75}>
      <View style={styles.container}>
        <ScrollView
          style={styles.scrollContainer}
          showsVerticalScrollIndicator={true}
          contentContainerStyle={styles.scrollContent}
        >
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.iconContainer}>
              <IconSymbol
                name={getIcon() as IconSymbolName}
                size={32}
                color={request.type === 'transaction' ? '#F59E0B' : theme.colors.primary}
              />
            </View>
            <Text style={styles.title}>{getTitle()}</Text>
            {request.appName && (
              <Text style={styles.appName}>{request.appName}</Text>
            )}
          </View>

          {/* Warning */}
          <View style={styles.warningContainer}>
            <IconSymbol name="exclamationmark.triangle.fill" size={16} color="#F59E0B" />
            <Text style={styles.warningText}>{getWarningText()}</Text>
          </View>

          {/* Pre-sign simulation result (transactions only) */}
          {renderSimulation()}

          {/* Wallet Selector - allows user to choose which wallet to use */}
          <WalletSelector hideIfSingle={false} />

          {/* Details */}
          {request.type === 'transaction' && renderTransactionDetails()}
          {request.type === 'message' && renderMessageDetails()}
          {request.type === 'typedData' && renderTypedDataDetails()}
        </ScrollView>

        {/* Actions - fixed at bottom */}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="lg"
            onPress={handleReject}
            disabled={isProcessing}
            style={styles.button}
          >
            Reject
          </Button>

          <Button
            variant="primary"
            size="lg"
            onPress={handleApprove}
            disabled={isProcessing}
            loading={isProcessing}
            style={styles.button}
          >
            {request.type === 'transaction' ? 'Confirm' : 'Sign'}
          </Button>
        </View>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean) =>
  StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: Skin.space(20),
    },
    header: {
      alignItems: 'center',
      paddingVertical: Skin.space(16),
    },
    iconContainer: {
      width: 64,
      height: 64,
      borderRadius: Skin.radius(32),
      backgroundColor: theme.colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Skin.space(12),
    },
    title: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    appName: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      marginTop: Skin.space(4),
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#F59E0B15',
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      gap: Skin.space(8),
      marginBottom: Skin.space(16),
    },
    warningText: {
      flex: 1,
      fontSize: Skin.font(13),
      color: theme.colors.warning,
      lineHeight: Skin.font(18),
    },
    simCheckingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      marginBottom: Skin.space(16),
    },
    simCheckingText: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
    },
    simDangerContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#EF444415',
      borderRadius: Skin.radius(12),
      borderWidth: 1,
      borderColor: '#EF444440',
      padding: Skin.space(12),
      gap: Skin.space(8),
      marginBottom: Skin.space(16),
    },
    simDangerText: {
      flex: 1,
      fontSize: Skin.font(13),
      color: '#EF4444',
      lineHeight: Skin.font(18),
    },
    scrollContainer: {
      flex: 1,
    },
    scrollContent: {
      paddingBottom: Skin.space(16),
    },
    detailsContainer: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      gap: Skin.space(12),
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    detailLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
    },
    detailValue: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      maxWidth: '60%',
      textAlign: 'right',
    },
    detailValueHighlight: {
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    chainBadge: {
      backgroundColor: theme.colors.primary + '20',
      paddingHorizontal: Skin.space(10),
      paddingVertical: Skin.space(4),
      borderRadius: Skin.radius(12),
    },
    chainBadgeText: {
      fontSize: Skin.font(12),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    messageContainer: {
      gap: Skin.space(8),
    },
    messageScroll: {
      maxHeight: 200,
      backgroundColor: theme.colors.background,
      borderRadius: Skin.radius(8),
      padding: Skin.space(12),
    },
    messageText: {
      fontSize: Skin.font(13),
      color: theme.colors.textMain,
      fontFamily: 'monospace',
      lineHeight: Skin.font(20),
    },
    actions: {
      flexDirection: 'row',
      gap: Skin.space(12),
      paddingVertical: Skin.space(16),
    },
    button: {
      flex: 1,
    },
  });
