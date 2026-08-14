import * as React from 'react';
import { useAuth } from '@/context/AuthContext';
import { useSpaces } from '@/hooks/chat/useSpaces';
import { useMultiSpaceRosters } from '@/hooks/useMultiSpaceRosters';
import { useConversations } from '@/hooks/chat/useConversations';
import { IdentityScopeProvider } from './identityProvider';
import {
  EMPTY_LOCAL_NAMES,
  conversationLocalNames,
  selfLocalNameEntry,
} from './identityFromMaps';

/**
 * Root identity scope: mounted above every screen and every app-level modal
 * host, before any call site migrates onto the identity ladder. Desktop
 * mounted providers surface by surface and shipped a crash where an
 * app-level modal host sat outside all of them (pinning a post threw
 * `used outside <IdentityScopeProvider>` in the operator's hands) — this
 * makes that unrepresentable, because nothing can render outside this scope.
 *
 * Carries REAL data, not empty maps as a crash backstop: every space's
 * roster (a local MMKV read, so this costs no requests) plus the device's
 * own name as the last global tier. No spaceId — the root is always the
 * global ladder; a Space screen refines it with its own nested provider.
 *
 * Lives here, in `identity/`, rather than inline in `app/_layout.tsx` where
 * it is mounted: importing `app/_layout.tsx` from a test transitively pulls
 * in `react-native-webrtc` (via `components/Call`), which throws a native
 * `NativeEventEmitter` invariant under jest. Extracting this component is
 * what makes it possible to render and test in isolation.
 *
 * Imports `useAuth`/`useSpaces` from their specific files, not the
 * `@/context` / `@/hooks/chat` barrels — those barrels also reach a
 * different, unmockable native module (`Cannot find native module
 * 'QuorumCrypto'`, via real AuthContext/StorageContext code) — AND is
 * deliberately NOT re-exported from `identity/index.ts`, the barrel every
 * other name-resolution call site imports from. It is mounted exactly once,
 * at the app root; nothing else needs it via `@/identity`, and re-exporting
 * it there would make importing `MemberName` alone execute this file's full
 * import graph too. See `identityBarrelSafety.test.tsx`.
 */
export function RootIdentityScope({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { data: spaces } = useSpaces();
  const spaceIds = React.useMemo(
    () => (spaces ?? []).map((s: { spaceId?: string; id?: string }) => s.spaceId ?? s.id ?? '').filter(Boolean),
    [spaces],
  );
  const rostersBySpace = useMultiSpaceRosters(spaceIds);
  const selfAddress = user?.address ?? null;

  // DM partners' names, from the conversation rows they broadcast themselves.
  // A DM has no roster, so without this a partner who never published a public
  // profile renders as a truncated address everywhere — see
  // `conversationLocalNames`.
  //
  // Costs no requests: `useConversations` is a local storage read, and it
  // shares one React Query key with the Messages tab, so mounting it here adds
  // an observer rather than a read. Only the first page is consulted here (this
  // never calls `fetchNextPage`), but the shared cache means any page the inbox
  // has already loaded is visible for free.
  const { data: conversationPages } = useConversations({
    type: 'direct',
    enabled: !!selfAddress,
  });
  const conversations = React.useMemo(
    () => (conversationPages?.pages ?? []).flatMap((p) => p?.conversations ?? []),
    [conversationPages],
  );

  // The device's own name, as the LAST global tier. Without it a user who
  // never published a public profile renders as their own address in their
  // own header. It can never supply a `.q` — a device name is not a QNS name.
  //
  // Self is spread LAST so it wins: the device knows its own name better than
  // any conversation row does.
  const locallyKnownNames = React.useMemo(() => {
    const partners = conversationLocalNames(conversations);
    const self = selfLocalNameEntry(selfAddress, user?.displayName);
    if (self === EMPTY_LOCAL_NAMES) return partners;
    if (partners === EMPTY_LOCAL_NAMES) return self;
    return { ...partners, ...self };
  }, [conversations, selfAddress, user?.displayName]);

  return (
    <IdentityScopeProvider
      rostersBySpace={rostersBySpace}
      selfAddress={selfAddress}
      locallyKnownNames={locallyKnownNames}
    >
      {children}
    </IdentityScopeProvider>
  );
}
