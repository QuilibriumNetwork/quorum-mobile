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
import { InteractionManager } from 'react-native';
import { mmkvStorage, clearAllMMKVStorage } from '../services/offline/storage';
import { getPrivateKey, getDeviceKeyset, clearAllSecureStorage, getFarcasterAuthToken, getFarcasterCustodyKey, storeFarcasterAuthToken, storeFarcasterCustodyKey, storeFarcasterSignerKey, storeFarcasterFid, getMnemonic } from '../services/onboarding/secureStorage';
import { deriveFarcasterKeys, lookupFarcasterAccount, validateFarcasterMnemonic } from '../services/onboarding/farcasterService';
import { refreshFarcasterAuthToken, fetchFarcasterProfileByFid } from '../services/onboarding/farcasterService';
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
   */
  refreshFarcasterToken: () => Promise<
    | { token: string }
    | { error: 'no-credentials' | 'derivation-failed' | 'api-rejected' | 'unknown'; detail?: string }
  >;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEYS = {
  USER: 'auth:user',
  AUTH_STATE: 'auth:state',
} as const;

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [user, setUser] = useState<UserInfo | null>(null);
  const [farcasterAuthToken, setFarcasterAuthToken] = useState<string | null>(null);

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

            // Config sync runs in parallel with encryption setup
            const configTask = (async () => {
              try {
                const config = await getConfig(parsedUser.address);
                if (config.name || config.profile_image) {
                  const updatedUser = {
                    ...parsedUser,
                    displayName: config.name || parsedUser.displayName,
                    profileImage: config.profile_image || parsedUser.profileImage,
                  };
                  setUser(updatedUser);
                  mmkvStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(updatedUser));
                }
              } catch (configError) {
              }
            })();

            // Farcaster token refresh runs in parallel with encryption setup
            const tokenTask = (async () => {
              try {
                let farcasterToken = await getFarcasterAuthToken();
                logger.debug('[AuthContext] Deferred token check:', farcasterToken ? 'found' : 'not found');
                if (!farcasterToken) {
                  const custodyKey = await getFarcasterCustodyKey();
                  logger.debug('[AuthContext] Custody key for refresh:', custodyKey ? 'found' : 'not found');
                  if (custodyKey) {
                    farcasterToken = await refreshFarcasterAuthToken(custodyKey);
                    logger.debug('[AuthContext] Refreshed token:', farcasterToken ? 'success' : 'failed');
                    if (farcasterToken) {
                      await storeFarcasterAuthToken(farcasterToken);
                      setFarcasterAuthToken(farcasterToken);
                    }
                  }
                }
              } catch (tokenError) {
                logger.debug('[AuthContext] Token refresh error:', tokenError);
              }
            })();

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
      const updated = { ...prev, ...updates };
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

  const refreshFarcasterToken = useCallback(async (): Promise<
    | { token: string }
    | { error: 'no-credentials' | 'derivation-failed' | 'api-rejected' | 'unknown'; detail?: string }
  > => {
    try {
      const stored = await getFarcasterAuthToken();
      if (stored) {
        if (stored !== farcasterAuthToken) setFarcasterAuthToken(stored);
        return { token: stored };
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
      const fresh = await refreshFarcasterAuthToken(custodyKey);
      if (fresh) {
        await storeFarcasterAuthToken(fresh);
        setFarcasterAuthToken(fresh);
        return { token: fresh };
      }
      return { error: 'api-rejected', detail: 'farcaster.xyz returned no token (auth rejected or rate-limited)' };
    } catch (e) {
      return { error: 'unknown', detail: (e as Error)?.message };
    }
  }, [farcasterAuthToken]);

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
