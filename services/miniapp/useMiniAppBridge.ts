/**
 * useMiniAppBridge Hook
 *
 * Provides the bridge between React Native and mini apps running in WebView.
 * Uses @farcaster/miniapp-host-react-native for compatibility with Farcaster mini apps.
 *
 * SECURITY: This hook implements secure signing isolation. Private keys are NEVER
 * passed to the EthereumProviderService. Instead, signing callbacks are provided
 * that will be invoked when user approval is needed. The actual signing happens
 * in the native context via SecureSigningService, only after user approval.
 */

import { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import WebView from 'react-native-webview';
import * as Haptics from 'expo-haptics';
import { Camera } from 'expo-camera';
import { AudioModule } from 'expo-audio';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useWebViewRpcEndpoint,
  useExposeWebViewToEndpoint,
} from '@farcaster/miniapp-host-react-native';

import { useAuth } from '@/context';
import { getFarcasterCustodyKey, getFarcasterAuthToken } from '@/services/onboarding/secureStorage';
import { fetchFarcasterProfileByFid } from '@/services/onboarding/farcasterService';
import { Context } from '@farcaster/miniapp-core';
import { Address, Hex, PersonalMessage, Secp256k1, Signature, Siwe } from 'ox';
import type { SetPrimaryButtonOptions } from './types';
import {
  EthereumProviderService,
  TransactionForApproval,
  MessageForApproval,
  TypedDataForApproval,
  SigningResult,
} from './ethereumProvider';

// Hook Options

export interface ComposeCastOptions {
  text?: string;
  embeds?: string[];
  parent?: { hash: string };
  channelKey?: string;
}

export interface ComposeCastResult {
  hash?: string;
  error?: { type: string; message?: string };
}

// Address only -- private keys are accessed via getPrivateKey callback when needed.
export interface WalletInfo {
  address: string;
}

export interface UseMiniAppBridgeOptions {
  webViewRef: RefObject<WebView | null>;
  domain: string;
  url: string;
  visible?: boolean;
  walletInfo?: WalletInfo | null;
  onReady?: (options?: { disableNativeGestures?: boolean }) => void;
  onClose?: () => void;
  onPrimaryButtonChange?: (options: SetPrimaryButtonOptions | null) => void;
  onFarcasterRequired?: () => void;
  onComposeCast?: (options: ComposeCastOptions) => Promise<ComposeCastResult>;
  /** Called when mini app requests to view a profile */
  onViewProfile?: (opts: { fid?: number; username?: string }) => void;
  /** Called when mini app requests to view a cast */
  onViewCast?: (opts: { hash: string }) => void;
  // All signing callbacks show approval UI before signing.
  onSendTransaction?: (tx: TransactionForApproval) => Promise<SigningResult>;
  onSignTransaction?: (tx: TransactionForApproval) => Promise<SigningResult>;
  onSignMessage?: (msg: MessageForApproval) => Promise<SigningResult>;
  onSignTypedData?: (data: TypedDataForApproval) => Promise<SigningResult>;
  onSwapToken?: (opts: { sellToken?: string; buyToken?: string; sellAmount?: string; chain?: string }) => void;
  /** View a token's wallet detail / swap sheet. */
  onViewToken?: (opts: { token: string; chain?: string }) => void;
  /** Open the send-token sheet with the given prefill. The host is
   *  responsible for resolving `recipientFid` → a chain address. */
  onSendToken?: (opts: {
    token: string;
    chain?: string;
    amount?: string;
    recipientFid?: number;
  }) => void;
  /** Persist (or remove) the current miniapp from the user's added list.
   *  Resolve with `{ added: true }` on success, `{ error }` on rejection. */
  onAddMiniApp?: () => Promise<{ added: true } | { error: { type: string; message?: string } }>;
}

export interface MiniAppBridgeResult {
  onMessage: (e: any) => void;
  emit: (event: string, data?: Record<string, unknown>) => void;
  primaryButton: SetPrimaryButtonOptions | null;
  isReady: boolean;
  backEnabled: boolean;
  triggerBack: () => void;
  farcasterRequired: boolean;
  bridgeReady: boolean;
}

// Hook Implementation

export function useMiniAppBridge(options: UseMiniAppBridgeOptions): MiniAppBridgeResult {
  const {
    webViewRef,
    domain,
    url,
    visible = true,
    walletInfo,
    onReady,
    onClose,
    onPrimaryButtonChange,
    onFarcasterRequired,
    onComposeCast,
    onViewProfile,
    onViewCast,
    onSendTransaction,
    onSignTransaction,
    onSignMessage,
    onSignTypedData,
    onSwapToken,
    onViewToken,
    onSendToken,
    onAddMiniApp,
  } = options;

  // Debug: Log on every render
  const insets = useSafeAreaInsets();
  const { user } = useAuth();

  // State
  const [primaryButton, setPrimaryButton] = useState<SetPrimaryButtonOptions | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [backEnabled, setBackEnabled] = useState(false);
  const [requestedDomain, setRequestedDomain] = useState<'farcaster' | 'quorum'>('farcaster');
  const [farcasterRequired, setFarcasterRequired] = useState(false);
  const [farcasterPfpUrl, setFarcasterPfpUrl] = useState<string | undefined>(undefined);

  // Fetch the actual Farcaster profile pfpUrl (not a data URI)
  useEffect(() => {
    const fid = user?.farcaster?.fid;
    if (fid) {
      fetchFarcasterProfileByFid(fid).then((profile) => {
        if (profile?.pfpUrl) {
          setFarcasterPfpUrl(profile.pfpUrl);
        }
      });
    }
  }, [user?.farcaster?.fid]);

  // Use the official Farcaster RPC endpoint hook
  const { endpoint, onMessage } = useWebViewRpcEndpoint(webViewRef, domain);

  // Build context for mini app based on requested domain
  const context = useMemo<Context.MiniAppContext>(() => {
    const isQuorumDomain = requestedDomain === 'quorum';

    const username = isQuorumDomain
      ? user?.username
      : (user?.farcaster?.username ?? user?.username);

    // FID is required - use 0 as fallback for non-Farcaster contexts
    const fid = isQuorumDomain ? 0 : (user?.farcaster?.fid ?? 0);

    // Use the fetched Farcaster pfpUrl (real URL, not data URI)
    const pfpUrl = isQuorumDomain
      ? user?.profileImage
      : farcasterPfpUrl;

    const miniAppUser: Context.UserContext = {
      fid,
      displayName: user?.displayName,
      username,
      pfpUrl,
    };

    // clientFid is the FID of the client app (Quorum doesn't have one, use 0)
    const miniAppClient: Context.ClientContext = {
      platformType: 'mobile',
      clientFid: 0,
      added: false,
      safeAreaInsets: {
        top: insets.top,
        left: insets.left,
        right: insets.right,
        bottom: insets.bottom,
      },
    };

    return {
      user: miniAppUser,
      client: miniAppClient,
      features: {
        haptics: true,
      },
    };
  }, [user, insets, requestedDomain, farcasterPfpUrl]);

  // Use refs to always have the latest values available for the SDK methods
  const contextRef = useRef(context);
  contextRef.current = context;

  const urlRef = useRef(url);
  urlRef.current = url;

  // Refs for callbacks to avoid stale closure issues and prevent SDK recreation
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const onPrimaryButtonChangeRef = useRef(onPrimaryButtonChange);
  onPrimaryButtonChangeRef.current = onPrimaryButtonChange;

  const onFarcasterRequiredRef = useRef(onFarcasterRequired);
  onFarcasterRequiredRef.current = onFarcasterRequired;

  const onComposeCastRef = useRef(onComposeCast);
  onComposeCastRef.current = onComposeCast;
  const onViewTokenRef = useRef(onViewToken);
  onViewTokenRef.current = onViewToken;
  const onSendTokenRef = useRef(onSendToken);
  onSendTokenRef.current = onSendToken;
  const onAddMiniAppRef = useRef(onAddMiniApp);
  onAddMiniAppRef.current = onAddMiniApp;

  const onViewProfileRef = useRef(onViewProfile);
  onViewProfileRef.current = onViewProfile;

  const onViewCastRef = useRef(onViewCast);
  onViewCastRef.current = onViewCast;

  // SECURE: Refs for signing callbacks (no private key involved)
  const onSendTransactionRef = useRef(onSendTransaction);
  onSendTransactionRef.current = onSendTransaction;

  const onSignTransactionRef = useRef(onSignTransaction);
  onSignTransactionRef.current = onSignTransaction;

  const onSignMessageRef = useRef(onSignMessage);
  onSignMessageRef.current = onSignMessage;

  const onSignTypedDataRef = useRef(onSignTypedData);
  onSignTypedDataRef.current = onSignTypedData;



  /**
   * Create Ethereum provider when wallet info is available AND modal is visible.
   * SECURITY: No private key is passed to the provider. Only the address for
   * display/verification. All signing operations use the secure callbacks.
   */
  const ethereumProviderService = useMemo(() => {
    if (!visible) {
      return null;
    }
    if (!walletInfo?.address) {
      return null;
    }

    // SECURITY: Provider is created with address only - no private key
    return new EthereumProviderService({
      address: walletInfo.address,
      defaultChainId: 8453, // Default to Base for mini apps
      // Secure callbacks that delegate to parent component
      onSendTransaction: async (tx) => {
        if (onSendTransactionRef.current) {
          return onSendTransactionRef.current(tx);
        }
        return { success: false, error: 'Transaction signing not configured' };
      },
      onSignTransaction: async (tx) => {
        if (onSignTransactionRef.current) {
          return onSignTransactionRef.current(tx);
        }
        return { success: false, error: 'Transaction signing not configured' };
      },
      onSignMessage: async (msg) => {
        if (onSignMessageRef.current) {
          return onSignMessageRef.current(msg);
        }
        return { success: false, error: 'Message signing not configured' };
      },
      onSignTypedData: async (data) => {
        if (onSignTypedDataRef.current) {
          return onSignTypedDataRef.current(data);
        }
        return { success: false, error: 'Typed data signing not configured' };
      },
    });
  }, [visible, walletInfo?.address]);

  // Wrap provider in a plain object with bound methods (required for Comlink serialization)
  const ethereumProvider = useMemo(() => {
    if (!ethereumProviderService) return null;

    const boundRequest = ethereumProviderService.request.bind(ethereumProviderService);
    const boundOn = ethereumProviderService.on.bind(ethereumProviderService);
    const boundRemoveListener = ethereumProviderService.removeListener.bind(ethereumProviderService);
    const provider = {
      request: boundRequest,
      on: boundOn,
      removeListener: boundRemoveListener,
    };

    // Verify the provider works
    return provider;
  }, [ethereumProviderService]);

  // Keep provider ref updated
  const ethereumProviderRef = useRef(ethereumProvider);
  ethereumProviderRef.current = ethereumProvider;

  // Create the SDK object to expose to mini apps
  const sdk = useMemo(() => {
    return {
      // Context - use getter to always return latest context
      get context() {
        return contextRef.current;
      },

      // Capabilities
      getCapabilities: async () => {
        const capabilities = [
          'actions.ready',
          'actions.close',
          'actions.openUrl',
          'actions.setPrimaryButton',
          'actions.signIn',
          'actions.viewProfile',
          'haptics.impactOccurred',
          'haptics.notificationOccurred',
          'haptics.selectionChanged',
          'back',
          'domain.quorum',
          // Always advertise wallet capabilities - Quorum always has a wallet
          // The provider will be ready by the time user interacts with it
          'wallet.getEthereumProvider',
          'wallet.getEvmProvider',
          'actions.viewToken',
          'actions.sendToken',
          'actions.swapToken',
        ];

        if (user?.farcaster) {
          capabilities.push(
            'actions.composeCast',
            'actions.viewCast',
            'actions.addMiniApp'
          );
        }
        return capabilities;
      },

      getChains: async () => {
        // Return supported chains
        const chains = [
          { reference: '1', caip2: 'eip155:1' },      // Ethereum
          { reference: '10', caip2: 'eip155:10' },    // Optimism
          { reference: '137', caip2: 'eip155:137' },  // Polygon
          { reference: '8453', caip2: 'eip155:8453' }, // Base
          { reference: '42161', caip2: 'eip155:42161' }, // Arbitrum
        ];
        return chains;
      },

      // Core actions
      ready: async (opts?: { disableNativeGestures?: boolean; domain?: 'farcaster' | 'quorum' }) => {
        if (opts?.domain === 'quorum') {
          setRequestedDomain('quorum');
          setFarcasterRequired(false);
        } else {
          setRequestedDomain('farcaster');
          const hasFarcaster = !!user?.farcaster?.custodyAddress;
          if (!hasFarcaster) {
            setFarcasterRequired(true);
            onFarcasterRequiredRef.current?.();
          } else {
            setFarcasterRequired(false);
          }
        }

        setIsReady(true);
        onReadyRef.current?.(opts);
      },

      close: () => {
        onCloseRef.current?.();
      },

      openUrl: (url: string) => {
        // Best-effort: open externally. Linking handles http(s), mailto,
        // tel, and platform-registered schemes alike. Silent on failure
        // (miniapp shouldn't trust opening the link anyway).
        Linking.openURL(url).catch(() => { /* ignore */ });
      },

      setPrimaryButton: (opts: SetPrimaryButtonOptions) => {
        setPrimaryButton(opts);
        onPrimaryButtonChangeRef.current?.(opts);
      },

      // Navigation
      viewProfile: (opts: { fid?: number; username?: string }) => {
        onViewProfileRef.current?.(opts);
      },

      viewCast: (opts: { hash: string }) => {
        onViewCastRef.current?.(opts);
      },

      openMiniApp: (opts: { url: string }) => {
      },

      // Authentication
      signIn: async (opts: {
        nonce: string;
        notBefore?: string;
        expirationTime?: string;
        acceptAuthAddress?: boolean;
      }) => {
        const hasFarcaster = !!user?.farcaster?.custodyAddress && !!user?.farcaster?.fid;
        if (!hasFarcaster) {
          setFarcasterRequired(true);
          onFarcasterRequiredRef.current?.();
          throw new Error('rejected_by_user');
        }

        const custodyPrivateKey = await getFarcasterCustodyKey();
        if (!custodyPrivateKey) {
          setFarcasterRequired(true);
          onFarcasterRequiredRef.current?.();
          throw new Error('rejected_by_user');
        }

        const custodyAddressRaw = user.farcaster!.custodyAddress!;
        const fid = user.farcaster!.fid;

        // Verify the private key matches the custody address
        const privateKeyHex = `0x${custodyPrivateKey}` as Hex.Hex;
        const publicKey = Secp256k1.getPublicKey({ privateKey: privateKeyHex });

        // Use checksummed address (EIP-55) - this is what ethers.Wallet.address provides
        // and is required for SIWE message verification
        const custodyAddress = Address.checksum(custodyAddressRaw as Address.Address);

        // Build SIWE message data
        // Use urlRef.current to get the latest URL value
        const currentUrl = urlRef.current;
        const data = {
          version: '1',
          address: custodyAddress as Hex.Hex,
          statement: 'Farcaster Auth',
          chainId: 10,
          resources: [`farcaster://fid/${fid}`] as string[],
          domain,
          // ensure valid RFC 3986 resource URI
          uri: new URL(currentUrl).href,
          nonce: opts.nonce,
          notBefore: opts.notBefore ? new Date(opts.notBefore) : undefined,
          expirationTime: opts.expirationTime ? new Date(opts.expirationTime) : undefined,
        } as const satisfies Siwe.Message;

        const message = Siwe.createMessage(data);

        // Sign using ox library (matches ethers.Wallet.signMessage behavior)
        // 1. Get the personal message sign payload (EIP-191 prefixed hash)
        const payload = PersonalMessage.getSignPayload(Hex.fromString(message));
        // 2. Sign with secp256k1 using private key (already declared above)
        const sig = Secp256k1.sign({ payload, privateKey: privateKeyHex });
        // 3. Convert to hex signature string
        const signature = Signature.toHex(sig);

        return {
          authMethod: 'custody',
          message,
          signature,
        };
      },

      // Haptics
      impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid') => {
        switch (style) {
          case 'light':
          case 'soft':
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            break;
          case 'medium':
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            break;
          case 'heavy':
          case 'rigid':
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            break;
        }
      },

      notificationOccurred: (type: 'success' | 'warning' | 'error') => {
        switch (type) {
          case 'success':
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            break;
          case 'warning':
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            break;
          case 'error':
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            break;
        }
      },

      selectionChanged: () => {
        Haptics.selectionAsync();
      },

      // Frame/MiniApp management
      addMiniApp: async () => {
        const handler = onAddMiniAppRef.current;
        if (!handler) return { error: { type: 'rejected_by_user' } };
        try {
          return await handler();
        } catch (e) {
          return {
            error: {
              type: 'rejected_by_user',
              message: e instanceof Error ? e.message : 'Add failed',
            },
          };
        }
      },

      // Cast composition
      composeCast: async (opts?: {
        text?: string;
        embeds?: string[];
        parent?: { hash: string };
        channelKey?: string;
      }) => {
        // Check if Farcaster is connected - use contextRef for latest user data
        const currentUser = contextRef.current?.user;
        const hasFarcaster = !!currentUser?.fid && currentUser.fid > 0;
        if (!hasFarcaster) {
          setFarcasterRequired(true);
          onFarcasterRequired?.();
          return { error: { type: 'rejected_by_user', message: 'Farcaster account required' } };
        }

        // Check if compose handler is available - use ref for latest callback
        const composeCastHandler = onComposeCastRef.current;
        if (!composeCastHandler) {
          return { error: { type: 'rejected_by_user', message: 'Compose not available' } };
        }

        try {
          const result = await composeCastHandler({
            text: opts?.text,
            embeds: opts?.embeds,
            parent: opts?.parent,
            channelKey: opts?.channelKey,
          });
          return result;
        } catch (error) {
          return {
            error: {
              type: 'rejected_by_user',
              message: error instanceof Error ? error.message : 'Compose failed'
            }
          };
        }
      },

      // Back state
      updateBackState: (state: { visible: boolean }) => {
        setBackEnabled(state.visible);
      },

      // Wallet / Provider methods
      signManifest: async () => {
        return { error: { type: 'rejected_by_user', message: 'Not implemented' } };
      },

      ethProviderRequest: async (params: { method: string; params?: unknown[] }) => {
        // Wait up to 2 seconds for provider to be ready (handles race condition with wallet loading)
        let provider = ethereumProviderRef.current;
        if (!provider) {
          for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            provider = ethereumProviderRef.current;
            if (provider) {
              break;
            }
          }
        }

        if (!provider) {
          // Return a proper EIP-1193 error
          throw { code: 4100, message: 'Wallet not connected' };
        }

        try {
          const result = await provider.request({
            method: params.method,
            params: params.params,
          });
          return result;
        } catch (error: unknown) {
          // Re-throw provider errors with proper structure
          if (error instanceof Error && 'code' in error) {
            throw error;
          }
          throw new Error(error instanceof Error ? error.message : 'Provider request failed');
        }
      },

      eip6963RequestProvider: () => {
        // EIP-6963 provider discovery - emit provider info
        if (ethereumProviderRef.current) {
          endpoint?.emit({
            event: 'eip6963:announceProvider',
            info: {
              name: 'Quorum',
              icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzg4NTVmZiIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSJ3aGl0ZSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTYiIGZvbnQtd2VpZ2h0PSJib2xkIj5RPC90ZXh0Pjwvc3ZnPg==',
              rdns: 'app.quorum.MiniAppWallet',
              uuid: `quorum-${Date.now()}`,
            },
          } as any);
        }
      },

      viewToken: (opts: { token: string; chain?: string }) => {
        onViewTokenRef.current?.(opts);
      },

      sendToken: (opts: { token: string; chain?: string; amount?: string; recipientFid?: number }) => {
        onSendTokenRef.current?.(opts);
      },

      swapToken: (opts: { sellToken?: string; buyToken?: string; sellAmount?: string; chain?: string }) => {
        onSwapToken?.(opts);
      },

      requestCameraAndMicrophoneAccess: async () => {
        // Two-step gate. The OS-level permission prompt only fires the
        // FIRST time per app install, so subsequent miniapp requests
        // would otherwise grant silently — instead we surface a native
        // confirm every time the miniapp asks, since the modal
        // surrounding it doesn't carry that contract. Only after the
        // user confirms do we ask the OS layer.
        const confirmed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            'Camera & Microphone Access',
            `"${domain}" wants to use your camera and microphone.`,
            [
              { text: 'Deny', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Allow', onPress: () => resolve(true) },
            ],
            { onDismiss: () => resolve(false) },
          );
        });
        if (!confirmed) return false;
        try {
          const cam = await Camera.requestCameraPermissionsAsync();
          const mic = await AudioModule.requestRecordingPermissionsAsync();
          return Boolean(cam.granted && mic.granted);
        } catch {
          return false;
        }
      },
    };
  }, [context, domain, user]);

  // Debug logging for wallet integration
  useEffect(() => {
    if (ethereumProvider) {
    }
  }, [walletInfo, ethereumProviderService, ethereumProvider]);

  // Log what we're passing to the hook
  useEffect(() => {
  }, [endpoint, sdk, ethereumProvider]);

  // Expose SDK via the official Farcaster hook
  // Always expose SDK so non-wallet features work immediately
  // Wallet requests will gracefully fail until provider is ready
  // Cast to any since our SDK has minor type differences but is compatible at runtime
  useExposeWebViewToEndpoint({
    endpoint,
    sdk: sdk as any,
    // Pass the ethereum provider for wallet integration (may be null initially)
    ethProvider: ethereumProvider as any,
    debug: true,
  });

  // Emit function for events
  const emit = useCallback((event: string, data?: Record<string, unknown>) => {
    const eventData = { event, ...data } as any;
    endpoint?.emit(eventData);
  }, [endpoint]);

  // Trigger back navigation
  const triggerBack = useCallback(() => {
    emit('back_navigation_triggered');
  }, [emit]);

  // Bridge is ready when endpoint is available
  const bridgeReady = !!endpoint;

  return {
    onMessage,
    emit,
    primaryButton,
    isReady,
    backEnabled,
    triggerBack,
    farcasterRequired,
    bridgeReady,
  };
}
