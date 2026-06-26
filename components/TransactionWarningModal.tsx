import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { BaseModal } from '@/components/shared';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

type WarningType = 'simulation-failed' | 'no-entitlements' | 'not-declared' | 'ok';
type WarningSeverity = 'low' | 'medium' | 'high';

interface WarningConfig {
  icon: IconSymbolName;
  iconColor: string;
  title: string;
  message: string;
  severity: WarningSeverity;
}

interface TransactionWarningModalProps {
  visible: boolean;
  onClose: () => void;
  onProceed: () => void;
  warningType: WarningType;
  transactionData?: {
    to: string;
    value: string;
    gas: string;
    function: string;
  };
}

export default function TransactionWarningModal({
  visible,
  onClose,
  onProceed,
  warningType,
  transactionData = {
    to: '0x1234...5678',
    value: '0.1 ETH',
    gas: '21,000',
    function: 'transfer()',
  }
}: TransactionWarningModalProps) {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const getWarningConfig = (type: WarningType): WarningConfig => {
    switch (type) {
      case 'simulation-failed':
        return {
          icon: 'exclamationmark.triangle.fill',
          iconColor: theme.colors.danger,
          title: 'Simulation Failed',
          message: 'This transaction could not be simulated, proceed with caution',
          severity: 'high' as const,
        };
      case 'no-entitlements':
        return {
          icon: 'exclamationmark.triangle.fill',
          iconColor: theme.colors.warning,
          title: 'Confirm Transaction',
          message: 'This mini app does not use entitlements, please review this simulation',
          severity: 'medium' as const,
        };
      case 'not-declared':
        return {
          icon: 'shield.lefthalf.filled.trianglebadge.exclamationmark',
          iconColor: theme.colors.danger,
          title: 'No Declared Entitlement',
          message: 'This transaction is not declared in the mini app\'s entitlements – execute at your own risk',
          severity: 'high' as const,
        };
      default:
        return {
          icon: 'info.circle.fill',
          iconColor: theme.colors.info,
          title: 'Confirm Transaction',
          message: '',
          severity: 'medium' as const,
        };
    }
  };

  const warningConfig = getWarningConfig(warningType);
  const styles = createStyles(theme, isDark, insets, warningConfig.severity);

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      height={0.85}
      backdropDarkness={0.6}
    >
      {/* Warning Header */}
      <View style={styles.warningHeader}>
        <View style={styles.warningIconContainer}>
          <IconSymbol
            name={warningConfig.icon}
            size={32}
            color={warningConfig.iconColor}
          />
        </View>
        <Text style={styles.warningTitle}>{warningConfig.title}</Text>
        <Text style={styles.warningMessage}>{warningConfig.message}</Text>
      </View>

      {/* Transaction Details */}
      {warningType !== 'simulation-failed' && (<>
      <View style={styles.transactionSection}>
        <Text style={styles.sectionTitle}>Transaction Details</Text>
        <View style={styles.transactionCard}>
          <View style={styles.transactionRow}>
            <Text style={styles.transactionLabel}>To</Text>
            <Text style={styles.transactionValue}>{transactionData.to}</Text>
          </View>
          <View style={styles.transactionRow}>
            <Text style={styles.transactionLabel}>Value</Text>
            <Text style={styles.transactionValue}>{transactionData.value}</Text>
          </View>
          <View style={styles.transactionRow}>
            <Text style={styles.transactionLabel}>Gas</Text>
            <Text style={styles.transactionValue}>{transactionData.gas}</Text>
          </View>
          <View style={styles.transactionRow}>
            <Text style={styles.transactionLabel}>Function</Text>
            <Text style={styles.transactionValue}>{transactionData.function}</Text>
          </View>
        </View>
      </View>

        {/* Simulation Results */}
        <View style={styles.simulationSection}>
          <Text style={styles.sectionTitle}>Simulation Results</Text>
          <View style={styles.simulationCard}>
            <View style={styles.simulationResult}>
              <IconSymbol name="checkmark.circle.fill" size={16} color={theme.colors.success} />
              <Text style={styles.simulationText}>Transaction will likely succeed</Text>
            </View>
            <View style={styles.simulationResult}>
              <IconSymbol name="info.circle.fill" size={16} color={theme.colors.info} />
              <Text style={styles.simulationText}>Estimated gas usage: {transactionData.gas}</Text>
            </View>
            {warningType === 'not-declared' && (
              <View style={styles.simulationResult}>
                <IconSymbol name="exclamationmark.triangle.fill" size={16} color={theme.colors.warning} />
                <Text style={styles.simulationText}>No security guarantees provided</Text>
              </View>
            )}
          </View>
        </View>
        </>)}

      {/* Action Buttons */}
      <View style={styles.buttonContainer}>
        <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.proceedButton} onPress={onProceed}>
          <Text style={styles.proceedButtonText}>
            {warningConfig.severity === 'high' ? 'Proceed Anyway' : 'Continue'}
          </Text>
        </TouchableOpacity>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets, severity: 'low' | 'medium' | 'high') =>
  StyleSheet.create({
    warningHeader: {
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingVertical: Skin.space(20),
    },
    warningIconContainer: {
      marginBottom: Skin.space(16),
    },
    warningTitle: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(8),
      textAlign: 'center',
    },
    warningMessage: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      textAlign: 'center',
      lineHeight: Skin.font(20),
      paddingHorizontal: Skin.space(20),
    },
    transactionSection: {
      paddingHorizontal: Skin.space(20),
      marginBottom: Skin.space(20),
    },
    sectionTitle: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(12),
    },
    transactionCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    transactionRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(8),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.border,
    },
    transactionLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    transactionValue: {
      fontSize: Skin.font(11),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      textAlign: 'right',
      flex: 1,
      marginLeft: Skin.space(16),
    },
    simulationSection: {
      paddingHorizontal: Skin.space(20),
      marginBottom: Skin.space(20),
    },
    simulationCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    simulationResult: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: Skin.space(12),
    },
    simulationText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      marginLeft: Skin.space(8),
      fontFamily: theme.fonts.regular.fontFamily,
    },
    buttonContainer: {
      flexDirection: 'row',
      paddingHorizontal: Skin.space(20),
      paddingBottom: insets.bottom + 16,
      gap: Skin.space(12),
    },
    cancelButton: {
      flex: 1,
      backgroundColor: theme.colors.bgButtonSubtle,
      paddingVertical: Skin.space(16),
      borderRadius: Skin.radius(12),
      alignItems: 'center',
    },
    cancelButtonText: {
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    proceedButton: {
      flex: 1,
      backgroundColor: severity === 'high' ? theme.colors.danger : theme.colors.primary,
      paddingVertical: Skin.space(16),
      borderRadius: Skin.radius(12),
      alignItems: 'center',
    },
    proceedButtonText: {
      fontSize: Skin.font(16),
      color: '#ffffff',
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
  });
