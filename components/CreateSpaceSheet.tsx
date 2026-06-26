/**
 * CreateSpaceSheet — "Start a space" form with start-time presets
 * AND a Custom date/time path so a host can pick any future moment.
 * Wrapped in a ScrollView inside KeyboardAvoidingView so the keyboard
 * pushes content up without occluding the inputs the user is filling.
 *
 * No native date-picker module — we render two formatted text inputs
 * (date / time) plus an AM/PM toggle, which keeps the install
 * footprint zero and the picker available on every platform we ship.
 */

import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAudioSpace } from '@/context/AudioSpaceContext';
import { useToast } from '@/context/ToastContext';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface StartPreset {
  /** Display label. */
  label: string;
  /** Minutes from now; `null` = start immediately,
   *  `'custom'` = use the date/time inputs below. */
  offset: number | null | 'custom';
}

const PRESETS: StartPreset[] = [
  { label: 'Now', offset: null },
  { label: 'In 15 min', offset: 15 },
  { label: 'In 30 min', offset: 30 },
  { label: 'In 1 hour', offset: 60 },
  { label: 'In 2 hours', offset: 120 },
  { label: 'Tomorrow', offset: 60 * 24 },
  { label: 'Custom', offset: 'custom' },
];

/** Strip any non-digit characters; we re-format slashes/colons via
 *  the formatters below so the user can type fast without worrying
 *  about punctuation. */
const onlyDigits = (s: string) => s.replace(/\D/g, '');

/** Format raw digits as `MM/DD/YYYY` as the user types. */
function formatDateInput(raw: string): string {
  const d = onlyDigits(raw).slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

/** Format raw digits as `H:MM` (12-hour). */
function formatTimeInput(raw: string): string {
  const d = onlyDigits(raw).slice(0, 4);
  if (d.length <= 1) return d;
  if (d.length === 2) {
    // Two-digit case: could be a single-digit hour padded ("09") or
    // an hour > 9. Heuristic: if the first digit is 1 we don't know
    // yet — assume `HH`. If first digit is 0, treat as `HH`.
    return d;
  }
  if (d.length === 3) return `${d.slice(0, 1)}:${d.slice(1)}`;
  return `${d.slice(0, 2)}:${d.slice(2)}`;
}

/** Parse a `MM/DD/YYYY` + `H:MM` + `AM|PM` triple into a Date.
 *  Returns `null` on any parse failure or if the result is in the past. */
function parseCustomDateTime(
  dateStr: string,
  timeStr: string,
  ampm: 'AM' | 'PM',
): { date: Date; error: string | null } {
  const dateMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch) return { date: new Date(NaN), error: 'Date format: MM/DD/YYYY' };
  if (!timeMatch) return { date: new Date(NaN), error: 'Time format: H:MM' };
  const month = parseInt(dateMatch[1], 10);
  const day = parseInt(dateMatch[2], 10);
  const year = parseInt(dateMatch[3], 10);
  let hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  if (month < 1 || month > 12) return { date: new Date(NaN), error: 'Invalid month' };
  if (day < 1 || day > 31) return { date: new Date(NaN), error: 'Invalid day' };
  if (hour < 1 || hour > 12) return { date: new Date(NaN), error: 'Hour must be 1–12' };
  if (minute < 0 || minute > 59) return { date: new Date(NaN), error: 'Invalid minute' };
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(d.getTime())) return { date: d, error: 'Invalid date' };
  if (d.getTime() < Date.now()) return { date: d, error: 'Pick a time in the future' };
  return { date: d, error: null };
}

export function CreateSpaceSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { createSpace, join } = useAudioSpace();
  const { showToast } = useToast();
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [presetIdx, setPresetIdx] = React.useState(0);
  // Custom date/time fields — only consumed when the Custom preset is
  // selected. Defaults are seeded once on first selection to a useful
  // round value (next hour).
  const [customDate, setCustomDate] = React.useState('');
  const [customTime, setCustomTime] = React.useState('');
  const [customAmPm, setCustomAmPm] = React.useState<'AM' | 'PM'>('PM');
  const [submitting, setSubmitting] = React.useState(false);

  const isCustom = PRESETS[presetIdx].offset === 'custom';

  // Reset the form when the sheet reopens.
  React.useEffect(() => {
    if (visible) {
      setTitle('');
      setDescription('');
      setPresetIdx(0);
      setCustomDate('');
      setCustomTime('');
      setCustomAmPm('PM');
      setSubmitting(false);
    }
  }, [visible]);

  // Seed sensible defaults the first time Custom is selected with no
  // typed content. Use a near-future round hour (e.g., next hour) so
  // the user can submit immediately or tweak from there.
  React.useEffect(() => {
    if (!isCustom) return;
    if (customDate || customTime) return;
    const t = new Date(Date.now() + 60 * 60 * 1000);
    t.setMinutes(0, 0, 0);
    const mm = String(t.getMonth() + 1).padStart(2, '0');
    const dd = String(t.getDate()).padStart(2, '0');
    const yyyy = t.getFullYear();
    const hour24 = t.getHours();
    const ampm: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    setCustomDate(`${mm}/${dd}/${yyyy}`);
    setCustomTime(`${hour12}:00`);
    setCustomAmPm(ampm);
  }, [isCustom, customDate, customTime]);

  const customResult = React.useMemo(
    () => parseCustomDateTime(customDate, customTime, customAmPm),
    [customDate, customTime, customAmPm],
  );

  const submitButtonLabel = (() => {
    const off = PRESETS[presetIdx].offset;
    if (off == null) return 'Start now';
    return 'Schedule';
  })();

  const canSubmit = (() => {
    if (title.trim().length === 0) return false;
    if (isCustom && customResult.error != null) return false;
    return true;
  })();

  const handleSubmit = React.useCallback(async () => {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      showToast({ type: 'error', title: 'Title required', message: 'Give your space a title.' });
      return;
    }
    let scheduledAt: string | undefined;
    const preset = PRESETS[presetIdx];
    if (preset.offset == null) {
      scheduledAt = undefined;
    } else if (preset.offset === 'custom') {
      if (customResult.error) {
        showToast({
          type: 'error',
          title: 'Invalid schedule',
          message: customResult.error,
        });
        return;
      }
      scheduledAt = customResult.date.toISOString();
    } else {
      scheduledAt = new Date(Date.now() + preset.offset * 60_000).toISOString();
    }
    setSubmitting(true);
    const room = await createSpace({
      title: trimmedTitle,
      description: description.trim() || undefined,
      scheduledAt,
    });
    setSubmitting(false);
    if (!room) {
      showToast({
        type: 'error',
        title: 'Could not create space',
        message: 'Check your connection and try again.',
      });
      return;
    }
    onClose();
    if (!scheduledAt) {
      join(room.id, { castHash: room.rootCastHash });
    } else {
      showToast({
        type: 'success',
        title: 'Space scheduled',
        message: `Going live ${formatRelative(scheduledAt)}`,
      });
    }
  }, [
    createSpace,
    customResult,
    description,
    join,
    onClose,
    presetIdx,
    showToast,
    title,
  ]);

  if (!visible) return null;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      // Edge-to-edge under the bottom nav bar so the sheet's themed background
      // paints behind it instead of a default-colored (light) nav bar.
      navigationBarTranslucent
    >
      <View style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
        <KeyboardAvoidingView
          style={{ width: '100%' }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          // Account for the status bar / notch above the sheet so the
          // keyboard offset doesn't double-pad it on iOS.
          keyboardVerticalOffset={Platform.OS === 'ios' ? 24 : 0}
        >
          <View
            style={[
              styles.sheet,
              // The sheet background reaches the screen bottom (statusBarTranslucent
              // Modal), so pad the content by the safe-area inset PLUS a gap — the
              // anchored submit button must sit clearly ABOVE the system nav bar,
              // not flush against it. Additive, not max(): max(inset, 24) left the
              // button touching the nav buttons when inset ≈ 24-36px.
              { backgroundColor: theme.colors.surface1, paddingBottom: insets.bottom + Skin.space(16) },
            ]}
          >
            <View style={styles.header}>
              <Text style={[styles.title, { color: theme.colors.textStrong }]}>
                Start a space
              </Text>
              <Pressable onPress={onClose} hitSlop={12}>
                <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
              </Pressable>
            </View>

            <ScrollView
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ paddingBottom: Skin.space(8) }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={[styles.fieldLabel, { color: theme.colors.textSubtle }]}>
                Title
              </Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder="What's this space about?"
                placeholderTextColor={theme.colors.textMuted}
                style={[
                  styles.input,
                  {
                    color: theme.colors.textMain,
                    backgroundColor: theme.colors.bgButtonSubtle,
                    borderColor: theme.colors.fieldBorder,
                  },
                ]}
                maxLength={140}
                returnKeyType="next"
              />

              <Text
                style={[
                  styles.fieldLabel,
                  { color: theme.colors.textSubtle, marginTop: Skin.space(16) },
                ]}
              >
                Description (optional)
              </Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="Add some context"
                placeholderTextColor={theme.colors.textMuted}
                style={[
                  styles.input,
                  styles.inputMultiline,
                  {
                    color: theme.colors.textMain,
                    backgroundColor: theme.colors.bgButtonSubtle,
                    borderColor: theme.colors.fieldBorder,
                  },
                ]}
                maxLength={500}
                multiline
              />

              <Text
                style={[
                  styles.fieldLabel,
                  { color: theme.colors.textSubtle, marginTop: Skin.space(16) },
                ]}
              >
                Start
              </Text>
              <View style={styles.presetRow}>
                {PRESETS.map((p, i) => {
                  const active = i === presetIdx;
                  return (
                    <Pressable
                      key={p.label}
                      onPress={() => setPresetIdx(i)}
                      style={({ pressed }) => [
                        styles.presetChip,
                        {
                          backgroundColor: active ? theme.colors.accent : theme.colors.bgButtonSubtle,
                          borderColor: active ? theme.colors.accent : theme.colors.fieldBorder,
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={{
                          color: active ? '#fff' : theme.colors.textMain,
                          fontWeight: active ? '600' : '500',
                          fontSize: Skin.font(13),
                        }}
                      >
                        {p.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {isCustom && (
                <View style={{ marginTop: Skin.space(16), gap: Skin.space(12) }}>
                  <View style={{ flexDirection: 'row', gap: Skin.space(12) }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.fieldLabel, { color: theme.colors.textSubtle }]}>
                        Date
                      </Text>
                      <TextInput
                        value={customDate}
                        onChangeText={(v) => setCustomDate(formatDateInput(v))}
                        placeholder="MM/DD/YYYY"
                        placeholderTextColor={theme.colors.textMuted}
                        keyboardType="number-pad"
                        maxLength={10}
                        style={[
                          styles.input,
                          {
                            color: theme.colors.textMain,
                            backgroundColor: theme.colors.bgButtonSubtle,
                            borderColor: theme.colors.fieldBorder,
                          },
                        ]}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.fieldLabel, { color: theme.colors.textSubtle }]}>
                        Time
                      </Text>
                      <View style={{ flexDirection: 'row', gap: Skin.space(6) }}>
                        <TextInput
                          value={customTime}
                          onChangeText={(v) => setCustomTime(formatTimeInput(v))}
                          placeholder="H:MM"
                          placeholderTextColor={theme.colors.textMuted}
                          keyboardType="number-pad"
                          maxLength={5}
                          style={[
                            styles.input,
                            {
                              flex: 1,
                              color: theme.colors.textMain,
                              backgroundColor: theme.colors.bgButtonSubtle,
                              borderColor: theme.colors.fieldBorder,
                            },
                          ]}
                        />
                        <View
                          style={{
                            flexDirection: 'row',
                            borderRadius: Skin.radius(10),
                            borderWidth: Skin.border(1),
                            borderColor: theme.colors.fieldBorder,
                            overflow: 'hidden',
                          }}
                        >
                          {(['AM', 'PM'] as const).map((p) => {
                            const active = customAmPm === p;
                            return (
                              <Pressable
                                key={p}
                                onPress={() => setCustomAmPm(p)}
                                style={({ pressed }) => ({
                                  paddingHorizontal: Skin.space(10),
                                  paddingVertical: Skin.space(10),
                                  backgroundColor: active
                                    ? theme.colors.accent
                                    : theme.colors.surface2,
                                  opacity: pressed ? 0.85 : 1,
                                })}
                              >
                                <Text
                                  style={{
                                    color: active ? '#fff' : theme.colors.textMain,
                                    fontWeight: active ? '600' : '500',
                                    fontSize: Skin.font(13),
                                  }}
                                >
                                  {p}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                    </View>
                  </View>
                  {customResult.error ? (
                    <Text style={{ color: theme.colors.danger, fontSize: Skin.font(12) }}>
                      {customResult.error}
                    </Text>
                  ) : (
                    <Text style={{ color: theme.colors.textSubtle, fontSize: Skin.font(12) }}>
                      Going live {formatRelative(customResult.date.toISOString())}
                    </Text>
                  )}
                </View>
              )}

            </ScrollView>

            {/* Submit lives OUTSIDE the ScrollView so the action
                stays anchored to the bottom of the sheet — when the
                Custom inputs push form height past available space,
                the form scrolls but the button stays put. */}
            <Pressable
              onPress={handleSubmit}
              disabled={submitting || !canSubmit}
              style={({ pressed }) => [
                styles.submitButton,
                {
                  backgroundColor: !canSubmit
                    ? theme.colors.surface3
                    : theme.colors.accent,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitButtonText}>{submitButtonLabel}</Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function formatRelative(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'soon';
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return `today at ${time}`;
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

const styles = createSkinnable(() => StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: Skin.radius(16),
    borderTopRightRadius: Skin.radius(16),
    paddingHorizontal: Skin.space(16),
    paddingTop: Skin.space(16),
    // paddingBottom applied inline from the real safe-area inset so the
    // anchored submit button clears the home indicator / nav bar.
    // Fixed slice of screen so the ScrollView always has space and
    // the anchored submit doesn't crowd the inputs. The previous
    // `maxHeight: '90%'` left the sheet content-sized when short,
    // which crammed the button right up against the last field.
    minHeight: '75%',
    maxHeight: '92%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Skin.space(16),
  },
  title: {
    fontSize: Skin.font(18),
    fontWeight: '600',
  },
  fieldLabel: {
    fontSize: Skin.font(12),
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Skin.space(6),
  },
  input: {
    paddingVertical: Skin.space(10),
    paddingHorizontal: Skin.space(12),
    borderRadius: Skin.radius(10),
    borderWidth: Skin.border(1),
    fontSize: Skin.font(15),
  },
  inputMultiline: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Skin.space(8),
  },
  presetChip: {
    paddingVertical: Skin.space(8),
    paddingHorizontal: Skin.space(12),
    borderRadius: Skin.radius(16),
    borderWidth: Skin.border(1),
  },
  submitButton: {
    marginTop: Skin.space(24),
    paddingVertical: Skin.space(14),
    borderRadius: Skin.radius(12),
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: Skin.font(15),
  },
}));
