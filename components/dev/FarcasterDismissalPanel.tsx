/**
 * FarcasterDismissalPanel — dev-build-only instrument for the Farcaster
 * notification dismissal watermark.
 *
 * WHY THIS EXISTS. Farcaster rows cannot be cleared server-side, so "Clear
 * Farcaster" moves a local watermark and hides everything at or below it. The
 * only test that actually proves that works is: clear, wait out a full 60s poll
 * cycle, confirm the rows do not come back. Run by hand that test is
 * destructive and single-shot — it spends the operator's accumulated
 * notifications, which on a one-test-account setup are a scarce fixture needed
 * for other work.
 *
 * It does not have to be destructive. The rows are a REMOTE feed that cannot be
 * deleted, so clearing loses nothing: resetting the watermark brings everything
 * back on the next poll. This panel exposes that reset, which turns a one-shot
 * destructive check into a repeatable loop:
 *
 *     clear → wait 60s → confirm still gone → Reset → all rows return
 *
 * It also shows the watermark value and the live suppressed count, so the
 * mechanism is OBSERVED rather than inferred. If rows vanish while "hiding"
 * reads 0, something other than dismissal hid them — which is exactly the kind
 * of false pass a bare "did the rows disappear?" eyeball test would sail past.
 *
 * Only ever mounted from a `__DEV__` gate at the call site (see the
 * notifications tab); there is no separate internal gate here, matching
 * DmBurstSheet.
 */

import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import type { AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import {
  resetFarcasterDismissal,
  useFarcasterClearedBefore,
} from '@/services/notifications/farcasterDismissal';

interface FarcasterDismissalPanelProps {
  theme: AppTheme;
  /** Farcaster rows currently suppressed by the watermark. */
  dismissedCount: number;
}

export function FarcasterDismissalPanel({
  theme,
  dismissedCount,
}: FarcasterDismissalPanelProps) {
  const clearedBefore = useFarcasterClearedBefore();
  const styles = React.useMemo(() => createStyles(theme), [theme]);

  const handleReset = useCallback(() => {
    // No confirm: this is the UNDO direction. It only ever restores rows, and
    // it is dev-only.
    resetFarcasterDismissal();
  }, []);

  const stamp = clearedBefore
    ? new Date(clearedBefore).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'never';

  return (
    <View style={styles.row}>
      <View style={styles.textCol}>
        <Text style={styles.label}>
          dev · farcaster dismissal
        </Text>
        <Text style={styles.value}>
          cleared: {stamp} · hiding {dismissedCount}
        </Text>
      </View>
      {clearedBefore > 0 && (
        <TouchableOpacity onPress={handleReset} hitSlop={8} style={styles.button}>
          <Text style={styles.buttonLabel}>Reset</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: Skin.space(12),
      marginHorizontal: Skin.space(12),
      marginBottom: Skin.space(8),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface3,
    },
    textCol: {
      flex: 1,
      gap: Skin.space(2),
    },
    label: {
      fontSize: Skin.font(10),
      fontWeight: '700',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      color: theme.colors.textSubtle,
    },
    value: {
      fontSize: Skin.font(13),
      color: theme.colors.textMain,
      fontVariant: ['tabular-nums'],
    },
    button: {
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(6),
      backgroundColor: theme.colors.surface1,
    },
    buttonLabel: {
      fontSize: Skin.font(13),
      fontWeight: '600',
      color: theme.colors.primary,
    },
  });
