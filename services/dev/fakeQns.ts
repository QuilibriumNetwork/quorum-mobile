/**
 * fakeQns — dev-build-only synthesis of QNS `.q` names and public profiles.
 *
 * WHY THIS EXISTS. A `.q` name travels in exactly one place: the published
 * public profile. So to see where a `.q` renders you need an account that owns
 * a registered QNS name, has elected it primary, and has a public profile — and
 * so does whoever you are looking at. On a test account with no name, every QNS
 * surface in the app is unreachable, which means the tier can regress silently
 * and no amount of using the app would show it.
 *
 * This module fakes the one thing that is expensive to obtain (a registered
 * name) and nothing else. It intercepts the READ of a public profile and hands
 * back a synthesized one. Nothing is written, nothing is signed, nothing leaves
 * the device.
 *
 * ## That promise covers THIS MODULE, not the whole panel
 *
 * `components/dev/QnsFakePanel.tsx`'s "Give MYSELF a .q" does not write through
 * here at all. It calls the product's own `updateProfile` +
 * `republishSelfProfile`, on purpose, so the panel exercises the real
 * elect-and-publish path rather than half of it. That is a REAL action with
 * effects on other people's devices, and reading the sentence above as covering
 * it has now misled two sessions.
 *
 * The consequence is permanent and worth stating here, where someone reasoning
 * about the overlay will hit it: giving yourself a name broadcasts it to every
 * space, and receivers store it as `claimed_primary_username`. A stored
 * announcement always outranks whatever this module injects, because presence
 * is how an un-election is expressed. So an account that has ever used that
 * button can NEVER be given a synthesized `.q` again on any device that heard
 * it — not even after "Clear", which announces an empty name and is still an
 * announcement.
 *
 * Use "Give EVERYONE a .q" alone for a where-does-it-render sweep. Treat "Give
 * MYSELF a .q" as a one-way door, on an account you do not need for sweeps.
 *
 * ## Why the seam is the API client and not the hooks
 *
 * Desktop tried the hook-level version of this and recorded the trap (see
 * `quorum-desktop/.agents/docs/features/qns-username-display.md`,
 * "Local smoke-testing"): every public-profile hook shares ONE React Query key,
 * so if a hook you forgot to patch resolves first it caches a real `null` and
 * the patched ones never run. The symptom is "the fake never appears" with no
 * error anywhere.
 *
 * Injecting inside `QuorumClient.getPublicProfile` makes that unreachable by
 * construction: there is no second path to a public profile, so there is no
 * hook to forget. It also means the Farcaster reverse-lookup and anything added
 * later are covered for free.
 *
 * ## What it can and cannot tell you
 *
 * It exercises the real resolution ladder, the real merge, and the real render
 * path — everything downstream of the network. It does NOT exercise publishing,
 * the v2 signature payload, or the server. A green run here says "the ladder and
 * the surfaces are correct", not "a real `.q` would arrive".
 *
 * ## Cache
 *
 * Profiles are cached for an hour under `publicProfileQueryKey`. Changing any
 * setting here has no visible effect until that cache is dropped — always go
 * through the panel, which invalidates it, rather than calling the setters
 * directly.
 */

import { createMMKV } from 'react-native-mmkv';

const storage = createMMKV({ id: 'quorum-dev-fake-qns' });

const STATE_KEY = 'fakeQns.state';

/** The public-profile shape the client returns. Kept structural on purpose so
 *  this module never has to import from the API layer it is injected into. */
export interface FakeablePublicProfile {
  display_name: string;
  profile_image: string;
  bio: string;
  primary_username?: string;
  timestamp: number;
  signature: string;
}

/** A deliberate, per-address override. Use for precedence tests where two
 *  members must differ; `giveEveryoneAName` covers the "where does it render"
 *  sweep on its own. */
export interface FakeQnsEntry {
  /** The bare `.q` name, no suffix (`alice` renders as `alice.q`). */
  primaryUsername?: string;
  /** Global display name. Set it to something recognisably different from the
   *  `.q` to prove which tier won. */
  displayName?: string;
  /** Treat this address as having no public profile at all — the same thing the
   *  viewer sees when someone leaves their profile private. */
  private?: boolean;
}

export interface FakeQnsState {
  /** Master switch. Off means this module is inert and the app behaves exactly
   *  as a production build. */
  enabled: boolean;
  /** Synthesize a `.q` for every address that has no explicit entry, derived
   *  from the address so it is stable across reloads. The fastest way to find
   *  every surface that renders a name. */
  giveEveryoneAName: boolean;
  /** Return "no public profile" for every address. Answers the question the
   *  public/private toggle raises: what does someone who messages you see when
   *  your profile is private? */
  allProfilesPrivate: boolean;
  /** Per-address overrides, keyed by lowercased address. */
  entries: Record<string, FakeQnsEntry>;
}

const DEFAULT_STATE: FakeQnsState = {
  enabled: false,
  giveEveryoneAName: false,
  allProfilesPrivate: false,
  entries: {},
};

export function getFakeQnsState(): FakeQnsState {
  const raw = storage.getString(STATE_KEY);
  if (raw == null) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<FakeQnsState>;
    return {
      enabled: parsed.enabled === true,
      giveEveryoneAName: parsed.giveEveryoneAName === true,
      allProfilesPrivate: parsed.allProfilesPrivate === true,
      entries:
        parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export function setFakeQnsState(next: Partial<FakeQnsState>): FakeQnsState {
  const merged = { ...getFakeQnsState(), ...next };
  storage.set(STATE_KEY, JSON.stringify(merged));
  return merged;
}

export function setFakeQnsEntry(address: string, entry: FakeQnsEntry): FakeQnsState {
  const state = getFakeQnsState();
  return setFakeQnsState({
    entries: { ...state.entries, [address.toLowerCase()]: entry },
  });
}

export function removeFakeQnsEntry(address: string): FakeQnsState {
  const { [address.toLowerCase()]: _removed, ...rest } = getFakeQnsState().entries;
  return setFakeQnsState({ entries: rest });
}

export function clearFakeQns(): FakeQnsState {
  storage.remove(STATE_KEY);
  return DEFAULT_STATE;
}

/**
 * A stable, obviously-fake `.q` derived from an address.
 *
 * Deterministic so the same member keeps the same name across reloads — a name
 * that changed every render would make it impossible to tell "this surface
 * re-resolved" from "this surface shows a different person". Prefixed `qa` so
 * nothing on screen can be mistaken for a real registration.
 */
export function deriveFakeQName(address: string): string {
  const entropy = (address.startsWith('Qm') ? address.slice(2) : address)
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
  return `qa${entropy.slice(0, 4) || '0000'}`;
}

/**
 * Is this `.q` claim one THIS module synthesized for THIS address?
 *
 * ## Why a verification bypass has to exist at all
 *
 * Receiver-side verification resolves a claimed name against QNS and checks it
 * derives back to the claimant's address. A synthesized name is not registered
 * anywhere, so it can never pass that check — and no amount of cleverness here
 * can make it, because faking a passing record would mean finding a public key
 * whose hash is a chosen address. That is a preimage attack, not a dev tool.
 *
 * Without this seam the overlay would still inject names and verification would
 * strip every one of them, so every QNS surface would render blank exactly as
 * it did before the instrument existed — and the panel would look broken while
 * reporting success.
 *
 * ## Why it is per-name and not a global "verification off" switch
 *
 * A real registration must still face the real check while the panel is on.
 * Same reasoning as `applyFakeQns` refusing to fake over a real `primary_username`:
 * if the instrument disabled the very check it is meant to help observe, the one
 * case worth watching would be the one case it hid.
 *
 * Returns false for every name it did not synthesize, so a real claim — and an
 * impersonated one — both fall through to the genuine comparison.
 *
 * Unreachable in production: the module is only required under `__DEV__`, so
 * this cannot weaken a shipped build. Do not add a non-dev caller.
 */
export function isFakeClaimFor(name: string, address: string): boolean {
  const claimed = (name ?? '').trim();
  if (!claimed || !address) return false;

  const state = getFakeQnsState();
  if (!state.enabled || state.allProfilesPrivate) return false;

  const entry = state.entries[address.toLowerCase()];
  if (entry?.private) return false;

  const synthesized =
    entry?.primaryUsername ||
    (entry ? undefined : state.giveEveryoneAName ? deriveFakeQName(address) : undefined);

  return !!synthesized && synthesized === claimed;
}

/**
 * The seam. Called from `QuorumClient.getPublicProfile` with whatever the
 * server actually returned (including `null` for a 404).
 *
 * Returning a synthesized profile for a `null` is the important case, not an
 * edge one: a test account's spacemates typically have no public profile at
 * all, so an overlay that only decorated existing profiles would decorate
 * nothing.
 */
export function applyFakeQns(
  address: string,
  actual: FakeablePublicProfile | null,
): FakeablePublicProfile | null {
  const state = getFakeQnsState();
  if (!state.enabled) return actual;

  if (state.allProfilesPrivate) return null;

  const entry = state.entries[address.toLowerCase()];
  if (entry?.private) return null;

  // Never fake over a real registration. If someone genuinely published a `.q`,
  // the sweep must leave it visible — otherwise the one case the instrument
  // exists to observe would be the one case it hides, and a real regression
  // would be masked by a synthetic pass. An explicit entry still wins, because
  // that is a deliberate act rather than a blanket rule.
  const realQns = actual?.primary_username;
  const primaryUsername =
    entry?.primaryUsername ||
    realQns ||
    (entry ? undefined : state.giveEveryoneAName ? deriveFakeQName(address) : undefined);
  const displayName = entry?.displayName;

  if (!primaryUsername && !displayName) return actual;

  return {
    display_name: displayName || actual?.display_name || '',
    profile_image: actual?.profile_image ?? '',
    bio: actual?.bio ?? '',
    ...(primaryUsername ? { primary_username: primaryUsername } : {}),
    // Now, so a faked global name outranks whatever the roster's global slot
    // holds. The merge in useMembersWithPublicProfileFallback picks the newer
    // of the two by timestamp, so a stale one here would silently lose and the
    // fake would look broken.
    timestamp: Date.now(),
    signature: actual?.signature ?? '',
  };
}
