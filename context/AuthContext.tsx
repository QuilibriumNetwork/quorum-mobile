/**
 * AuthContext - Manages user authentication state
 *
 * Provides:
 * - User address and profile info
 * - Authentication state (logged in, onboarding, etc.)
 * - Sign message capability for API requests (ed448)
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
} from 'react';
import { AppState, InteractionManager } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { mmkvStorage, clearAllMMKVStorage } from '../services/offline/storage';
import { getPrivateKey, getDeviceKeyset, clearAllSecureStorage, getFarcasterAuthToken, getFarcasterAuthTokenExpiresAt, getFarcasterCustodyKey, storeFarcasterAuthToken, storeFarcasterAuthTokenExpiresAt, storeFarcasterCustodyKey, storeFarcasterSignerKey, storeFarcasterFid, getMnemonic } from '../services/onboarding/secureStorage';
import { deriveFarcasterKeys, lookupFarcasterAccount, validateFarcasterMnemonic } from '../services/onboarding/farcasterService';
import { refreshFarcasterAuthToken, fetchFarcasterProfileByFid } from '../services/onboarding/farcasterService';
import { registerFarcasterAuthFailureHandler } from '../services/farcaster/authTokenEvents';
import { initializeEncryptionKeys, uploadUserRegistration, deriveQuilibriumAddressWithMnemonic, ensurePrivateKey } from '../services/onboarding/keyService';
import { NativeSigningProvider } from '../services/crypto';
import { getConfig, saveConfig } from '../services/config';
import { logger } from '@quilibrium/quorum-shared';
// Auth state types
export type AuthState = 'loading' | 'unauthenticated' | 'onboarding' | 'authenticated';

export type PrivacyLevel = 'maximum' | 'enhanced' | 'standard';

export interface FarcasterInfo {
  fid: number;
  username: string;
  signerPublicKey: string;
  custodyAddress?: string;  // Ethereum address for Farcaster custody
  pfpUrl?: string;  // Original Farcaster profile image URL (not data URI)
}

export interface UserInfo {
  address: string;              // Qm... style Quorum address
  quilibriumAddress: string;    // 0x-prefixed Quilibrium address for QNS
  publicKey: string;
  displayName?: string;
  username?: string;            // Deprecated, use primaryUsername
  primaryUsername?: string;     // QNS username set as primary (e.g., "alice" for @alice)
  bio?: string;
  profileImage?: string;
  isProfilePublic?: boolean;    // Whether profile is visible to anyone (opt-in)
  profileUpdatedAt?: number;    // ms epoch of last local profile write; used to decide whether a synced config (also Date.now()-stamped) is newer when bridging config -> user on login
  privacyLevel: PrivacyLevel;
  farcaster?: FarcasterInfo;
}

interface AuthContextValue {
  // State
  authState: AuthState;
  user: UserInfo | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  farcasterAuthToken: string | null;  // Auth token for Farcaster API calls

  // Actions
  signIn: (userInfo: UserInfo) => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (updates: Partial<UserInfo>) => void;
  signMessage: (message: string) => Promise<string>;
  /**
   * Attempt to refresh the Farcaster auth token via the stored
   * custody key. Returns a result tuple so surfaces can distinguish
   * "got a token" from the various ways it can fail (no credentials,
   * mnemonic recovery failed, API rejected, network error). Each
   * branch maps to a different UI affordance — see feed/index.tsx.
   *
   * `force` skips the stored-token early return and mints a fresh
   * token from the custody key — used by the 401/403 backstop where
   * the stored token is exactly what just got rejected.
   */
  refreshFarcasterToken: (opts?: { force?: boolean }) => Promise<
    | { token: string }
    | { error: 'no-credentials' | 'derivation-failed' | 'api-rejected' | 'unknown'; detail?: string }
  >;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEYS = {
  USER: 'auth:user',
  AUTH_STATE: 'auth:state',
} as const;

// Farcaster auth-token refresh policy. Tokens are minted with a ~1000
// day lifetime, but accounts imported long ago do expire — and before
// this change an expired-but-present token was never refreshed, forcing
// users to disconnect/reconnect. We renew proactively well before
// expiry, and bootstrap tokens stored before expiry tracking existed
// via an MMKV "last refresh attempt" mark.
const FARCASTER_REFRESH_MARK_KEY = 'farcaster.lastTokenRefresh';
const FARCASTER_REFRESH_OK_KEY = 'farcaster.lastTokenRefreshOk';
const TOKEN_REFRESH_LEAD_MS = 7 * 24 * 60 * 60 * 1000;       // renew within 7 days of expiry
const UNKNOWN_EXPIRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;  // unknown expiry: renew if no attempt in 30 days
const REFRESH_THROTTLE_MS = 6 * 60 * 60 * 1000;              // foreground checks: one attempt per 6h
const REFRESH_FAILURE_RETRY_MS = 60 * 60 * 1000;             // ...but retry a failed attempt after 1h

function getRefreshMark(): number | null {
  const raw = mmkvStorage.getItem(FARCASTER_REFRESH_MARK_KEY);
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Mark is recorded on ATTEMPT (not just success) so an offline device
// doesn't hammer the API on every foreground; the OK flag lets the
// throttle distinguish "renewed fine, leave it alone for 6h" from
// "failed, worth retrying in 1h".
function recordRefreshAttempt(): void {
  mmkvStorage.setItem(FARCASTER_REFRESH_MARK_KEY, String(Date.now()));
  mmkvStorage.setItem(FARCASTER_REFRESH_OK_KEY, '0');
}

function recordRefreshSuccess(): void {
  mmkvStorage.setItem(FARCASTER_REFRESH_OK_KEY, '1');
}

/**
 * Proactive Farcaster token renewal. Refreshes when the token is
 * missing, within TOKEN_REFRESH_LEAD_MS of its stored expiry, or — for
 * tokens stored before expiry tracking existed — when the last refresh
 * attempt is older than UNKNOWN_EXPIRY_MAX_AGE_MS. `throttle` is set by
 * the AppState listener so repeated foregrounds don't re-attempt more
 * than once per REFRESH_THROTTLE_MS (REFRESH_FAILURE_RETRY_MS after a
 * failure). Never clears an existing token on failure — a stale token
 * beats no token, and the 401 backstop handles outright rejection.
 */
async function maybeRefreshFarcasterAuthToken(
  onToken: (token: string) => void,
  opts?: { throttle?: boolean },
): Promise<void> {
  try {
    const [token, expiresAt] = await Promise.all([
      getFarcasterAuthToken(),
      getFarcasterAuthTokenExpiresAt(),
    ]);
    const now = Date.now();

    let needsRefresh: boolean;
    if (!token) {
      needsRefresh = true;
    } else if (expiresAt != null) {
      needsRefresh = expiresAt - now < TOKEN_REFRESH_LEAD_MS;
    } else {
      const mark = getRefreshMark();
      needsRefresh = mark == null || now - mark > UNKNOWN_EXPIRY_MAX_AGE_MS;
    }
    if (!needsRefresh) return;

    if (opts?.throttle) {
      const mark = getRefreshMark();
      const lastOk = mmkvStorage.getItem(FARCASTER_REFRESH_OK_KEY) === '1';
      const wait = lastOk ? REFRESH_THROTTLE_MS : REFRESH_FAILURE_RETRY_MS;
      if (mark != null && now - mark < wait) return;
    }

    const custodyKey = await getFarcasterCustodyKey();
    if (!custodyKey) return;

    recordRefreshAttempt();
    const fresh = await refreshFarcasterAuthToken(custodyKey);
    logger.debug('[AuthContext] Proactive token refresh:', fresh ? 'success' : 'failed');
    if (!fresh) return;

    recordRefreshSuccess();
    await storeFarcasterAuthToken(fresh.secret);
    if (fresh.expiresAt != null) {
      await storeFarcasterAuthTokenExpiresAt(fresh.expiresAt);
    }
    onToken(fresh.secret);
  } catch (e) {
    logger.debug('[AuthContext] Proactive token refresh error:', e);
  }
}

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [user, setUser] = useState<UserInfo | null>(null);
  const [farcasterAuthToken, setFarcasterAuthToken] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Load persisted auth state on mount
  useEffect(() => {
    const loadAuthState = async () => {
      try {
        const storedUser = mmkvStorage.getItem(STORAGE_KEYS.USER);
        const storedState = mmkvStorage.getItem(STORAGE_KEYS.AUTH_STATE);

        if (storedUser && storedState === 'authenticated') {
          let parsedUser = JSON.parse(storedUser) as UserInfo;

          // Auto-derive quilibriumAddress for existing accounts that don't have it
          if (!parsedUser.quilibriumAddress) {
            const [mnemonic, privateKey] = await Promise.all([
              getMnemonic(),
              getPrivateKey(),
            ]);
            if (mnemonic || privateKey) {
              parsedUser = {
                ...parsedUser,
                quilibriumAddress: deriveQuilibriumAddressWithMnemonic(mnemonic, privateKey),
              };
              // Save updated user with quilibriumAddress
              mmkvStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(parsedUser));
            }
          }

          setUser(parsedUser);
          setAuthState('authenticated');

          // Load Farcaster auth token FIRST - it's quick and needed for API calls
          try {
            const farcasterToken = await getFarcasterAuthToken();
            logger.debug('[AuthContext] Farcaster token from storage:', farcasterToken ? 'found' : 'not found');
            if (farcasterToken) {
              setFarcasterAuthToken(farcasterToken);
            }
          } catch (tokenError) {
            logger.debug('[AuthContext] Error loading Farcaster token:', tokenError);
            // Ignore - will try to refresh later
          }

          // Defer heavy background tasks to not block UI rendering
          // These operations involve crypto and network calls that can freeze the UI
          InteractionManager.runAfterInteractions(async () => {
            logger.debug('[AuthContext] Deferred tasks starting...');
            // Small delay to ensure UI has fully rendered
            await new Promise(resolve => setTimeout(resolve, 500));

            // Run encryption setup and independent network tasks in parallel
            const encryptionTask = (async () => {
              // ensurePrivateKey self-heals: if the Ed448 key was lost from
              // secure storage but the mnemonic is still there, re-derive and
              // re-persist it. Without this, uploadUserRegistration below is
              // skipped, the current device inbox never reaches the server,
              // and this user becomes unreachable over DM.
              const [keyset, privateKey] = await Promise.all([
                getDeviceKeyset(),
                ensurePrivateKey(),
              ]);

              const meAddr = parsedUser.address.slice(0, 8);
              logger.debug(
                `[AuthContext ${meAddr}] startup encryption task: hasKeyset=${!!keyset}, hasPrivateKey=${!!privateKey}, hasPublicKey=${!!parsedUser.publicKey}`,
              );

              if (!keyset && parsedUser.publicKey) {
                logger.debug(`[AuthContext ${meAddr}] no keyset — initializing new keys`);
                try {
                  const deviceKeyset = await initializeEncryptionKeys(parsedUser.publicKey);
                  if (privateKey) {
                    try {
                      await uploadUserRegistration(
                        parsedUser.address,
                        parsedUser.publicKey,
                        privateKey,
                        deviceKeyset
                      );
                    } catch (uploadError) {
                      logger.debug(
                        `[AuthContext ${meAddr}] post-init upload failed:`,
                        uploadError instanceof Error ? uploadError.message : uploadError,
                      );
                    }
                  } else {
                    logger.debug(`[AuthContext ${meAddr}] SKIP upload after key init: no privateKey`);
                  }
                } catch (keyError) {
                  logger.debug(
                    `[AuthContext ${meAddr}] initializeEncryptionKeys failed:`,
                    keyError instanceof Error ? keyError.message : keyError,
                  );
                }
              } else if (keyset && privateKey && parsedUser.publicKey) {
                try {
                  await uploadUserRegistration(
                    parsedUser.address,
                    parsedUser.publicKey,
                    privateKey,
                    keyset
                  );
                } catch (uploadError) {
                  const errorMsg = uploadError instanceof Error ? uploadError.message : String(uploadError);
                  if (!errorMsg.includes('409') && !errorMsg.includes('conflict')) {
                    logger.debug(
                      `[AuthContext ${meAddr}] startup registration upload error:`,
                      errorMsg,
                    );
                  }
                }
              } else {
                logger.debug(
                  `[AuthContext ${meAddr}] SKIP registration: missing one of keyset(${!!keyset}), privateKey(${!!privateKey}), publicKey(${!!parsedUser.publicKey})`,
                );
              }
            })();

            // Config sync runs in parallel with encryption setup.
            //
            // This is the config -> user read-back bridge. Synced config fields
            // (name, profile_image, bio, isProfilePublic) arrive from the server
            // but only name/profile_image were previously copied into `user`, so
            // a value set on another device (e.g. the public-profile toggle)
            // never reached this device's `user` and showed stale. We now also
            // bridge bio + isProfilePublic.
            //
            // Precedence: config sync is last-write-wins by server timestamp
            // (saveConfig stamps config.timestamp = Date.now()). Only let the
            // remote config win for the synced toggle/text fields when it is
            // newer than this device's last local profile write
            // (profileUpdatedAt), so an unsynced fresh local change isn't
            // clobbered. name/profile_image keep their original truthy-fill
            // behavior to avoid regressing the working display-name sync.
            const configTask = (async () => {
              try {
                const config = await getConfig(parsedUser.address);
                const configIsNewer =
                  typeof config.timestamp === 'number' &&
                  config.timestamp > (parsedUser.profileUpdatedAt ?? 0);
                if (config.name || config.profile_image || configIsNewer) {
                  const updatedUser = {
                    ...parsedUser,
                    displayName: config.name || parsedUser.displayName,
                    profileImage: config.profile_image || parsedUser.profileImage,
                    ...(configIsNewer && {
                      bio: config.bio ?? parsedUser.bio,
                      isProfilePublic: config.isProfilePublic ?? parsedUser.isProfilePublic,
                    }),
                  };
                  setUser(updatedUser);
                  mmkvStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(updatedUser));
                }
              } catch (configError) {
              }
            })();

            // Farcaster token refresh runs in parallel with encryption
            // setup. Renews when the token is missing OR nearing expiry
            // (the old `!token` check let an expired-but-present token
            // sit forever — see maybeRefreshFarcasterAuthToken).
            const tokenTask = maybeRefreshFarcasterAuthToken((token) => {
              setFarcasterAuthToken(token);
            });

            // Backfill the Farcaster pfp for accounts onboarded before it was
            // persisted (older builds dropped it). Without this, the user's
            // own avatar renders as the placeholder in surfaces like space
            // chat. Merges onto the freshest stored copy to avoid clobbering
            // configTask's write.
            const farcasterPfpTask = (async () => {
              try {
                const fc = parsedUser.farcaster;
                if (!fc?.fid || fc.pfpUrl) return;
                const profile = await fetchFarcasterProfileByFid(fc.fid);
                const pfpUrl = profile?.pfpUrl;
                if (!pfpUrl) return;
                setUser((prev) =>
                  prev?.farcaster ? { ...prev, farcaster: { ...prev.farcaster, pfpUrl } } : prev,
                );
                const raw = mmkvStorage.getItem(STORAGE_KEYS.USER);
                if (raw) {
                  const cur = JSON.parse(raw) as UserInfo;
                  if (cur.farcaster) {
                    cur.farcaster.pfpUrl = pfpUrl;
                    mmkvStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(cur));
                  }
                }
              } catch {
                // Best-effort.
              }
            })();

            // Wait for all tasks to complete
            await Promise.all([encryptionTask, configTask, tokenTask, farcasterPfpTask]);
          });
        } else {
          setAuthState('unauthenticated');
        }
      } catch (error) {
        setAuthState('unauthenticated');
      }
    };

    loadAuthState();
  }, []);

  // Proactive renewal on foreground: tokens outlive typical sessions,
  // so expiry usually approaches while the app is backgrounded. The
  // helper throttles attempts via the lastTokenRefresh mark (6h after
  // a success, 1h after a failure so transient network errors retry
  // sooner).
  useEffect(() => {
    if (authState !== 'authenticated') return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void maybeRefreshFarcasterAuthToken(
        (token) => setFarcasterAuthToken(token),
        { throttle: true },
      );
    });
    return () => subscription.remove();
  }, [authState]);

  const signIn = useCallback(async (userInfo: UserInfo) => {
    try {
      // Persist user info
      mmkvStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(userInfo));
      mmkvStorage.setItem(STORAGE_KEYS.AUTH_STATE, 'authenticated');

      setUser(userInfo);
      setAuthState('authenticated');
    } catch (error) {
      throw error;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      // Clear all MMKV storage (spaces, channels, messages, conversations, auth state)
      clearAllMMKVStorage();

      // Clear secure storage (private keys, mnemonics, onboarding state)
      await clearAllSecureStorage();

      setUser(null);
      setAuthState('unauthenticated');
    } catch (error) {
      throw error;
    }
  }, []);

  const updateProfile = useCallback((updates: Partial<UserInfo>) => {
    setUser((prev) => {
      if (!prev) return prev;
      // Stamp the local write time so a later login can tell whether the
      // synced config (also Date.now()-stamped in saveConfig) is newer than
      // this device's last local change before overlaying it onto `user`.
      const updated = { ...prev, ...updates, profileUpdatedAt: Date.now() };
      mmkvStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(updated));

      // Sync profile changes to server config (if allowSync is enabled)
      // This runs async in background - no need to await
      (async () => {
        try {
          const config = await getConfig(prev.address);
          if (config.allowSync) {
            const configUpdates: { name?: string; profile_image?: string; bio?: string; isProfilePublic?: boolean } = {};
            if (updates.displayName !== undefined) {
              configUpdates.name = updates.displayName;
            }
            if (updates.profileImage !== undefined) {
              configUpdates.profile_image = updates.profileImage;
            }
            if (updates.bio !== undefined) {
              configUpdates.bio = updates.bio;
            }
            if (updates.isProfilePublic !== undefined) {
              configUpdates.isProfilePublic = updates.isProfilePublic;
            }

            if (Object.keys(configUpdates).length > 0) {
              await saveConfig({
                ...config,
                ...configUpdates,
              });
            }
          }
        } catch {
          // Config sync is best-effort — profile update is already saved locally
        }
      })();

      return updated;
    });
  }, []);

  // Sign message for API authentication using ed448 (native Rust implementation)
  // Note: We use a ref to avoid re-creating this callback when user changes,
  // which would cause cascading re-renders in ApiClientProvider
  const userRef = React.useRef(user);
  userRef.current = user;

  // Singleton signing provider instance
  const signingProvider = React.useMemo(() => new NativeSigningProvider(), []);

  const signMessage = useCallback(async (message: string): Promise<string> => {
    if (!userRef.current) {
      throw new Error('User not authenticated');
    }

    // ensurePrivateKey transparently re-derives from mnemonic if the Ed448
    // key is missing from secure storage.
    const privateKey = await ensurePrivateKey();
    if (!privateKey) {
      throw new Error('Private key not found');
    }

    // Sign with ed448 using native module
    return signingProvider.signEd448(privateKey, message);
  }, [signingProvider]);

  const refreshFarcasterToken = useCallback(async (opts?: { force?: boolean }): Promise<
    | { token: string }
    | { error: 'no-credentials' | 'derivation-failed' | 'api-rejected' | 'unknown'; detail?: string }
  > => {
    try {
      // `force` skips this early return — the 401 backstop calls with
      // force because the stored token is what just got rejected.
      if (!opts?.force) {
        const stored = await getFarcasterAuthToken();
        if (stored) {
          if (stored !== farcasterAuthToken) setFarcasterAuthToken(stored);
          return { token: stored };
        }
      }
      let custodyKey = await getFarcasterCustodyKey();

      // Recovery: derive Farcaster keys from the stored mnemonic when
      // SecureStore has drifted out of sync with MMKV. Track WHY each
      // step fails so the caller can surface a meaningful message.
      let recoveryDetail: string | undefined;
      if (!custodyKey) {
        const mnemonic = await getMnemonic();
        if (!mnemonic) {
          recoveryDetail = 'no mnemonic in secure storage';
        } else if (!validateFarcasterMnemonic(mnemonic)) {
          recoveryDetail = `mnemonic invalid for Farcaster (length ${mnemonic.length})`;
        } else {
          try {
            const keys = deriveFarcasterKeys(mnemonic);
            const account = await lookupFarcasterAccount(
              keys.custodyAddress,
              keys.custodyPrivateKey,
            );
            if (account?.fid) {
              await Promise.all([
                storeFarcasterCustodyKey(keys.custodyPrivateKey),
                storeFarcasterSignerKey(keys.signerPrivateKey),
                storeFarcasterFid(account.fid),
              ]);
              custodyKey = keys.custodyPrivateKey;
              if (account.authToken) {
                await storeFarcasterAuthToken(account.authToken);
                if (account.authTokenExpiresAt != null) {
                  await storeFarcasterAuthTokenExpiresAt(account.authTokenExpiresAt);
                }
                setFarcasterAuthToken(account.authToken);
                return { token: account.authToken };
              }
            } else {
              recoveryDetail =
                'mnemonic derives a Farcaster custody address but lookup returned no FID — this account was likely created with a different seed phrase';
            }
          } catch (e) {
            recoveryDetail = `derivation/lookup threw: ${(e as Error)?.message ?? 'unknown'}`;
          }
        }
      }

      if (!custodyKey) {
        return { error: 'no-credentials', detail: recoveryDetail };
      }
      recordRefreshAttempt();
      const fresh = await refreshFarcasterAuthToken(custodyKey);
      if (fresh) {
        recordRefreshSuccess();
        await storeFarcasterAuthToken(fresh.secret);
        if (fresh.expiresAt != null) {
          await storeFarcasterAuthTokenExpiresAt(fresh.expiresAt);
        }
        setFarcasterAuthToken(fresh.secret);
        return { token: fresh.secret };
      }
      return { error: 'api-rejected', detail: 'farcaster.xyz returned no token (auth rejected or rate-limited)' };
    } catch (e) {
      return { error: 'unknown', detail: (e as Error)?.message };
    }
  }, [farcasterAuthToken]);

  // Reactive 401/403 backstop: high-traffic Farcaster call sites (feed,
  // notifications, legacy cast submit) report rejections through
  // authTokenEvents; we force-refresh from the custody key and then
  // invalidate the Farcaster query caches. The token is deliberately
  // NOT in those queryKeys — queryFns read it per-render from
  // context-fed props, so the refetch triggered by invalidation is what
  // carries the new token to the API.
  useEffect(() => {
    return registerFarcasterAuthFailureHandler(async () => {
      const result = await refreshFarcasterToken({ force: true });
      if ('token' in result) {
        void queryClient.invalidateQueries({ queryKey: ['farcaster-feed'] });
        void queryClient.invalidateQueries({ queryKey: ['farcaster-notifications'] });
      }
    });
  }, [refreshFarcasterToken, queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      authState,
      user,
      isAuthenticated: authState === 'authenticated',
      isLoading: authState === 'loading',
      farcasterAuthToken,
      signIn,
      signOut,
      updateProfile,
      signMessage,
      refreshFarcasterToken,
    }),
    [authState, user, farcasterAuthToken, signIn, signOut, updateProfile, signMessage, refreshFarcasterToken]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function useUser(): UserInfo | null {
  const { user } = useAuth();
  return user;
}

export function useIsAuthenticated(): boolean {
  const { isAuthenticated } = useAuth();
  return isAuthenticated;
}

export default AuthContext;
