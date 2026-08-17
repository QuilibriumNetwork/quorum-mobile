import * as React from 'react';
import { Text, StyleSheet } from 'react-native';
import * as Skin from '@/theme/skins/geometry';
import { type AppTheme } from '@/theme';
import { readLastPublish } from '@/services/config/lastPublish';

/**
 * Shows a line under the "Enable Sync" row ONLY when publishing is failing.
 * Silence means sync is fine.
 *
 * A "Last synced N ago" line was built on desktop first and deliberately
 * removed. It read as a health indicator but reported the last time this device
 * had something to PUBLISH, not the last time it reached the server — pulls
 * happen when the app opens, pushes only when something changes. So a healthy
 * device that had not changed a setting in three days announced "Last synced
 * 3 days ago", which no user can tell apart from three days broken. Reporting
 * success was worse than saying nothing.
 *
 * The record is still written for every outcome, success included. It is the
 * instrument later config-sync work is verified with, and its `payloadBytes`
 * readings are how the still-unknown server size limit gets settled. Only the
 * DISPLAY is failures-only.
 *
 * Known limit, deliberately not solved (same as desktop): someone who never
 * opens Settings never sees this. A toast was discussed and put off.
 *
 * Takes `theme` as a prop rather than calling `useTheme`, because its only
 * caller is ProfileModal's PrivacySettingsSection, which already threads theme
 * and styles down to every row it renders.
 */
const SyncStatusLine: React.FunctionComponent<{
  allowSync: boolean;
  theme: AppTheme;
}> = ({ allowSync, theme }) => {
  const [last, setLast] = React.useState(() => readLastPublish());

  // MMKV writes from this same process fire no event this component subscribes
  // to, so a failure occurring while the panel is open would not appear, and a
  // recovery would not clear. Polling while mounted is what desktop settled on
  // for the same reason.
  React.useEffect(() => {
    setLast(readLastPublish());
    const id = setInterval(() => setLast(readLastPublish()), 2000);
    return () => clearInterval(id);
  }, [allowSync]);

  // Sync off is a setting working as asked, not a fault, and any stored failure
  // predates the switch. The toggle directly above already says everything
  // there is to say.
  if (!allowSync || !last) return null;

  const message = failureMessage(last.outcome);
  if (!message) return null;

  return (
    <Text
      style={[styles.line, { color: theme.colors.warning }]}
      accessibilityRole="alert"
    >
      {message}
    </Text>
  );
};

/**
 * Present tense throughout: the record always describes the most recent
 * attempt, so a stored failure means publishing is failing now, however old the
 * entry is. Returns null for every outcome that is not a fault.
 */
function failureMessage(outcome: string): string | null {
  switch (outcome) {
    case 'held':
      return 'Waiting for Spaces to finish syncing before this device publishes again.';
    case 'rejected':
      // The reassurance is not padding. Without it the message reads as data
      // loss, and the change IS saved on this device.
      return 'Sync is failing: the server refused your settings. Your changes are saved on this device.';
    case 'timeout':
      return 'Sync is failing: the request timed out. It will keep retrying.';
    case 'no-keys':
      return "Can't sync: no key is available on this device.";
    default:
      // 'published' and 'off' are not faults, and neither is an unknown value
      // written by a newer build.
      return null;
  }
}

const styles = StyleSheet.create({
  line: {
    fontSize: Skin.font(12),
    marginTop: -Skin.space(4),
    marginBottom: Skin.space(8),
    marginLeft: Skin.space(16),
    marginRight: Skin.space(16),
  },
});

export default SyncStatusLine;
