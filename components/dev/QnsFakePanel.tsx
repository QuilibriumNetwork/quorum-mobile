/**
 * QnsFakePanel — dev-build-only controls for faking QNS `.q` names.
 *
 * WHY THIS EXISTS. Every QNS surface in the app is unreachable on an account
 * that owns no registered name, and a name costs real money. So the tier that
 * outranks a user's display name everywhere could break, or could never have
 * worked at all, and using the app would not reveal it. This panel makes the
 * whole ladder reachable without buying anything.
 *
 * ## Giving yourself a name covers most of the job
 *
 * Nearly every surface that renders a name can render YOU: your messages, a
 * reply to your own message, a mention you typed at yourself (the autocomplete
 * does not exclude you — `MessageInput.tsx:515`), your reactions, and the
 * notification body when someone mentions you, since the name resolved there is
 * the MENTIONED person rather than the sender (`logMentionOrReply.ts:95-118`).
 *
 * The everyone switch exists only for what is left: a DM partner's name and a
 * blocked user, neither of which can ever be you. It is a coverage sweep, not a
 * state anybody would really be in.
 *
 * ## The two halves are NOT the same mechanism
 *
 * - **Your own `.q`** is written straight into your profile via
 *   `updateProfile({ primaryUsername })`. That is the real product path — the
 *   "Set as Primary" button on an owned name calls exactly this. The button is
 *   gated on owning a resolvable name; the write underneath is not.
 *
 *   ⚠️ This is REAL STATE, not an overlay. If your profile is public, the next
 *   publish signs the fake name into the v2 payload and POSTs it to whichever
 *   API the "Use Local API" switch points at — production, by default — where
 *   other beta users fetching your profile would see it. Clear it when done.
 *
 * - **Everyone else's `.q`** is an overlay applied to public-profile READS. It
 *   never leaves the device and writes nothing. See `services/dev/fakeQns.ts`.
 *
 * ## Read the cache note before concluding anything is broken
 *
 * Public profiles are cached for an hour. Every control here invalidates that
 * cache on change, which is why they must be driven from this panel rather than
 * by calling the store's setters. Even so, a screen that is already open holds
 * an already-resolved member map — leave the space and come back before
 * believing a negative result.
 *
 * ## What a green run does and does not prove
 *
 * Everything downstream of the network is real: the merge, the ladder, the
 * render. Publishing, the signature payload and the server are not exercised.
 *
 * Only ever mounted from a `__DEV__` gate at the call site (ProfileModal's
 * developer section), matching DmBurstSheet and FarcasterDismissalPanel.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import {
  DevButton,
  DevPanel,
  DevReadout,
  DevRow,
  DevWarning,
} from '@/components/dev/DevPanel';
import {
  clearFakeQns,
  getFakeQnsState,
  removeFakeQnsEntry,
  setFakeQnsEntry,
  setFakeQnsState,
  type FakeQnsState,
} from '@/services/dev/fakeQns';

export function QnsFakePanel() {
  const { theme } = useTheme();
  const queryClient = useQueryClient();
  const { user, updateProfile } = useAuth();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [state, setState] = useState<FakeQnsState>(() => getFakeQnsState());
  const [selfName, setSelfName] = useState<string>(user?.primaryUsername ?? '');

  /** Drop every cached public profile so the next render refetches through the
   *  overlay. Without this a toggle looks inert for up to an hour. */
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['user-public-profile'] });
  }, [queryClient]);

  const update = useCallback(
    (next: Partial<FakeQnsState>) => {
      setState(setFakeQnsState(next));
      invalidate();
    },
    [invalidate],
  );

  const handleReset = useCallback(() => {
    setState(clearFakeQns());
    invalidate();
  }, [invalidate]);

  const handleApplySelf = useCallback(() => {
    // Accept "name" or "name.q" — the stored value is always bare, and the
    // suffix is appended at render. Storing it with the suffix would render
    // "name.q.q".
    const trimmed = selfName.trim().replace(/\.q$/i, '');
    updateProfile({ primaryUsername: trimmed || undefined });

    // Pin the same name for your own address in the overlay.
    //
    // Your profile header reads `user.primaryUsername` directly, but your row
    // in a member list or on your own messages goes through the public-profile
    // path like anyone else's — so without this, the "everyone gets a .q" sweep
    // would show you as qXXXX in chat while your header said the name you just
    // typed. Two different names for yourself on one screen is exactly the
    // confusion this tool is supposed to remove.
    if (user?.address) {
      if (trimmed) setFakeQnsEntry(user.address, { primaryUsername: trimmed });
      else removeFakeQnsEntry(user.address);
      setState(getFakeQnsState());
      invalidate();
    }
  }, [selfName, updateProfile, user?.address, invalidate]);

  const handleClearSelf = useCallback(() => {
    setSelfName('');
    updateProfile({ primaryUsername: undefined });
    if (user?.address) {
      removeFakeQnsEntry(user.address);
      setState(getFakeQnsState());
      invalidate();
    }
  }, [updateProfile, user?.address, invalidate]);

  const mode = state.allProfilesPrivate
    ? 'all profiles private'
    : state.giveEveryoneAName
      ? 'everyone gets a .q'
      : 'no overlay';

  return (
    <DevPanel
      title="Fake QNS"
      hint="See where a .q name renders without owning one. Reads only — nothing is published."
    >
      <DevRow
        label="Enable fake QNS"
        hint="Master switch. Off = identical to a release build."
      >
        <Switch
          value={state.enabled}
          onValueChange={(v) => update({ enabled: v })}
          trackColor={{ true: theme.colors.warning }}
        />
      </DevRow>

      {/* Ordered by what you reach for. Giving yourself a name is the whole job
          most of the time; the two blanket switches below are for questions it
          cannot answer on its own. Before this order, the first control on
          screen was the one that fakes everybody, which reads as the main path
          and is not. */}
      <View style={styles.divider} />
      <DevRow
        label="1 · Give MYSELF a .q"
        hint="Start here. Sets your real primary-username field AND pins the same name for your address, so your profile header and your own chat rows agree."
      />
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={selfName}
          onChangeText={setSelfName}
          placeholder="e.g. qatest"
          placeholderTextColor={theme.colors.textSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Fake primary QNS username"
        />
        <DevButton label="Set" onPress={handleApplySelf} />
        <DevButton label="Clear" onPress={handleClearSelf} />
      </View>
      <DevWarning>
        Writes to your profile. With a public profile this publishes the name to
        the configured API. Clear it when you are done.
      </DevWarning>
      <Text style={styles.note}>
        This covers most of the job. Nearly every surface can render YOU: your
        messages, a reply to your own message, a mention you type at yourself,
        the autocomplete row, your reactions, and the notification body when
        someone mentions you — the name in that body is the mentioned person,
        not the sender.
      </Text>

      <View style={styles.divider} />
      <DevRow
        label="2 · Give EVERYONE a .q"
        hint="Only needed for the few surfaces that can never render you: a DM partner's name, a blocked user. Coverage sweep, not a realistic state. Never overwrites a real registration."
        disabled={!state.enabled}
      >
        <Switch
          value={state.giveEveryoneAName}
          disabled={!state.enabled}
          onValueChange={(v) => update({ giveEveryoneAName: v })}
          trackColor={{ true: theme.colors.warning }}
        />
      </DevRow>

      <DevRow
        label="3 · All profiles private"
        hint="Every public-profile fetch returns nothing. For YOUR OWN profile the real public/private toggle above is the better test — it is end-to-end. This only simulates OTHER people being private. Overrides switch 2."
        disabled={!state.enabled}
      >
        <Switch
          value={state.allProfilesPrivate}
          disabled={!state.enabled}
          onValueChange={(v) => update({ allProfilesPrivate: v })}
          trackColor={{ true: theme.colors.warning }}
        />
      </DevRow>

      <View style={styles.divider} />
      <DevRow>
        <DevReadout>
          {state.enabled ? mode : 'off'}
          {user?.primaryUsername ? ` · me: ${user.primaryUsername}.q` : ' · me: none'}
        </DevReadout>
        <DevButton label="Reset" onPress={handleReset} />
      </DevRow>
      <Text style={styles.note}>
        Reopen the space after a change — an open screen holds an
        already-resolved member map.
      </Text>
      {/* Stated here rather than left to be discovered: the member list is the
          screen most people would open first to check this, and it is the one
          screen no setting here can affect. */}
      <DevWarning>
        Expect NO .q in the Space Settings member list, for anyone. That screen
        reads roster rows and never fetches a public profile, which is the only
        carrier of a .q. Not a fault in this tool — desktop does show it there.
      </DevWarning>
    </DevPanel>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    divider: {
      height: 1,
      backgroundColor: theme.colors.surface2,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    input: {
      flex: 1,
      height: 38,
      borderRadius: Skin.radius(8),
      paddingHorizontal: Skin.space(10),
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      backgroundColor: theme.colors.surface2,
    },
    note: {
      fontSize: Skin.font(11),
      lineHeight: Skin.font(15),
      color: theme.colors.textSubtle,
    },
  });
