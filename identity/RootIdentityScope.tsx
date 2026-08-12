import * as React from 'react';
import { useAuth } from '@/context';
import { useSpaces } from '@/hooks/chat';
import { useMultiSpaceRosters } from '@/hooks/useMultiSpaceRosters';
import { IdentityScopeProvider } from './identityProvider';
import { selfLocalNameEntry } from './identityFromMaps';

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
  // The device's own name, as the LAST global tier. Without it a user who
  // never published a public profile renders as their own address in their
  // own header. It can never supply a `.q` — a device name is not a QNS name.
  const locallyKnownNames = React.useMemo(
    () => selfLocalNameEntry(selfAddress, user?.displayName),
    [selfAddress, user?.displayName],
  );

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
