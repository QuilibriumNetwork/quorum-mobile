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
 * The watermark half does not have to be destructive. Feed rows (likes, follows,
 * mentions) are a REMOTE feed that cannot be deleted, so hiding them loses
 * nothing: resetting the watermark brings them back. This panel exposes that
 * reset, which turns a one-shot check into a repeatable loop:
 *
 *     clear → pull to refresh → confirm still gone → Reset → feed rows return
 *
 * ⚠️ SCOPE OF THE UNDO — read before trusting it. Reset restores ONLY the rows
 * the watermark hid. "Clear Farcaster" ALSO calls
 * `clearNotificationLogByOrigin('farcaster')`, which DELETES the Farcaster
 * direct-cast ping rows from the local notification log. Those are local
 * entries, not feed items, and Reset cannot bring them back.
 *
 * So a clear/reset cycle is lossless for feed rows and lossy for direct-cast
 * pings. Do not describe this panel as making "Clear Farcaster" reversible —
 * it makes the watermark reversible. (Learned the hard way on 2026-08-05: the
 * distinction was missed, the operator was told the action was safe to test,
 * and their ping rows were destroyed.)
 *
 * It also shows the watermark value and the live suppressed count, so the
 * mechanism is OBSERVED rather than inferred. If rows vanish while "hiding"
 * reads 0, something other than dismissal hid them — which is exactly the kind
 * of false pass a bare "did the rows disappear?" eyeball test would sail past.
 *
 * THE "FC CHECK" ROW serves the same purpose for the background direct-cast
 * check, which in production only ever runs from the OS background task on a
 * 15-minute floor. Testing the rows it raises would otherwise mean backgrounding
 * the app and waiting for the OS to feel like scheduling it — slow, and
 * unrepeatable, because the first run advances the watermark past everything.
 * "Run" invokes the check directly; "−1h" rewinds the watermark so the same
 * conversations count as new again. Both are lossless: pings are keyed per
 * conversation, so a re-run refreshes existing rows rather than duplicating
 * them. The result line reports whether the run raised per-conversation pings
 * or tripped the cap into a digest — the two look different on screen, and
 * guessing which one you got is how a cap bug hides.
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
import {
  restoreNotificationSnapshot,
  useNotificationSnapshot,
} from '@/services/dev/notificationSnapshot';
import {
  checkFarcasterDirectCasts,
  getFarcasterCheckWatermark,
  rewindFarcasterCheckWatermark,
} from '@/services/notifications/BackgroundMessageService';

/** How far back a rewind moves the Farcaster watermark. An hour is usually
 *  under the per-conversation ping cap, so a rewind-then-run produces the
 *  tappable per-conversation rows rather than the digest. Rewind twice to go
 *  back further and deliberately trip the cap. */
const REWIND_MS = 60 * 60 * 1000;

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
  const snapshot = useNotificationSnapshot();
  const styles = React.useMemo(() => createStyles(theme), [theme]);
  const [checkState, setCheckState] = React.useState<
    { running: boolean; label: string }
  >({ running: false, label: 'not run yet — tap Run' });
  // Not reactive (plain MMKV, no subscription) — bumped by hand after each
  // action so the displayed watermark can't silently lag what was written.
  const [watermark, setWatermark] = React.useState<number>(() =>
    getFarcasterCheckWatermark(),
  );

  /**
   * Say what happened at every stage, not just the outcome. Each stage can be
   * zero for a completely different reason, and collapsing them into one number
   * is what made the first version of this panel useless: "nothing appeared"
   * could equally mean no token, an empty fetch, nothing new since the
   * watermark, or pings raised and then silently suppressed by the global
   * notification toggle.
   */
  const describe = (r: Awaited<ReturnType<typeof checkFarcasterDirectCasts>>): string => {
    if (!r.success) return `FAILED — ${r.error ?? 'unknown error'}`;
    if (!r.hasToken) return 'no Farcaster token stored — nothing to check';
    if (r.conversationsFetched === 0) {
      return 'fetched 0 conversations (note: inbox only, not requests)';
    }
    const seen = `fetched ${r.conversationsFetched}`;
    if (r.newMessageCount === 0) {
      return `${seen} · none newer than the marker — tap −1h, then Run`;
    }
    const kind = r.digest
      ? `over the cap → 1 digest row for ${r.newMessageCount}`
      : `${r.newMessageCount} new → ${r.newMessageCount} row${r.newMessageCount === 1 ? '' : 's'}`;
    // The line that matters. Decided-but-not-delivered means the notification
    // was suppressed downstream, and no amount of staring at the list would
    // have explained why.
    if (r.delivered === 0) {
      return `${seen} · ${kind} · SUPPRESSED — check global notifications / mute`;
    }
    return `${seen} · ${kind} · ${r.delivered} delivered`;
  };

  const handleRunCheck = useCallback(async () => {
    setCheckState({ running: true, label: 'running…' });
    const result = await checkFarcasterDirectCasts();
    setWatermark(getFarcasterCheckWatermark());
    setCheckState({ running: false, label: describe(result) });
  }, []);

  const handleRewind = useCallback(() => {
    rewindFarcasterCheckWatermark(REWIND_MS);
    setWatermark(getFarcasterCheckWatermark());
    setCheckState({ running: false, label: 'rewound — run again' });
  }, []);

  const handleReset = useCallback(() => {
    // No confirm on either action: both are the UNDO direction. They only ever
    // restore rows, and this is dev-only.
    resetFarcasterDismissal();
  }, []);

  const handleRestore = useCallback(() => {
    restoreNotificationSnapshot();
  }, []);

  const time = (ts: number) =>
    new Date(ts).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  return (
    <View style={styles.panel}>
      <Text style={styles.label}>dev · notifications</Text>

      <View style={styles.row}>
        <Text style={styles.value}>
          watermark: {clearedBefore ? time(clearedBefore) : 'never'} · hiding {dismissedCount}
        </Text>
        {clearedBefore > 0 && (
          <TouchableOpacity onPress={handleReset} hitSlop={8} style={styles.button}>
            <Text style={styles.buttonLabel}>Reset</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.row}>
        <Text style={styles.value}>
          {snapshot
            ? `snapshot: ${time(snapshot.takenAt)} · ${snapshot.mentionCount} mentions, ${snapshot.pingCount} pings`
            : 'snapshot: none (taken automatically on clear)'}
        </Text>
        {!!snapshot && (
          <TouchableOpacity onPress={handleRestore} hitSlop={8} style={styles.button}>
            <Text style={styles.buttonLabel}>Restore</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Simulates the OS background wake-up that raises the "you have new
          Farcaster messages" rows. Run = wake up now. −1h = wind the
          already-seen marker back an hour so the same messages count as new
          again (cumulative — each tap goes back another hour). */}
      <View style={styles.row}>
        <Text style={styles.value}>
          fc wake-up · already seen up to{' '}
          {watermark ? time(watermark) : 'never (everything counts as new)'}
        </Text>
        <TouchableOpacity onPress={handleRewind} hitSlop={8} style={styles.button}>
          <Text style={styles.buttonLabel}>−1h</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleRunCheck}
          hitSlop={8}
          style={styles.button}
          disabled={checkState.running}
        >
          <Text style={styles.buttonLabel}>Run</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.report}>{checkState.label}</Text>
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    panel: {
      gap: Skin.space(6),
      marginHorizontal: Skin.space(12),
      marginBottom: Skin.space(8),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(10),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface3,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: Skin.space(12),
    },
    label: {
      fontSize: Skin.font(10),
      fontWeight: '700',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      color: theme.colors.textSubtle,
    },
    value: {
      flex: 1,
      fontSize: Skin.font(13),
      color: theme.colors.textMain,
      fontVariant: ['tabular-nums'],
    },
    // Full-width so a multi-clause report isn't squeezed next to the buttons
    // and truncated — the stage it truncates is invariably the one you needed.
    report: {
      fontSize: Skin.font(13),
      lineHeight: Skin.font(18),
      color: theme.colors.textMain,
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
