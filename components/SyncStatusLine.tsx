import * as React from 'react';
import { Text, StyleSheet } from 'react-native';
import * as Skin from '@/theme/skins/geometry';
import { type AppTheme } from '@/theme';
import { readLastPublish, type PublishOutcome } from '@/services/config/lastPublish';

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

  // Nothing here subscribes to the store, so a failure occurring while the
  // panel is open would not appear and a recovery would not clear. Polling
  // while mounted is what desktop settled on for the same reason.
  //
  // To be clear about what is and is not a library limit: react-native-mmkv
  // DOES offer `useMMKVListener`. It is not wired up because the record is
  // written through a plain module function rather than a hook, and a 2s poll
  // on an open settings panel is not worth a second mechanism. Swapping to the
  // listener later is a local change with no other consequence.
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
 *
 * Two strings deliberately DIVERGE from desktop's, which is otherwise copied
 * word for word. Both divergences exist because the same outcome value does not
 * mean the same thing on the two clients:
 *
 * - `timeout` — desktop says "It will keep retrying", which is true there: its
 *   action queue retries transient failures with backoff. Mobile has no queue
 *   and never did; `saveConfig`'s catch swallows the error and returns. Nothing
 *   here retries until the user next changes a setting, so promising an
 *   automatic retry would be exactly the false reassurance this line exists to
 *   remove.
 * - `rejected` — desktop wraps only the POST in its try, so `rejected` really
 *   does mean the server refused it. Mobile's try also covers key collection,
 *   encryption and signing, so a local crypto failure lands in the same bucket
 *   (this file's own header documents one such incident with `randomBytes`).
 *   Naming the server would send someone debugging a device-local fault
 *   straight to the wrong system. The real message is kept in the record's
 *   `detail`, along with a marker for whether the request was ever sent.
 */
function failureMessage(outcome: PublishOutcome): string | null {
  switch (outcome) {
    case 'held':
      return 'Waiting for Spaces to finish syncing before this device publishes again.';
    case 'rejected':
      // The reassurance is not padding. Without it the message reads as data
      // loss, and the change IS saved on this device.
      return 'Sync is failing: your settings could not be published. Your changes are saved on this device.';
    case 'timeout':
      return 'Sync is failing: the request timed out. Your changes are saved on this device, and go out with your next change.';
    case 'no-keys':
      return "Can't sync: no key is available on this device.";
    case 'published':
    case 'off':
      // Not faults. Silence is the correct output.
      return null;
    default:
      // At runtime: a newer build wrote an outcome this one does not know, and
      // an unknown value is not a fault this build can describe.
      return neverRendered(outcome);
  }
}

/**
 * Exhaustiveness guard that still behaves at runtime.
 *
 * The `never` parameter is what turns "someone added a fault-shaped member to
 * `PublishOutcome` and did not handle it here" into a compile error, instead of
 * a silently blank line — which would be this component failing in precisely
 * the way it exists to prevent.
 */
function neverRendered(_outcome: never): null {
  return null;
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
