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
 * - **Your own `.q`** takes the real product path: write the field, then
 *   publish. "Set as Primary" on an owned name does exactly this. The button is
 *   gated on owning a resolvable name; the path underneath never was, which is
 *   what lets an account owning nothing exercise the whole round trip.
 *
 *   ⚠️ This is REAL STATE and a REAL POST, not an overlay. The fake name is
 *   signed into the v2 payload and sent to whichever API "Use Local API" points
 *   at — production, by default — where anyone fetching your profile sees it.
 *   Clear when done; Clear publishes the un-election the same way. Turning
 *   Public Profile off deletes the whole record and is the escape hatch if a
 *   clear does not take.
 *
 *   This is also the only way to answer a question no unit test can: whether
 *   the server REPLACES the stored profile (so an omitted `primary_username`
 *   clears it) or merges into it (so un-electing silently does nothing).
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
import { republishSelfProfile } from '@/services/profile/republishSelfProfile';
import { NO_PRIMARY_NAME } from '@/utils/primaryName';
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

/**
 * Surface the server's own words for a rejected publish.
 *
 * Worth the few lines: a bare "FAILED" cannot distinguish "the server refuses a
 * name you do not own" (a working ownership check) from "the server does not
 * understand the signing payload that carries a name at all" (electing has
 * never worked for anybody). Those call for opposite responses, and the
 * `logger.warn` in the publish path is filtered in dev, so this readout is the
 * only place the reason is visible.
 */
function formatPublishError(error: unknown): string {
  const e = error as { message?: string; status?: number; code?: string } | null;
  if (!e) return 'unknown';
  return [e.status ? `HTTP ${e.status}` : null, e.code, e.message ?? String(error)]
    .filter(Boolean)
    .join(' · ');
}

export function QnsFakePanel() {
  const { theme } = useTheme();
  const queryClient = useQueryClient();
  const { user, updateProfile } = useAuth();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [state, setState] = useState<FakeQnsState>(() => getFakeQnsState());
  const [selfName, setSelfName] = useState<string>(user?.primaryUsername ?? '');
  /** Result of the last publish attempt, so the round trip is observable from
   *  inside the app rather than only by refetching the endpoint. */
  const [publishOutcome, setPublishOutcome] = useState<string>('');
  /** Blocks a second tap while a POST is in flight. Two overlapping publishes
   *  race to be the server's last write, and the loser silently wins. */
  const [publishing, setPublishing] = useState(false);

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

  const handleApplySelf = useCallback(async () => {
    // Accept "name" or "name.q" — the stored value is always bare, and the
    // suffix is appended at render. Storing it with the suffix would render
    // "name.q.q".
    const trimmed = selfName.trim().replace(/\.q$/i, '');
    const next = trimmed || NO_PRIMARY_NAME;
    updateProfile({ primaryUsername: next });

    // Publish, exactly as the product's "Set as Primary" now does.
    //
    // Without this the panel simulates only HALF the product path: it writes
    // the local field, so every surface that reads your own profile lights up,
    // while the one thing that carries a `.q` to anybody else never happens.
    // That is precisely the bug this whole area had, so a tool that reproduced
    // it would hide the fix rather than demonstrate it.
    //
    // It also makes the panel the only way to exercise elect-and-publish
    // end to end on an account that owns no name — the real button is gated on
    // owning a resolvable one, the write underneath never was.
    if (user) {
      setPublishing(true);
      setPublishOutcome('publishing…');
      const outcome = await republishSelfProfile({ ...user, primaryUsername: next });
      setPublishOutcome(
        outcome.status === 'published'
          ? `published ${next || '(cleared)'}`
          : outcome.status === 'not-public'
            ? 'not published (profile is private)'
            : `publish FAILED: ${formatPublishError(outcome.error)}`,
      );
      setPublishing(false);
    }

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
  }, [selfName, updateProfile, user, invalidate]);

  const handleClearSelf = useCallback(async () => {
    setSelfName('');
    updateProfile({ primaryUsername: NO_PRIMARY_NAME });
    if (user?.address) {
      removeFakeQnsEntry(user.address);
      setState(getFakeQnsState());
      invalidate();
    }
    // Publish the un-election too. This is the half of the round trip that
    // cannot be proved by any test here: whether the server REPLACES the
    // stored record (so an omitted `primary_username` clears it) or merges
    // into it (so the old name survives and un-elect is a lie). Watch the
    // readout, then refetch the profile.
    if (user) {
      setPublishing(true);
      setPublishOutcome('publishing…');
      const outcome = await republishSelfProfile({
        ...user,
        primaryUsername: NO_PRIMARY_NAME,
      });
      setPublishOutcome(
        outcome.status === 'published'
          ? 'published (cleared)'
          : outcome.status === 'not-public'
            ? 'not published (profile is private)'
            : `publish FAILED: ${formatPublishError(outcome.error)}`,
      );
      setPublishing(false);
    }
  }, [updateProfile, user, invalidate]);

  const mode = state.allProfilesPrivate
    ? 'all profiles private'
    : state.giveEveryoneAName
      ? 'everyone gets a .q'
      : 'no overlay';

  return (
    <DevPanel
      title="Fake QNS"
      // Anything actively changing what the app shows stays legible while
      // folded, so a collapsed panel cannot quietly be overriding names.
      badge={
        state.enabled
          ? `${mode}${user?.primaryUsername ? ` · ${user.primaryUsername}.q` : ''}`
          : undefined
      }
      hint="See where a .q name renders without owning one. Giving YOURSELF one publishes, like the real button; giving everyone else one is a read-side overlay that never leaves the device."
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
        <DevButton
          label="Set"
          onPress={() => void handleApplySelf()}
          disabled={publishing}
        />
        <DevButton
          label="Clear"
          onPress={() => void handleClearSelf()}
          disabled={publishing}
        />
      </View>
      {!!publishOutcome && <DevReadout>{publishOutcome}</DevReadout>}
      <DevWarning>
        Set and Clear PUBLISH, the same as the real Set as Primary button — to
        the configured API, which is production unless Use Local API is on. With
        a private profile nothing leaves the device. Clear when you are done, or
        turn Public Profile off, which deletes the whole published record.
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
