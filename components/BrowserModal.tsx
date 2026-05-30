import { ProfileView } from '@/components/SocialFeed/views/ProfileView';
import { ThreadDetailView } from '@/components/SocialFeed/views/ThreadDetailView';
import { Button } from '@/components/ui/Button';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useWalletSelection, useActiveWalletKeys } from '@/hooks/useWalletSelection';
import { useWallet, useWalletKeys, aggregateAssets, type AggregatedAsset } from '@/hooks/useWallet';
import { useFarcasterSubmitCast } from '@/hooks/useFarcasterSubmitCast';
import { useMiniAppBridge, type ComposeCastOptions, type ComposeCastResult } from '@/services/miniapp';
import {
  TransactionForApproval,
  MessageForApproval,
  TypedDataForApproval,
  SigningResult,
} from '@/services/miniapp/ethereumProvider';
import {
  signPersonalMessage,
  signTypedData,
  signAndSendTransaction,
  signTransactionOnly,
} from '@/services/miniapp/secureSigningService';
import { likeCast, unlikeCast, followUser, unfollowUser } from '@/services/farcasterClient';
import { resolveFidByUsername } from '@/services/farcaster/mentionExtraction';
import { fetchFarcasterUser } from '@quilibrium/quorum-shared';
import { useQueryClient } from '@tanstack/react-query';
import { getFarcasterAuthToken } from '@/services/onboarding/secureStorage';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { getErrorMessage } from '@/utils/error';
import MiniAppApprovalModal, { ApprovalRequest } from '@/components/MiniAppApprovalModal';
import SwapModal from '@/components/wallet/SwapModal';
import SendModal from '@/components/wallet/SendModal';
import { addMiniapp } from '@/services/miniapp/addedMiniapps';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';

interface BrowserModalProps {
  visible: boolean;
  url: string;
  onClose: () => void;
  isQNative?: boolean;
  onShowTransactionWarning?: (warningType: 'simulation-failed' | 'no-entitlements' | 'not-declared' | 'ok') => void;
  /** Timestamp for cache busting - pass Date.now() when launching to force refresh */
  timestamp?: number;
  /** Allow bypassing SSL certificate errors for LAN IP addresses (development only) */
  allowInsecureLAN?: boolean;
  /** When true the sheet animates off-screen but BrowserModal stays
   *  mounted — the WebView's RN view (and its JS / DOM state) survives.
   *  Restored by setting back to false. */
  minimized?: boolean;
  /** Called when the miniapp triggers a view-cast/view-profile action;
   *  the host context typically sets `minimized=true`. */
  onMinimize?: () => void;
}

// Check if a URL is a LAN/local IP address
function isLanUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    // Check for localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    // Check for private IP ranges
    // 10.x.x.x
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    // 172.16.x.x - 172.31.x.x
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    // 192.168.x.x
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    // Link-local 169.254.x.x
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function BrowserModal({ visible, url, onClose, isQNative = false, onShowTransactionWarning, timestamp = 0, allowInsecureLAN = false, minimized = false, onMinimize }: BrowserModalProps) {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);

  const shouldBypassSsl = allowInsecureLAN && isLanUrl(url);

  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(url);
  // Delay source loading for LAN URLs to ensure ignoreSslErrorForLocalNetwork prop is set first
  const [sourceReady, setSourceReady] = useState(!shouldBypassSsl);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [warningType, setWarningType] = useState<'simulation-failed' | 'no-entitlements' | 'not-declared' | 'ok'>('ok');
  const [showSplash, setShowSplash] = useState(true);
  const [showFarcasterPrompt, setShowFarcasterPrompt] = useState(false);

  // Compose modal state
  const [composeVisible, setComposeVisible] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [composeEmbeds, setComposeEmbeds] = useState<string[]>([]);
  const [composeParentHash, setComposeParentHash] = useState<string | undefined>(undefined);
  const [composeChannelKey, setComposeChannelKey] = useState<string | undefined>(undefined);
  const [composePosting, setComposePosting] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const composeResolverRef = useRef<((result: ComposeCastResult) => void) | null>(null);
  const MAX_CAST_LENGTH = 320;

  // Profile/Cast overlay state (for viewProfile/viewCast SDK methods)
  const [profileOverlay, setProfileOverlay] = useState<{ fid: number } | null>(null);
  const [castOverlay, setCastOverlay] = useState<{ username: string; castHashPrefix: string } | null>(null);
  const [likeStates, setLikeStates] = useState<Map<string, { liked: boolean; count: number }>>(new Map());
  const [followStates, setFollowStates] = useState<Map<number, boolean>>(new Map());
  const [farcasterToken, setFarcasterToken] = useState<string | undefined>(undefined);

  // Fetch Farcaster token for overlays
  useEffect(() => {
    getFarcasterAuthToken().then(token => {
      if (token) setFarcasterToken(token);
    });
  }, []);

  // Hypersnap-first cast publish for the miniapp compose flow. Mention
  // extraction stays on — miniapp text typically intends @-handles as
  // Farcaster usernames; falls back to legacy when no signer.
  const { submitCast: submitMiniAppCast } = useFarcasterSubmitCast({
    token: farcasterToken,
  });

  // Delay source loading for LAN URLs to ensure native prop is set before WebView loads
  useEffect(() => {
    if (shouldBypassSsl && !sourceReady) {
      const timer = setTimeout(() => setSourceReady(true), 50);
      return () => clearTimeout(timer);
    }
  }, [shouldBypassSsl, sourceReady]);

  // Wallet state for mini app integration - uses selected wallet (builtin or warpcast)
  const { activeWallet, activeType, availableWallets, hasWarpcastWallet, switchWallet, isSwitching, isLoading: walletLoading } = useWalletSelection();
  // Get private key for warpcast wallet (available immediately) or fetch for builtin
  const { privateKey: warpcastPrivateKey } = useActiveWalletKeys();
  const { refetch: fetchBuiltinKeys } = useWalletKeys();
  // User's wallet balances aggregated into a flat list. Used by the
  // sendToken miniapp handler to look up the requested token's
  // canonical entry (symbol + decimals), since miniapps pass only a
  // CAIP-19 reference and we need real decimals for the amount field.
  const { balances } = useWallet();
  const allAssets = React.useMemo(() => aggregateAssets(balances), [balances]);

  // Helper to get private key on-demand (for signing)
  const getPrivateKeyForSigning = useCallback(async (): Promise<string | null> => {
    if (activeType === 'warpcast' && warpcastPrivateKey) {
      return warpcastPrivateKey;
    }
    // For builtin wallet, fetch keys on-demand
    const result = await fetchBuiltinKeys();
    return result.data?.ethereum?.privateKey ?? null;
  }, [activeType, warpcastPrivateKey, fetchBuiltinKeys]);

  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [showWalletSelector, setShowWalletSelector] = useState(false);
  const [showSwapModal, setShowSwapModal] = useState(false);
  const [swapInitialBuyToken, setSwapInitialBuyToken] = useState<string | undefined>(undefined);
  const [showSendModal, setShowSendModal] = useState(false);
  const [sendInitialAsset, setSendInitialAsset] = useState<AggregatedAsset | null>(null);
  const [sendInitialRecipient, setSendInitialRecipient] = useState<string | undefined>(undefined);
  const [sendInitialAmount, setSendInitialAmount] = useState<string | undefined>(undefined);

  // Convert active wallet to WalletInfo format for the bridge
  // SECURITY: Only pass the address, not the private key
  const walletInfo = useMemo(() => {
    if (!activeWallet) return null;
    return {
      address: activeWallet.address,
    };
  }, [activeWallet]);

  // Extract domain from URL for MiniApp bridge (moved up for use in approval handlers)
  const domain = useMemo(() => {
    try {
      return new URL(url || '').hostname;
    } catch {
      return url || '';
    }
  }, [url]);

  /**
   * SECURE: Handle send transaction request from mini app
   * Shows approval UI, then signs and sends if approved
   */
  const handleSendTransaction = useCallback((tx: TransactionForApproval): Promise<SigningResult> => {
    return new Promise((resolve) => {
      setApprovalRequest({
        type: 'transaction',
        transaction: tx,
        appName: title || domain,
        resolve: async (approved: boolean) => {
          if (!approved) {
            resolve({ success: false, error: 'User rejected the transaction' });
            return;
          }

          // Get the private key for signing (fetched on-demand)
          const privateKey = await getPrivateKeyForSigning();
          if (!privateKey) {
            resolve({ success: false, error: 'Wallet not available' });
            return;
          }

          try {
            // Sign and send via SecureSigningService
            const hash = await signAndSendTransaction(privateKey, {
              to: tx.to,
              value: tx.value,
              data: tx.data,
              gas: tx.gas,
              gasPrice: tx.gasPrice,
              maxFeePerGas: tx.maxFeePerGas,
              maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
              nonce: tx.nonce,
              chainId: tx.chainId,
            });
            resolve({ success: true, hash });
          } catch (error: unknown) {
            resolve({ success: false, error: getErrorMessage(error) || 'Transaction failed' });
          }
        },
      });
      setShowApprovalModal(true);
    });
  }, [title, domain, activeWallet]);

  /**
   * SECURE: Handle sign transaction (without sending) request from mini app
   */
  const handleSignTransaction = useCallback((tx: TransactionForApproval): Promise<SigningResult> => {
    return new Promise((resolve) => {
      setApprovalRequest({
        type: 'transaction',
        transaction: tx,
        appName: title || domain,
        resolve: async (approved: boolean) => {
          if (!approved) {
            resolve({ success: false, error: 'User rejected the transaction' });
            return;
          }

          const privateKey = await getPrivateKeyForSigning();
          if (!privateKey) {
            resolve({ success: false, error: 'Wallet not available' });
            return;
          }

          try {
            const signature = await signTransactionOnly(privateKey, {
              to: tx.to,
              value: tx.value,
              data: tx.data,
              gas: tx.gas,
              gasPrice: tx.gasPrice,
              maxFeePerGas: tx.maxFeePerGas,
              maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
              nonce: tx.nonce,
              chainId: tx.chainId,
            });
            resolve({ success: true, signature });
          } catch (error: unknown) {
            resolve({ success: false, error: getErrorMessage(error) || 'Signing failed' });
          }
        },
      });
      setShowApprovalModal(true);
    });
  }, [title, domain, activeWallet]);

  /**
   * SECURE: Handle message signing request from mini app
   */
  const handleSignMessage = useCallback((msg: MessageForApproval): Promise<SigningResult> => {
    return new Promise((resolve) => {
      setApprovalRequest({
        type: 'message',
        message: msg,
        appName: title || domain,
        resolve: async (approved: boolean) => {
          if (!approved) {
            resolve({ success: false, error: 'User rejected the signature request' });
            return;
          }

          const privateKey = await getPrivateKeyForSigning();
          if (!privateKey) {
            resolve({ success: false, error: 'Wallet not available' });
            return;
          }

          try {
            const signature = await signPersonalMessage(privateKey, msg.rawMessage);
            resolve({ success: true, signature });
          } catch (error: unknown) {
            resolve({ success: false, error: getErrorMessage(error) || 'Signing failed' });
          }
        },
      });
      setShowApprovalModal(true);
    });
  }, [title, domain, activeWallet]);

  /**
   * SECURE: Handle typed data signing request from mini app
   */
  const handleSignTypedData = useCallback((data: TypedDataForApproval): Promise<SigningResult> => {
    return new Promise((resolve) => {
      setApprovalRequest({
        type: 'typedData',
        typedData: data,
        appName: title || domain,
        resolve: async (approved: boolean) => {
          if (!approved) {
            resolve({ success: false, error: 'User rejected the signature request' });
            return;
          }

          const privateKey = await getPrivateKeyForSigning();
          if (!privateKey) {
            resolve({ success: false, error: 'Wallet not available' });
            return;
          }

          try {
            const signature = await signTypedData(privateKey, {
              domain: data.domain,
              types: data.types,
              primaryType: data.primaryType,
              message: data.message,
            });
            resolve({ success: true, signature });
          } catch (error: unknown) {
            resolve({ success: false, error: getErrorMessage(error) || 'Signing failed' });
          }
        },
      });
      setShowApprovalModal(true);
    });
  }, [title, domain, activeWallet]);

  // Close approval modal
  const handleApprovalModalClose = useCallback(() => {
    setShowApprovalModal(false);
    setApprovalRequest(null);
  }, []);

  // Cache busting: increment revision when same URL is launched again with new timestamp
  const [revision, setRevision] = useState(0);
  const prevLaunch = useRef({ url, timestamp });

  useEffect(() => {
    const isSameUrl = prevLaunch.current.url === url;
    const isNewLaunch = prevLaunch.current.timestamp !== timestamp && timestamp > 0;

    if (isSameUrl && isNewLaunch) {
      setRevision((r) => r + 1);
    }

    prevLaunch.current = { url, timestamp };
  }, [timestamp, url]);

  // Update URL when prop changes - use useLayoutEffect to ensure URL is set before render
  useLayoutEffect(() => {
    if (visible && url) {
      setCurrentUrl(url);
      setShowSplash(true); // Reset splash when opening new URL
      setShowFarcasterPrompt(false); // Reset prompt when opening new URL
    }
  }, [visible, url]);

  // Handle mini app close
  const handleMiniAppClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Handle mini app ready
  const handleMiniAppReady = useCallback(() => {
    setShowSplash(false);
  }, []);

  // Handle Farcaster required
  const handleFarcasterRequired = useCallback(() => {
    setShowFarcasterPrompt(true);
  }, []);

  // Handle compose cast request from mini app
  const handleComposeCast = useCallback((options: ComposeCastOptions): Promise<ComposeCastResult> => {
    // Always show local compose overlay (works within the same modal context)
    return new Promise((resolve) => {
      // Store the resolver to call when compose is complete
      composeResolverRef.current = resolve;

      // Set initial compose state from options
      setComposeText(options.text ?? '');
      setComposeEmbeds(options.embeds ?? []);
      setComposeParentHash(options.parent?.hash);
      setComposeChannelKey(options.channelKey);
      setComposeError(null);
      setComposePosting(false);

      // Show compose overlay
      setComposeVisible(true);
    });
  }, []);

  // Handle compose cancel
  const handleComposeCancel = useCallback(() => {
    setComposeVisible(false);
    setComposeText('');
    setComposeEmbeds([]);
    setComposeParentHash(undefined);
    setComposeChannelKey(undefined);
    setComposeError(null);

    // Resolve with dismissed result
    if (composeResolverRef.current) {
      composeResolverRef.current({ error: { type: 'rejected_by_user', message: 'User cancelled' } });
      composeResolverRef.current = null;
    }
  }, []);

  // Handle compose post
  const handleComposePost = useCallback(async () => {
    if (composePosting) return;
    if (composeText.trim().length === 0 && composeEmbeds.length === 0) return;

    setComposePosting(true);
    setComposeError(null);

    try {
      const token = await getFarcasterAuthToken();
      if (!token) {
        throw new Error('Not authenticated with Farcaster');
      }

      // Build embeds array with URLs
      const embeds = composeEmbeds.map(url => url);

      const result = await submitMiniAppCast({
        text: composeText.trim(),
        embedUrls: embeds,
        parent: composeParentHash
          ? { castHashHex: composeParentHash }
          : undefined,
        channelKey: composeChannelKey,
      });

      // Close compose modal
      setComposeVisible(false);
      setComposeText('');
      setComposeEmbeds([]);
      setComposeParentHash(undefined);
      setComposeChannelKey(undefined);

      // Resolve with success
      if (composeResolverRef.current) {
        composeResolverRef.current({ hash: result.hash });
        composeResolverRef.current = null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to post';
      setComposeError(message);

      // Don't resolve here - let user retry or cancel
    } finally {
      setComposePosting(false);
    }
  }, [composeText, composeEmbeds, composeParentHash, composeChannelKey, composePosting]);

  const queryClient = useQueryClient();

  // Minimize the miniapp so the WebView's RN view + JS state survive
  // while the user views the cast/profile. Falls back to `onClose`
  // when the host doesn't provide a minimize callback (legacy
  // local-state hosts that haven't been migrated to
  // MiniappOverlayProvider).
  const minimizeOrClose = useCallback(() => {
    if (onMinimize) onMinimize();
    else onClose();
  }, [onMinimize, onClose]);

  // Handle viewProfile from mini app SDK — navigate to the user's
  // profile in the feed tab, minimize the miniapp so it's available
  // to restore.
  const handleViewProfile = useCallback(async (opts: { fid?: number; username?: string }) => {
    let fid = opts.fid;
    if (!fid && opts.username) {
      fid = (await resolveFidByUsername(queryClient, opts.username)) ?? undefined;
    }
    minimizeOrClose();
    if (fid) {
      // The feed tab consumes `?profileFid=…` and opens the profile
      // overlay on mount.
      router.push({
        pathname: '/(tabs)/feed',
        params: { profileFid: String(fid) },
      });
    }
  }, [queryClient, minimizeOrClose]);

  // Handle viewCast from mini app SDK — navigate to the cast in the
  // feed tab, minimize the miniapp so it's available to restore.
  const handleViewCast = useCallback((opts: { hash: string }) => {
    minimizeOrClose();
    router.push({
      pathname: '/(tabs)/feed',
      params: { username: '', castHashPrefix: opts.hash },
    });
  }, [minimizeOrClose]);

  // Handle like toggle in overlays — confirm + API call. Optimistically
  // update local state, roll back on failure.
  const handleLikeToggle = useCallback(async (castHash: string, currentlyLiked: boolean, currentCount: number) => {
    const action = currentlyLiked ? 'Unlike' : 'Like';
    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        `${action} cast?`,
        currentlyLiked
          ? 'Remove your like from this cast?'
          : 'Like this cast on Farcaster?',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: action, onPress: () => resolve(true) },
        ],
        { onDismiss: () => resolve(false) },
      );
    });
    if (!confirmed) return;

    const token = await getFarcasterAuthToken();
    if (!token) return;

    // Optimistic
    setLikeStates(prev => {
      const next = new Map(prev);
      next.set(castHash, { liked: !currentlyLiked, count: currentlyLiked ? currentCount - 1 : currentCount + 1 });
      return next;
    });
    try {
      if (currentlyLiked) {
        await unlikeCast({ token, castHash });
      } else {
        await likeCast({ token, castHash });
      }
    } catch {
      // Roll back on failure.
      setLikeStates(prev => {
        const next = new Map(prev);
        next.set(castHash, { liked: currentlyLiked, count: currentCount });
        return next;
      });
    }
  }, []);

  // Handle follow toggle in overlays — confirm + API call.
  const handleFollow = useCallback(async (fid: number) => {
    const isFollowing = followStates.get(fid) ?? false;
    const action = isFollowing ? 'Unfollow' : 'Follow';
    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        `${action} user?`,
        isFollowing
          ? 'Stop following this user on Farcaster?'
          : 'Follow this user on Farcaster?',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: action, onPress: () => resolve(true) },
        ],
        { onDismiss: () => resolve(false) },
      );
    });
    if (!confirmed) return;

    const token = await getFarcasterAuthToken();
    if (!token) return;

    // Optimistic
    setFollowStates(prev => {
      const next = new Map(prev);
      next.set(fid, !isFollowing);
      return next;
    });
    try {
      if (isFollowing) {
        await unfollowUser({ token, targetFid: fid });
      } else {
        await followUser({ token, targetFid: fid });
      }
    } catch {
      // Roll back on failure.
      setFollowStates(prev => {
        const next = new Map(prev);
        next.set(fid, isFollowing);
        return next;
      });
    }
  }, [followStates]);

  // Handle navigation within overlays (profile -> thread, thread -> profile, etc.)
  const handleOverlayOpenThread = useCallback((username: string, hashPrefix: string) => {
    setCastOverlay({ username, castHashPrefix: hashPrefix });
  }, []);

  const handleOverlayOpenProfile = useCallback((fid: number, _username?: string) => {
    setProfileOverlay({ fid });
  }, []);

  const handleOverlayOpenMiniApp = useCallback((miniAppUrl: string) => {
    // For now, just log - could open nested mini app or navigate
  }, []);

  const handleOverlayOpenChannel = useCallback((channelKey: string) => {
    // For now, just log - could open channel view
  }, []);

  // Handle swapToken from mini app SDK
  const handleSwapToken = useCallback((opts: { sellToken?: string; buyToken?: string; sellAmount?: string; chain?: string }) => {
    // Parse CAIP-19 token format: eip155:8453/erc20:0x... -> extract chain and contract address
    if (opts.buyToken) {
      // Parse format like "eip155:8453/erc20:0x..."
      const caipMatch = opts.buyToken.match(/eip155:(\d+)\/erc20:(.+)$/);
      if (caipMatch) {
        const chainId = parseInt(caipMatch[1], 10);
        const address = caipMatch[2];
        setSwapInitialBuyToken(JSON.stringify({ address, chainId }));
      } else {
        // Fallback: just an address, assume Base
        setSwapInitialBuyToken(JSON.stringify({ address: opts.buyToken, chainId: 8453 }));
      }
    }
    setShowSwapModal(true);
  }, []);

  // viewToken — the SDK's read-only counterpart to swapToken. Our
  // wallet UI doesn't have a dedicated "view token" sheet, so we route
  // to the same Swap surface preselected as the buy side. User can
  // dismiss without acting if they just wanted to inspect price/liquidity.
  const handleViewToken = useCallback((opts: { token: string; chain?: string }) => {
    handleSwapToken({ buyToken: opts.token, chain: opts.chain });
  }, [handleSwapToken]);

  // sendToken — open the send sheet with recipient + amount prefilled
  // when the miniapp provided them. Token-level prefill (symbol/decimals)
  // is best-effort: we look up the address in the user's existing
  // balances and only preselect the asset when we find a match (the
  // exact decimals matter for amount conversion — better to leave the
  // picker open than to silently send a wrong-decimals tx).
  const handleSendToken = useCallback(async (opts: {
    token: string;
    chain?: string;
    amount?: string;
    recipientFid?: number;
  }) => {
    // Resolve recipientFid → primary ETH verified address. Solana
    // miniapps don't ride this code path today.
    let recipient: string | undefined;
    if (opts.recipientFid) {
      try {
        const user = await fetchFarcasterUser(opts.recipientFid);
        recipient = user?.primaryEthAddress ?? user?.verifiedEthAddresses?.[0];
      } catch {
        // Leave recipient empty so the user can paste/enter manually.
      }
    }

    // Parse CAIP-19 token reference (same shape handleSwapToken uses).
    let chainName: string | undefined;
    let contractAddress: string | undefined;
    const caip = opts.token.match(/eip155:(\d+)\/erc20:(.+)$/);
    if (caip) {
      const chainId = parseInt(caip[1], 10);
      contractAddress = caip[2].toLowerCase();
      const idToChain: Record<number, string> = {
        1: 'ethereum',
        8453: 'base',
        42161: 'arbitrum',
        10: 'optimism',
        137: 'polygon',
      };
      chainName = idToChain[chainId];
    }

    // Match against the user's holdings — only set preselectedAsset
    // when symbol + decimals can be trusted from a real balance row.
    const matched = contractAddress && chainName
      ? allAssets.find(
          (a) =>
            a.chain === chainName &&
            (a.contractAddress?.toLowerCase() === contractAddress),
        )
      : undefined;

    setSendInitialAsset(matched ?? null);
    setSendInitialRecipient(recipient);
    setSendInitialAmount(opts.amount);
    setShowSendModal(true);
  }, [allAssets]);

  // addMiniApp — persist the current miniapp into the user's "added"
  // list (MMKV-backed) and confirm to the SDK. The launcher consumes
  // that list to render the user's pinned set.
  const handleAddMiniApp = useCallback(async () => {
    try {
      addMiniapp({ domain, url: currentUrl });
      return { added: true as const };
    } catch (e) {
      return {
        error: {
          type: 'rejected_by_user',
          message: e instanceof Error ? e.message : 'Failed to add',
        },
      };
    }
  }, [domain, currentUrl]);

  // MiniApp bridge - uses Comlink to expose SDK to mini apps
  // SECURITY: Only passes walletInfo (address), not private key.
  // Signing is performed via secure callbacks after user approval.
  const {
    onMessage,
    primaryButton,
    isReady,
    backEnabled,
    triggerBack,
    emit,
    farcasterRequired,
    bridgeReady,
  } = useMiniAppBridge({
    webViewRef,
    domain,
    url: currentUrl,
    visible,
    walletInfo,
    onReady: handleMiniAppReady,
    onClose: handleMiniAppClose,
    onFarcasterRequired: handleFarcasterRequired,
    onComposeCast: handleComposeCast,
    onViewProfile: handleViewProfile,
    onViewCast: handleViewCast,
    // SECURE signing callbacks - perform signing after user approval
    onSendTransaction: handleSendTransaction,
    onSignTransaction: handleSignTransaction,
    onSignMessage: handleSignMessage,
    onSignTypedData: handleSignTypedData,
    onSwapToken: handleSwapToken,
    onViewToken: handleViewToken,
    onSendToken: handleSendToken,
    onAddMiniApp: handleAddMiniApp,
  });

  // Fallback timeout: hide splash after 2 seconds if ready() hasn't been called
  useEffect(() => {
    if (!showSplash || !visible) return;

    const timeout = setTimeout(() => {
      if (showSplash) {
        setShowSplash(false);
      }
    }, 2000);

    return () => clearTimeout(timeout);
  }, [showSplash, visible]);

  // Handle primary button press
  const handlePrimaryButtonPress = useCallback(() => {
    emit('primary_button_clicked');
  }, [emit]);

  // JavaScript to inject for console logging
  const injectedJavaScript = `
    (function() {
      function sendToRN(level, args) {
        try {
          const message = args.map(arg => {
            if (typeof arg === 'object') {
              try {
                return JSON.stringify(arg);
              } catch (e) {
                return String(arg);
              }
            }
            return String(arg);
          }).join(' ');

          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: '__CONSOLE__',
            level: level,
            message: message
          }));
        } catch (e) {}
      }

      // Also capture uncaught errors
      window.onerror = function(message, source, lineno, colno, error) {
        sendToRN('error', ['Uncaught Error:', message, 'at', source + ':' + lineno + ':' + colno]);
        return false;
      };

      // Capture unhandled promise rejections
      window.onunhandledrejection = function(event) {
        sendToRN('error', ['Unhandled Promise Rejection:', event.reason]);
      };
    })();
    true;
  `;

  // Handle WebView messages (Comlink)
  const handleWebViewMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    try {
      const data = JSON.parse(e.nativeEvent.data);
      if (data.type === '__CONSOLE__') {
        // Ignore console messages from WebView
        return;
      }
    } catch (e) {
      // Not JSON or not a console message, pass through
    }
    // Forward to Comlink handler
    onMessage(e);
  }, [onMessage]);

  const handleNavigationStateChange = (navState: { canGoBack: boolean; canGoForward: boolean; url: string; title?: string; loading?: boolean }) => {
    setCanGoBack(navState.canGoBack);
    setCanGoForward(navState.canGoForward);
    setCurrentUrl(navState.url);
    setTitle(navState.title);
    setLoading(navState.loading);
  };

  const handleGoBack = () => {
    // If mini app has back enabled, trigger that first
    if (backEnabled) {
      triggerBack();
      return;
    }
    if (webViewRef.current && canGoBack) {
      webViewRef.current.goBack();
    }
  };

  const handleGoForward = () => {
    if (webViewRef.current && canGoForward) {
      webViewRef.current.goForward();
    }
  };

  const handleRefresh = () => {
    if (webViewRef.current) {
      webViewRef.current.reload();
    }
  };

  const handleShare = async () => {
    try {
      await Share.share({
        message: currentUrl,
        title: title,
      });
    } catch (error) {
    }
  };

  const handleOpenInBrowser = async () => {
    try {
      const canOpen = await Linking.canOpenURL(currentUrl);
      if (canOpen) {
        await Linking.openURL(currentUrl);
      }
    } catch {
      // Ignore open failures
    }
    onClose();
  };

  const styles = createStyles(theme, isDark, insets, isQNative);

  // ---------------------------------------------------------------
  // Slide / backdrop animation. We don't use RN <Modal>: the WebView
  // needs to survive minimize, and RN Modal unmounts its children when
  // `visible` flips. Instead we render a full-screen absolute overlay
  // whose translateY drives show/hide/minimize. The container's
  // `pointerEvents` flips to 'box-none' while minimized so taps fall
  // through to the app behind.
  // ---------------------------------------------------------------
  const SHEET_TOP = SCREEN_HEIGHT * 0.05;
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const shown = visible && !minimized;
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: shown ? 0 : SCREEN_HEIGHT,
        useNativeDriver: true,
        damping: 22,
        mass: 0.8,
        stiffness: 220,
      }),
      Animated.timing(backdropAnim, {
        toValue: shown ? 1 : 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, minimized, slideAnim, backdropAnim]);
  const overlayPointerEvents = minimized || !visible ? 'box-none' : 'auto';

  const getDomain = (url: string, isQNative: boolean) => {
    try {
      const domain = new URL(url).hostname;
      return domain.replace('www.', '');
    } catch {
      return url;
    }
  };

  return (
    <View
      pointerEvents={overlayPointerEvents}
      style={StyleSheet.absoluteFill}
    >
      {/* Backdrop — taps close the miniapp. Mounted-but-transparent
          when minimized so the WebView stays visible / alive
          underneath. */}
      <Animated.View
        pointerEvents={minimized ? 'none' : 'auto'}
        style={[
          StyleSheet.absoluteFillObject,
          { backgroundColor: 'rgba(0,0,0,0.5)', opacity: backdropAnim },
        ]}
      >
        <Pressable onPress={onClose} style={StyleSheet.absoluteFill} />
      </Animated.View>
      {/* Slide-up sheet. Stays in the tree across minimize so the
          WebView's RN view (and JS state) survives. */}
      <Animated.View
        style={{
          position: 'absolute',
          top: SHEET_TOP,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: theme.colors.surface1,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          overflow: 'hidden',
          transform: [{ translateY: slideAnim }],
        }}
      >
        {/* Handle bar — matches the visual cue BaseModal provided */}
        <View
          style={[
            {
              alignSelf: 'center',
              width: 36,
              height: 4,
              borderRadius: 2,
              marginTop: 6,
              marginBottom: 4,
              backgroundColor: isQNative
                ? theme.colors.info
                : theme.colors.surface3,
            },
            isQNative ? styles.handleQNative : undefined,
          ]}
        />
      {/* Browser Header */}
      <View style={[styles.header, isQNative && styles.headerQNative]}>
        <View style={styles.urlContainer}>
          <View style={styles.secureIndicator}>
            <IconSymbol
              name="lock.fill"
              size={12}
              color={isQNative ? theme.colors.info : (currentUrl.startsWith('https') ? theme.colors.success : theme.colors.textMuted)}
            />
          </View>
          <View style={styles.urlTextContainer}>
            <Text style={styles.domainText} numberOfLines={1}>
              {getDomain(currentUrl, isQNative)}
            </Text>
            {title && (
              <Text style={styles.pageTitle} numberOfLines={1}>
                {title}
              </Text>
            )}
          </View>
          {/* Wallet Indicator - shows which wallet is connected to the mini app */}
          {activeWallet && (
            <TouchableOpacity style={styles.walletIndicator} onPress={() => setShowWalletSelector(true)}>
              <View style={[styles.walletDot, activeType === 'warpcast' && styles.walletDotWarpcast]} />
              <Text style={styles.walletIndicatorText}>
                {activeWallet.address.slice(0, 4)}...{activeWallet.address.slice(-3)}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <IconSymbol name="xmark.circle.fill" size={24} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Loading indicator */}
      {loading && !showSplash && (
        <View style={styles.loadingBar}>
          <View style={styles.loadingProgress} />
        </View>
      )}

      {/* WebView - only render when bridge is ready to ensure SDK is exposed before page loads */}
      <View style={styles.webViewContainer}>
        {bridgeReady && sourceReady && (
          <WebView
            key={revision}
            ref={webViewRef}
            source={{ uri: currentUrl }}
            onNavigationStateChange={handleNavigationStateChange}
            onMessage={handleWebViewMessage}
            injectedJavaScript={injectedJavaScript}
            startInLoadingState
            renderLoading={() => (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
              </View>
            )}
            renderError={(errorDomain, errorCode, errorDesc) => (
              <View style={styles.errorContainer}>
                <IconSymbol name="exclamationmark.triangle.fill" size={48} color={theme.colors.warning} />
                <Text style={styles.errorTitle}>Failed to Load</Text>
                <Text style={styles.errorDescription}>
                  {errorDesc || `Error ${errorCode}`}
                </Text>
                <TouchableOpacity
                  style={styles.retryButton}
                  onPress={handleRefresh}
                >
                  <Text style={styles.retryButtonText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}
            style={styles.webView}
            // User agent - use "warpcast" for Farcaster mini app compatibility
            userAgent="warpcast"
            // Enable back/forward gestures based on mini app state
            allowsBackForwardNavigationGestures={!backEnabled}
            // Security settings
            javaScriptEnabled
            domStorageEnabled
            mixedContentMode="compatibility"
            // Allow bypassing SSL errors for LAN IPs when enabled
            ignoreSslErrorForLocalNetwork={allowInsecureLAN && isLanUrl(url)}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            // Performance
            cacheEnabled
            decelerationRate={0.998}
            nestedScrollEnabled
            bounces={false}
            overScrollMode="never"
            // Disable zoom controls (matching Farcaster)
            setBuiltInZoomControls={false}
            setDisplayZoomControls={false}
            textZoom={100}
          />
        )}

        {/* Splash Screen Overlay */}
        {showSplash && (
          <View style={styles.splashOverlay}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.splashText}>Loading app...</Text>
          </View>
        )}
      </View>

      {/* Primary Button (if set by mini app) */}
      {primaryButton && !primaryButton.hidden && (
        <View style={styles.primaryButtonContainer}>
          <TouchableOpacity
            style={[
              styles.primaryButton,
              primaryButton.disabled && styles.primaryButtonDisabled,
            ]}
            onPress={handlePrimaryButtonPress}
            disabled={primaryButton.disabled || primaryButton.loading}
          >
            {primaryButton.loading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.primaryButtonText}>{primaryButton.text}</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Navigation Bar */}
      <View style={styles.navigationBar}>
        <TouchableOpacity
          onPress={handleGoBack}
          disabled={!canGoBack && !backEnabled}
          style={styles.navButton}
        >
          <IconSymbol
            name="chevron.left"
            size={24}
            color={(canGoBack || backEnabled) ? theme.colors.textMain : theme.colors.textMuted}
          />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleGoForward}
          disabled={!canGoForward}
          style={styles.navButton}
        >
          <IconSymbol
            name="chevron.right"
            size={24}
            color={canGoForward ? theme.colors.textMain : theme.colors.textMuted}
          />
        </TouchableOpacity>

        <TouchableOpacity onPress={handleRefresh} style={styles.navButton}>
          <IconSymbol name="arrow.clockwise" size={20} color={theme.colors.textMain} />
        </TouchableOpacity>
{/* 
        <TouchableOpacity
          onPress={() => {
            if (onShowTransactionWarning) {
              const types: ('simulation-failed' | 'no-entitlements' | 'not-declared' | 'ok')[] =
                ['simulation-failed', 'no-entitlements', 'not-declared', 'ok'];
              const currentIndex = types.indexOf(warningType);
              const nextIndex = (currentIndex + 1) % types.length;
              const nextType = types[nextIndex];
              setWarningType(nextType);
              onShowTransactionWarning(nextType);
            }
          }}
          style={styles.navButton}
        >
          <IconSymbol name="exclamationmark.shield.fill" size={20} color={theme.colors.warning} />
        </TouchableOpacity> */}

        <TouchableOpacity onPress={handleShare} style={styles.navButton}>
          <IconSymbol name="square.and.arrow.up" size={20} color={theme.colors.textMain} />
        </TouchableOpacity>

        <TouchableOpacity onPress={handleOpenInBrowser} style={styles.navButton}>
          <IconSymbol name="safari" size={20} color={theme.colors.textMain} />
        </TouchableOpacity>
      </View>

      {/* Farcaster Required Modal */}
      <Modal
        visible={showFarcasterPrompt}
        transparent
        animationType="fade"
        onRequestClose={() => setShowFarcasterPrompt(false)}
      >
        <TouchableOpacity
          style={styles.farcasterModalOverlay}
          activeOpacity={1}
          onPress={() => setShowFarcasterPrompt(false)}
        >
          <View style={styles.farcasterModalContent} onStartShouldSetResponder={() => true}>
              <View style={styles.farcasterModalIcon}>
                <IconSymbol name="person.crop.circle.badge.exclamationmark" size={48} color={theme.colors.warning} />
              </View>
              <Text style={styles.farcasterModalTitle}>Farcaster Account Required</Text>
              <Text style={styles.farcasterModalMessage}>
                This app requires a Farcaster account to function properly. You can import your Farcaster account in Settings, or continue with limited functionality.
              </Text>
              <View style={styles.farcasterModalButtons}>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setShowFarcasterPrompt(false);
                    // Delay close to let modal animation complete
                    setTimeout(onClose, 100);
                  }}
                  style={styles.farcasterModalButton}
                >
                  Close App
                </Button>
                <Button
                  variant="primary"
                  onPress={() => {
                    setShowFarcasterPrompt(false);
                    // Deep-link to the account screen with a flag the
                    // screen reads to auto-open the Farcaster import
                    // (Warpcast wallet) flow.
                    setTimeout(() => {
                      onClose();
                      router.push({
                        pathname: '/(tabs)/account',
                        params: { openWarpcastImport: '1' },
                      });
                    }, 100);
                  }}
                  style={styles.farcasterModalButton}
                >
                  Go to Settings
                </Button>
              </View>
              <TouchableOpacity
                onPress={() => {
                  setShowFarcasterPrompt(false);
                  setShowSplash(false); // Also dismiss splash to show the app
                }}
                style={styles.continueAnywayButton}
              >
                <Text style={styles.continueAnywayText}>Continue Anyway</Text>
              </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Compose Cast Overlay - renders inside BaseModal to avoid modal stacking issues */}
      {composeVisible && (
        <KeyboardAvoidingView
          style={styles.composeOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          pointerEvents="box-none"
        >
          <Pressable style={styles.composeBackdrop} onPress={handleComposeCancel} />
          <View style={styles.composeModal}>
            {/* Header */}
            <View style={styles.composeHeader}>
              <TouchableOpacity onPress={handleComposeCancel} disabled={composePosting}>
                <Text style={[styles.composeCancel, composePosting && { opacity: 0.5 }]}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.composeTitle}>
                {composeParentHash ? 'Reply' : 'New Cast'}
              </Text>
              <TouchableOpacity
                onPress={handleComposePost}
                disabled={composePosting || (composeText.trim().length === 0 && composeEmbeds.length === 0) || composeText.length > MAX_CAST_LENGTH}
                style={[
                  styles.composePostButton,
                  (composePosting || (composeText.trim().length === 0 && composeEmbeds.length === 0) || composeText.length > MAX_CAST_LENGTH) && styles.composePostButtonDisabled
                ]}
              >
                {composePosting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={[
                    styles.composePostText,
                    (composeText.trim().length === 0 && composeEmbeds.length === 0) && styles.composePostTextDisabled
                  ]}>Post</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* Text Input */}
            <TextInput
              multiline
              autoFocus
              placeholder={composeParentHash ? "Write your reply..." : "What's happening?"}
              placeholderTextColor={theme.colors.textMuted}
              style={styles.composeInput}
              value={composeText}
              editable={!composePosting}
              onChangeText={setComposeText}
              maxLength={MAX_CAST_LENGTH + 50}
            />

            {/* Embeds Preview */}
            {composeEmbeds.length > 0 && (
              <ScrollView horizontal style={styles.embedsContainer} showsHorizontalScrollIndicator={false}>
                {composeEmbeds.map((embedUrl, index) => (
                  <View key={index} style={styles.embedPreview}>
                    <IconSymbol name="link" size={14} color={theme.colors.textMuted} />
                    <Text style={styles.embedText} numberOfLines={1}>{embedUrl}</Text>
                  </View>
                ))}
              </ScrollView>
            )}

            {/* Channel indicator */}
            {composeChannelKey && (
              <View style={styles.channelIndicator}>
                <IconSymbol name="number" size={14} color={theme.colors.accent} />
                <Text style={styles.channelText}>{composeChannelKey}</Text>
              </View>
            )}

            {/* Footer */}
            <View style={styles.composeFooter}>
              <Text style={[
                styles.composeCharCount,
                composeText.length > MAX_CAST_LENGTH && { color: theme.colors.danger }
              ]}>
                {composeText.length}/{MAX_CAST_LENGTH}
              </Text>
            </View>

            {/* Error */}
            {composeError && (
              <Text style={styles.composeError}>{composeError}</Text>
            )}
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Profile Overlay - shows when viewProfile is called from mini app */}
      {profileOverlay && (
        <View style={styles.overlayContainer}>
          <ProfileView
            fid={profileOverlay.fid}
            token={farcasterToken}
            theme={theme}
            onClose={() => setProfileOverlay(null)}
            onOpenThread={handleOverlayOpenThread}
            onOpenMiniApp={handleOverlayOpenMiniApp}
            onOpenProfile={handleOverlayOpenProfile}
            onOpenChannel={handleOverlayOpenChannel}
            likeStates={likeStates}
            onLikeToggle={handleLikeToggle}
          />
        </View>
      )}

      {/* Cast/Thread Overlay - shows when viewCast is called from mini app */}
      {castOverlay && (
        <View style={styles.overlayContainer}>
          <ThreadDetailView
            username={castOverlay.username}
            castHashPrefix={castOverlay.castHashPrefix}
            token={farcasterToken}
            theme={theme}
            onClose={() => setCastOverlay(null)}
            onOpenMiniApp={handleOverlayOpenMiniApp}
            onOpenProfile={handleOverlayOpenProfile}
            onOpenChannel={handleOverlayOpenChannel}
            likeStates={likeStates}
            onLikeToggle={handleLikeToggle}
            followStates={followStates}
            onFollow={handleFollow}
          />
        </View>
      )}

      {/* Wallet Selector Sheet */}
      {showWalletSelector && (
        <TouchableOpacity
          style={styles.walletSelectorBackdrop}
          activeOpacity={1}
          onPress={() => setShowWalletSelector(false)}
        >
          <View style={styles.walletSelectorSheet}>
            <View style={styles.walletSelectorHandle} />
            <Text style={styles.walletSelectorTitle}>Select Wallet</Text>
            <Text style={styles.walletSelectorSubtitle}>Choose which wallet to use with this app</Text>

            {availableWallets.map((wallet) => {
              const isActive = wallet.type === activeType;
              return (
                <TouchableOpacity
                  key={wallet.type}
                  style={[styles.walletOption, isActive && styles.walletOptionActive]}
                  onPress={() => {
                    if (!isActive) {
                      switchWallet(wallet.type);
                    }
                    setShowWalletSelector(false);
                  }}
                  disabled={isSwitching}
                >
                  <View style={[styles.walletOptionDot, wallet.type === 'warpcast' && styles.walletDotWarpcast]} />
                  <View style={styles.walletOptionInfo}>
                    <Text style={styles.walletOptionName}>
                      {wallet.type === 'warpcast' ? 'Warpcast Wallet' : 'Quorum Wallet'}
                    </Text>
                    <Text style={styles.walletOptionAddress}>
                      {wallet.address.slice(0, 8)}...{wallet.address.slice(-6)}
                    </Text>
                  </View>
                  {isActive && (
                    <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.primary} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      )}

      {/* Mini App Approval Modal - for wallet transaction/signing approvals */}
      <MiniAppApprovalModal
        visible={showApprovalModal}
        request={approvalRequest}
        onClose={handleApprovalModalClose}
      />

      {/* Swap Modal - opened by mini apps requesting token swap */}
      <SwapModal
        visible={showSwapModal}
        onClose={() => {
          setShowSwapModal(false);
          setSwapInitialBuyToken(undefined);
        }}
        initialBuyToken={swapInitialBuyToken}
      />

      {/* Send Modal - opened by mini apps requesting the send-token flow */}
      <SendModal
        visible={showSendModal}
        onClose={() => {
          setShowSendModal(false);
          // Clear the prefill so the next open from a different
          // surface (or no miniapp at all) starts fresh.
          setSendInitialAsset(null);
          setSendInitialRecipient(undefined);
          setSendInitialAmount(undefined);
        }}
        preselectedAsset={sendInitialAsset}
        initialRecipient={sendInitialRecipient}
        initialAmount={sendInitialAmount}
      />
      </Animated.View>
    </View>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets, isQNative: boolean) =>
  StyleSheet.create({
    handleQNative: {
      backgroundColor: theme.colors.info,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
    },
    header: {
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    headerQNative: {
      backgroundColor: theme.colors.info,
    },
    urlContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    secureIndicator: {
      marginRight: 8,
    },
    urlTextContainer: {
      flex: 1,
    },
    domainText: {
      fontSize: 14,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    pageTitle: {
      fontSize: 11,
      color: theme.colors.textMuted,
      marginTop: 2,
    },
    closeButton: {
      marginLeft: 8,
    },
    loadingBar: {
      height: 2,
      backgroundColor: theme.colors.surface3,
      overflow: 'hidden',
    },
    loadingProgress: {
      height: '100%',
      width: '30%',
      backgroundColor: theme.colors.primary,
    },
    webViewContainer: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    webView: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    loadingContainer: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.background,
    },
    errorContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.background,
      padding: 24,
    },
    errorTitle: {
      fontSize: 18,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginTop: 16,
      marginBottom: 8,
    },
    errorDescription: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 24,
    },
    retryButton: {
      marginTop: 12,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    retryButtonText: {
      color: theme.colors.primary,
      fontSize: 14,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    splashOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.background,
      zIndex: 10,
    },
    splashText: {
      marginTop: 16,
      fontSize: 16,
      color: theme.colors.textMuted,
    },
    primaryButtonContainer: {
      padding: 16,
      paddingBottom: 8,
      backgroundColor: theme.colors.background,
    },
    primaryButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryButtonDisabled: {
      opacity: 0.5,
    },
    primaryButtonText: {
      color: '#fff',
      fontSize: 16,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    navigationBar: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    navButton: {
      padding: 8,
    },
    farcasterModalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.85)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    farcasterModalContent: {
      backgroundColor: theme.colors.surface,
      borderRadius: 16,
      padding: 24,
      width: '100%',
      maxWidth: 340,
      alignItems: 'center',
    },
    farcasterModalIcon: {
      marginBottom: 16,
    },
    farcasterModalTitle: {
      fontSize: 18,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      textAlign: 'center',
      marginBottom: 12,
    },
    farcasterModalMessage: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 24,
    },
    farcasterModalButtons: {
      flexDirection: 'row',
      gap: 12,
      width: '100%',
    },
    farcasterModalButton: {
      flex: 1,
    },
    continueAnywayButton: {
      marginTop: 16,
      paddingVertical: 8,
    },
    continueAnywayText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textDecorationLine: 'underline',
    },
    // Compose modal styles
    composeOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 1000,
      justifyContent: 'flex-end',
    },
    composeBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    composeModal: {
      backgroundColor: theme.colors.surface1,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 20,
      paddingBottom: insets.bottom + 20,
      minHeight: 220,
    },
    composeHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 16,
    },
    composeCancel: {
      color: theme.colors.textMuted,
      fontSize: 16,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    composeTitle: {
      color: theme.colors.textMain,
      fontSize: 16,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    composePostButton: {
      backgroundColor: theme.colors.accent,
      paddingHorizontal: 20,
      paddingVertical: 8,
      borderRadius: 999,
      minWidth: 60,
      alignItems: 'center',
    },
    composePostButtonDisabled: {
      backgroundColor: theme.colors.surface4,
    },
    composePostText: {
      color: '#fff',
      fontSize: 15,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    composePostTextDisabled: {
      color: theme.colors.textMuted,
    },
    composeInput: {
      color: theme.colors.textMain,
      fontSize: 18,
      fontFamily: theme.fonts.regular.fontFamily,
      lineHeight: 24,
      minHeight: 80,
      textAlignVertical: 'top',
    },
    embedsContainer: {
      marginTop: 12,
      marginBottom: 8,
    },
    embedPreview: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      marginRight: 8,
      gap: 6,
      maxWidth: 200,
    },
    embedText: {
      color: theme.colors.textMuted,
      fontSize: 12,
      flex: 1,
    },
    channelIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 8,
    },
    channelText: {
      color: theme.colors.accent,
      fontSize: 14,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    composeFooter: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: theme.colors.surface3,
      marginTop: 12,
    },
    composeCharCount: {
      color: theme.colors.textMuted,
      fontSize: 13,
    },
    composeError: {
      color: theme.colors.danger,
      fontSize: 13,
      marginTop: 8,
    },
    // Profile/Cast overlay styles
    overlayContainer: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 1001,
      backgroundColor: theme.colors.background,
    },
    // Wallet indicator in header
    walletIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 4,
      marginLeft: 8,
      gap: 6,
    },
    walletDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.colors.primary,
    },
    walletDotWarpcast: {
      backgroundColor: '#8B5CF6', // Purple for Warpcast
    },
    walletIndicatorText: {
      fontSize: 11,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    // Wallet selector sheet
    walletSelectorBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
      zIndex: 1002,
    },
    walletSelectorSheet: {
      backgroundColor: theme.colors.surface1,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 20,
      paddingBottom: insets.bottom + 20,
    },
    walletSelectorHandle: {
      width: 36,
      height: 4,
      backgroundColor: theme.colors.surface4,
      borderRadius: 2,
      alignSelf: 'center',
      marginBottom: 16,
    },
    walletSelectorTitle: {
      fontSize: 18,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      textAlign: 'center',
      marginBottom: 4,
    },
    walletSelectorSubtitle: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginBottom: 20,
    },
    walletOption: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      gap: 12,
    },
    walletOptionActive: {
      borderWidth: 1,
      borderColor: theme.colors.primary,
    },
    walletOptionDot: {
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: theme.colors.primary,
    },
    walletOptionInfo: {
      flex: 1,
    },
    walletOptionName: {
      fontSize: 15,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    walletOptionAddress: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: 2,
    },
  });
