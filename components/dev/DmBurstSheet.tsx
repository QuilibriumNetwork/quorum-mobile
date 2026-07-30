/**
 * DmBurstSheet — dev-build-only "DM test burst" control (T2 of the
 * transport-debugging tool suite; see the desktop repo's
 * .agents/tasks/2026-07-29-transport-debug-workflow-and-tooling.md §2).
 *
 * Sends `"<prefix> 1"` … `"<prefix> N"` sequentially, through the SAME send
 * mutation a manually typed message uses (useSendDirectMessage), and writes a
 * per-message send-side record to a JSONL file the operator can pull with adb
 * — replacing a manual round of hand-typing "V 1"…"V 20" with no send-side
 * record at all.
 *
 * Only ever mounted from a `__DEV__` gate at the call site (see
 * app/(tabs)/messages/dm/[id].tsx); there is no separate internal gate here.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { AppTheme } from '@/theme';
import { BaseModal } from '@/components/shared';
import { Button } from '@/components/ui/Button';
import * as Skin from '@/theme/skins/geometry';
import { useSendDirectMessage } from '@/hooks/chat/useSendDirectMessage';
import { useRecipientRegistration, toRecipientInfo } from '@/hooks/chat/useRecipientRegistration';
import { encryptionStateStorage } from '@/services/crypto/encryption-state-storage';
import { getSuggestedBurstPrefix, markBurstPrefixUsed } from '@/services/dev/dmBurstPrefs';
import { isValidBurstPrefix } from '@/services/dev/dmBurstPrefix';
import { createBurstRecorder, type BurstRecorder } from '@/services/dev/dmBurstRecorder';
import { logger } from '@quilibrium/quorum-shared';

const log = logger.scope('[dm-burst]');

const DEFAULT_COUNT = 20;
const DEFAULT_INTERVAL_MS = 2000;
const MIN_COUNT = 1;
const MAX_COUNT = 500;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 300_000;

type RunStatus = 'idle' | 'running' | 'done' | 'cancelled';

interface DmBurstSheetProps {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  recipientAddress: string;
  /** Effective conversation signing setting — mirrors DMChatArea's
   *  `conversationData.isRepudiable` so the burst goes through the exact same
   *  send params a manually typed message would use. */
  isRepudiable?: boolean;
  theme: AppTheme;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function DmBurstSheet({
  visible,
  onClose,
  conversationId,
  recipientAddress,
  isRepudiable,
  theme,
}: DmBurstSheetProps) {
  const styles = createStyles(theme);

  const [prefix, setPrefix] = useState('A');
  const [countText, setCountText] = useState(String(DEFAULT_COUNT));
  const [intervalText, setIntervalText] = useState(String(DEFAULT_INTERVAL_MS));
  const [status, setStatus] = useState<RunStatus>('idle');
  const [sentCount, setSentCount] = useState(0);
  const [requestedCount, setRequestedCount] = useState(DEFAULT_COUNT);
  const [lastError, setLastError] = useState<string | null>(null);
  const [result, setResult] = useState<{ fileName: string; adbCommand: string; sent: number; wallTimeMs: number } | null>(null);

  const cancelRef = useRef(false);

  // Reset to a fresh suggestion + blank result every time the sheet opens, so
  // a previous run's summary never lingers into the next one.
  useEffect(() => {
    if (!visible) return;
    setPrefix(getSuggestedBurstPrefix());
    setCountText(String(DEFAULT_COUNT));
    setIntervalText(String(DEFAULT_INTERVAL_MS));
    setStatus('idle');
    setSentCount(0);
    setLastError(null);
    setResult(null);
    cancelRef.current = false;
  }, [visible]);

  // Live validation: 1-3 letters/digits, trimmed. Recomputed every render so
  // the inline message and the Start button's disabled state always agree —
  // no separate error state to fall out of sync.
  const prefixError = isValidBurstPrefix(prefix)
    ? null
    : 'Prefix must be 1-3 letters or digits (A-Z, 0-9)';

  const sendDirectMessageMutation = useSendDirectMessage();
  const { data: recipientRegistration } = useRecipientRegistration(recipientAddress, {
    enabled: visible,
  });

  // Send exactly one message through the real path: recipientInfo is only
  // supplied when there is no existing session yet, matching
  // DMChatArea.handleSendDirectMessage exactly. hasEncryptionState is read
  // fresh here (not from a hook) because this loop runs across setTimeout
  // ticks outside the render cycle — a stale render-time value would keep
  // re-sending init envelopes after message 1 establishes the session.
  const sendOne = useCallback(
    (text: string) => {
      const hasSession = encryptionStateStorage.hasEncryptionState(conversationId);
      const recipientInfo = !hasSession && recipientRegistration
        ? toRecipientInfo(recipientRegistration) ?? undefined
        : undefined;
      return sendDirectMessageMutation.mutateAsync({
        conversationId,
        recipientAddress,
        text,
        recipientInfo,
        isRepudiable,
        skipSigning: false,
      });
    },
    [conversationId, recipientAddress, recipientRegistration, sendDirectMessageMutation, isRepudiable]
  );

  const handleCancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const handleStart = useCallback(async () => {
    const prefixValue = prefix.trim().toUpperCase();
    // Belt-and-suspenders: Start is already disabled while prefixError is
    // set, but guard here too in case this ever gets called another way.
    if (!isValidBurstPrefix(prefixValue)) return;
    const n = clamp(parseInt(countText, 10), MIN_COUNT, MAX_COUNT);
    const interval = clamp(parseInt(intervalText, 10), MIN_INTERVAL_MS, MAX_INTERVAL_MS);

    cancelRef.current = false;
    setStatus('running');
    setSentCount(0);
    setRequestedCount(n);
    setLastError(null);
    setResult(null);

    // The prefix counts as "used" the moment the run starts — even a
    // cancelled run has already put `<prefix> 1..k` on the wire, so the next
    // suggestion must not collide with it.
    markBurstPrefixUsed(prefixValue);

    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const fileName = `run-${startedAt}.jsonl`;
    let recorder: BurstRecorder;
    try {
      recorder = createBurstRecorder(fileName);
    } catch (err) {
      log.error('failed to open burst record file', err);
      setStatus('idle');
      setLastError(err instanceof Error ? err.message : 'Failed to open record file');
      return;
    }

    let sent = 0;
    for (let seq = 1; seq <= n; seq++) {
      if (cancelRef.current) break;

      const text = `${prefixValue} ${seq}`;
      const tsQueuedIso = new Date().toISOString();
      const t0 = Date.now();
      try {
        const message = await sendOne(text);
        recorder.appendMessage({
          seq,
          text,
          messageId: message.messageId,
          nonce: message.nonce,
          tsQueuedIso,
          tsAfterSendMs: Date.now() - t0,
        });
        sent += 1;
        setSentCount(sent);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`seq ${seq} failed:`, message);
        recorder.appendMessage({
          seq,
          text,
          tsQueuedIso,
          tsAfterSendMs: Date.now() - t0,
          error: message,
        });
        setLastError(message);
      }

      if (seq < n && !cancelRef.current) {
        await delay(interval);
      }
    }

    const wallTimeMs = Date.now() - startedAt;
    recorder.appendSummary({
      prefix: prefixValue,
      requested: n,
      sent,
      intervalMs: interval,
      startedAtIso,
      wallTimeMs,
      cancelled: cancelRef.current,
    });

    const adbCommand = recorder.adbPullCommand();
    log.info(`run complete: ${sent}/${n} sent in ${wallTimeMs}ms — pull with: ${adbCommand}`);

    setStatus(cancelRef.current ? 'cancelled' : 'done');
    setResult({ fileName: recorder.fileName, adbCommand, sent, wallTimeMs });
  }, [prefix, countText, intervalText, sendOne]);

  if (!visible) return null;

  const isRunning = status === 'running';

  return (
    <BaseModal visible={visible} onClose={onClose} showHandle avoidKeyboard scrollable>
      <View style={styles.container}>
        <Text style={styles.title}>DM Test Burst</Text>
        <Text style={styles.subtitle}>
          Sends a numbered burst through the real send path and records a
          send-side timestamp for each message.
        </Text>

        <View style={styles.row}>
          <View style={styles.fieldNarrow}>
            <Text style={styles.label}>Prefix</Text>
            <TextInput
              style={styles.input}
              value={prefix}
              onChangeText={(v) => setPrefix(v.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={12}
              editable={!isRunning}
              accessibilityLabel="Burst message prefix"
              aria-invalid={!!prefixError}
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Count</Text>
            <TextInput
              style={styles.input}
              value={countText}
              onChangeText={setCountText}
              keyboardType="number-pad"
              editable={!isRunning}
              accessibilityLabel="Number of messages to send"
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Interval (ms)</Text>
            <TextInput
              style={styles.input}
              value={intervalText}
              onChangeText={setIntervalText}
              keyboardType="number-pad"
              editable={!isRunning}
              accessibilityLabel="Milliseconds between messages"
            />
          </View>
        </View>

        {prefixError && (
          <Text style={styles.error} accessibilityRole="alert">
            {prefixError}
          </Text>
        )}

        {status !== 'idle' && (
          <Text style={styles.progress}>
            {isRunning
              ? `${sentCount}/${requestedCount} sent…`
              : status === 'cancelled'
                ? `Cancelled — ${sentCount}/${requestedCount} sent`
                : `Done — ${sentCount}/${requestedCount} sent`}
          </Text>
        )}

        {lastError && (
          <Text style={styles.error} accessibilityRole="alert">
            {lastError}
          </Text>
        )}

        {result && (
          <View style={styles.resultBlock}>
            <Text style={styles.resultLabel}>Pull the record with:</Text>
            <Text style={styles.resultCommand} selectable>
              {result.adbCommand}
            </Text>
          </View>
        )}

        <View style={styles.actions}>
          {isRunning ? (
            <Button variant="danger" onPress={handleCancel} fullWidth>
              Cancel
            </Button>
          ) : (
            <Button variant="primary" onPress={handleStart} fullWidth disabled={!!prefixError}>
              Start
            </Button>
          )}
        </View>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(4),
    },
    subtitle: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      lineHeight: Skin.font(18),
      marginBottom: Skin.space(16),
    },
    row: {
      flexDirection: 'row',
      gap: Skin.space(10),
      marginBottom: Skin.space(12),
    },
    fieldNarrow: {
      width: 76,
    },
    field: {
      flex: 1,
    },
    label: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      color: theme.colors.textSubtle,
      marginBottom: Skin.space(4),
    },
    input: {
      borderWidth: Skin.border(1),
      borderColor: theme.colors.border,
      borderRadius: Skin.radius(10),
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(10),
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
    },
    progress: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      color: theme.colors.textMain,
      marginBottom: Skin.space(8),
    },
    error: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.danger,
      marginBottom: Skin.space(8),
    },
    resultBlock: {
      backgroundColor: theme.colors.bgButtonSubtle,
      borderRadius: Skin.radius(10),
      padding: Skin.space(12),
      marginBottom: Skin.space(16),
    },
    resultLabel: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      color: theme.colors.textSubtle,
      marginBottom: Skin.space(4),
    },
    resultCommand: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
    },
    actions: {
      marginTop: Skin.space(4),
    },
  });

export default DmBurstSheet;
