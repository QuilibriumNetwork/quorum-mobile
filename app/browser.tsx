import { IconSymbol } from '@/components/ui/IconSymbol';
import { useMiniAppBridge } from '@/services/miniapp';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { getErrorMessage } from '@/utils/error';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Share, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';
import { useWalletSelection, useActiveWalletKeys } from '@/hooks/useWalletSelection';
import { useWalletKeys } from '@/hooks/useWallet';
import MiniAppApprovalModal, { ApprovalRequest } from '@/components/MiniAppApprovalModal';
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
import { simulateMiniAppTransaction } from '@/services/miniapp/txSimulationService';
import * as Skin from '@/theme/skins/geometry';

export default function BrowserScreen() {
  const { url, isQNative, name } = useLocalSearchParams<{
    url: string;
    isQNative?: string;
    name?: string;
  }>();
  const router = useRouter();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);

  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(url || '');
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState(name || '');
  const [showTransactionWarning, setShowTransactionWarning] = useState(false);
  const [warningType, setWarningType] = useState<'simulation-failed' | 'no-entitlements' | 'not-declared' | 'ok'>('simulation-failed');
  const [showSplash, setShowSplash] = useState(true);

  // Wallet state for mini app integration - uses selected wallet (builtin or warpcast)
  const { activeWallet, activeType, isLoading: walletLoading } = useWalletSelection();
  // Get private key for warpcast wallet (available immediately) or fetch for builtin
  const { privateKey: warpcastPrivateKey } = useActiveWalletKeys();
  const { refetch: fetchBuiltinKeys } = useWalletKeys();

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

  // Convert active wallet to WalletInfo format for the bridge
  // SECURITY: Only pass the address, not the private key
  const walletInfo = useMemo(() => {
    if (!activeWallet) return null;
    return {
      address: activeWallet.address,
    };
  }, [activeWallet]);

  // Wallet is ready when we have wallet info
  const walletReady = !!walletInfo;

  // Debug wallet state
  const isQNativeMode = isQNative === 'true';

  // Extract domain from URL
  const domain = useMemo(() => {
    try {
      return new URL(url || '').hostname;
    } catch {
      return url || '';
    }
  }, [url]);

  // Handle mini app close
  const handleMiniAppClose = useCallback(() => {
    router.back();
  }, [router]);

  // Handle mini app ready
  const handleMiniAppReady = useCallback(() => {
    setShowSplash(false);
  }, []);

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

          const privateKey = await getPrivateKeyForSigning();
          if (!privateKey) {
            resolve({ success: false, error: 'Wallet not available' });
            return;
          }

          try {
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
      // Run a pre-sign simulation and fold the result into the open request
      // so the approval sheet can warn (revert / insufficient native gas on
      // the tx's chain) before the user taps Confirm. Never blocks.
      void simulateMiniAppTransaction(tx).then((simulation) => {
        setApprovalRequest((prev) =>
          prev && prev.transaction === tx ? { ...prev, simulation } : prev,
        );
      });
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
  } = useMiniAppBridge({
    webViewRef,
    domain,
    url: currentUrl,
    walletInfo,
    onReady: handleMiniAppReady,
    onClose: handleMiniAppClose,
    // SECURE signing callbacks - perform signing after user approval
    onSendTransaction: handleSendTransaction,
    onSignTransaction: handleSignTransaction,
    onSignMessage: handleSignMessage,
    onSignTypedData: handleSignTypedData,
  });

  const handleNavigationStateChange = (navState: { canGoBack: boolean; canGoForward: boolean; url: string; title?: string; loading?: boolean }) => {
    setCanGoBack(navState.canGoBack);
    setCanGoForward(navState.canGoForward);
    setCurrentUrl(navState.url);
    if (navState.title && !name) {
      setTitle(navState.title);
    }
    setLoading(navState.loading ?? false);
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
    } catch {
      // User cancelled share or share sheet failed — no action needed
    }
  };

  const handleOpenInBrowser = () => {
    // In a real app, you would use Linking.openURL(currentUrl)
    // For now, we'll just go back
    router.back();
  };

  const handleShowTransactionWarning = () => {
    // Cycle through warning types for demo
    const types: ('simulation-failed' | 'no-entitlements' | 'not-declared' | 'ok')[] =
      ['simulation-failed', 'no-entitlements', 'not-declared', 'ok'];
    const currentIndex = types.indexOf(warningType);
    const nextIndex = (currentIndex + 1) % types.length;
    const nextType = types[nextIndex];
    setWarningType(nextType);
    setShowTransactionWarning(true);
  };

  // Handle primary button press
  const handlePrimaryButtonPress = useCallback(() => {
    emit('primary_button_clicked');
  }, [emit]);

  const styles = createStyles(theme, isDark, insets, isQNativeMode);

  // Extract domain from URL for display
  const getDomain = (url: string, isQNative: boolean) => {
    try {
      const domain = new URL(url).hostname;
      return isQNative ? domain.replace('www.', '').replace('swap.cow.fi', 'cowswap.q') : domain.replace('www.', '');
    } catch {
      return url;
    }
  };

  if (!url) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>No URL provided</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Browser Header */}
      <View style={[styles.header, isQNativeMode && styles.headerQNative]}>
        <View style={styles.urlContainer}>
          <TouchableOpacity onPress={() => router.back()} style={styles.closeButton}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMain} />
          </TouchableOpacity>

          <View style={styles.secureIndicator}>
            <IconSymbol
              name="lock.fill"
              size={12}
              color={isQNativeMode ? theme.colors.info : (currentUrl.startsWith('https') ? theme.colors.success : theme.colors.textMuted)}
            />
          </View>
          <View style={styles.urlTextContainer}>
            <Text style={styles.domainText} numberOfLines={1}>
              {name || getDomain(currentUrl, isQNativeMode)}
            </Text>
            {title && title !== name && (
              <Text style={styles.pageTitle} numberOfLines={1}>
                {getDomain(currentUrl, isQNativeMode)}
              </Text>
            )}
          </View>

          <TouchableOpacity onPress={handleRefresh} style={styles.headerButton}>
            <IconSymbol name="arrow.clockwise" size={18} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Loading indicator */}
      {loading && !showSplash && (
        <View style={styles.loadingBar}>
          <View style={styles.loadingProgress} />
        </View>
      )}

      {/* WebView - only render when wallet is ready to ensure provider is available */}
      <View style={styles.webViewContainer}>
        {walletReady ? (
        <WebView
          ref={webViewRef}
          source={{ uri: currentUrl }}
          onNavigationStateChange={handleNavigationStateChange}
          onMessage={(e) => {
            // Handle incoming messages from WebView
            try {
              const data = JSON.parse(e.nativeEvent.data);
              if (data.type === '__CONSOLE__') {
                return; // Don't pass console messages to Comlink
              }
              if (data.type === '__NETWORK__') {
                return; // Don't pass network messages to Comlink
              }
            } catch {
              // Not JSON, pass through to Comlink
            }
            onMessage(e);
          }}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
            </View>
          )}
          style={styles.webView}
          // Inject console log interceptor and network request logger
          injectedJavaScript={`
            (function() {
              if (window.__interceptorsInitialized) return;
              window.__interceptorsInitialized = true;

              function sendToRN(type, data) {
                try {
                  window.ReactNativeWebView.postMessage(JSON.stringify({ type, ...data }));
                } catch (e) {}
              }

              // Fetch interception
              const originalFetch = window.fetch;
              window.fetch = async function(input, init) {
                const url = typeof input === 'string' ? input : input.url;
                const method = init?.method || 'GET';
                const body = init?.body;

                sendToRN('__NETWORK__', {
                  direction: 'request',
                  method,
                  url,
                  body: body ? (typeof body === 'string' ? body.substring(0, 1000) : '[non-string body]') : null,
                });

                try {
                  const response = await originalFetch.apply(this, arguments);
                  const clonedResponse = response.clone();

                  clonedResponse.text().then(text => {
                    sendToRN('__NETWORK__', {
                      direction: 'response',
                      method,
                      url,
                      status: response.status,
                      body: text.substring(0, 2000),
                    });
                  }).catch(() => {});

                  return response;
                } catch (error) {
                  sendToRN('__NETWORK__', {
                    direction: 'error',
                    method,
                    url,
                    error: getErrorMessage(error),
                  });
                  throw error;
                }
              };

              // XMLHttpRequest interception
              const originalXHR = window.XMLHttpRequest;
              window.XMLHttpRequest = function() {
                const xhr = new originalXHR();
                const originalOpen = xhr.open;
                const originalSend = xhr.send;
                let method, url;

                xhr.open = function(m, u) {
                  method = m;
                  url = u;
                  sendToRN('__NETWORK__', { direction: 'request', method, url, type: 'xhr' });
                  return originalOpen.apply(this, arguments);
                };

                xhr.send = function(body) {
                  xhr.addEventListener('load', function() {
                    sendToRN('__NETWORK__', {
                      direction: 'response',
                      method,
                      url,
                      status: xhr.status,
                      body: xhr.responseText.substring(0, 2000),
                      type: 'xhr',
                    });
                  });
                  xhr.addEventListener('error', function() {
                    sendToRN('__NETWORK__', { direction: 'error', method, url, type: 'xhr' });
                  });
                  return originalSend.apply(this, arguments);
                };

                return xhr;
              };
            })();
            true;
          `}
          // Enable back/forward gestures based on mini app state
          allowsBackForwardNavigationGestures={!backEnabled}
          // Security settings
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="compatibility"
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          // Performance
          cacheEnabled
          decelerationRate={0.998}
          nestedScrollEnabled
          bounces={false}
          overScrollMode="never"
          // Set user agent for mini app detection
          userAgent="quorum-mobile"
        />
        ) : (
          <View style={styles.splashOverlay}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.splashText}>Preparing wallet...</Text>
          </View>
        )}

        {/* Splash Screen Overlay */}
        {walletReady && showSplash && (
          <View style={styles.splashOverlay}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.splashText}>Loading {name || 'app'}...</Text>
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
{/* 
        <TouchableOpacity onPress={handleShowTransactionWarning} style={styles.navButton}>
          <IconSymbol name="exclamationmark.shield.fill" size={20} color={theme.colors.warning} />
        </TouchableOpacity> */}

        <TouchableOpacity onPress={handleShare} style={styles.navButton}>
          <IconSymbol name="square.and.arrow.up" size={20} color={theme.colors.textMain} />
        </TouchableOpacity>

        <TouchableOpacity onPress={handleOpenInBrowser} style={styles.navButton}>
          <IconSymbol name="safari" size={20} color={theme.colors.textMain} />
        </TouchableOpacity>
      </View>

      {/* Transaction Warning Modal
      <TransactionWarningModal
        visible={showTransactionWarning}
        onClose={() => setShowTransactionWarning(false)}
        onProceed={() => {
          setShowTransactionWarning(false);
        }}
        warningType={warningType}
        transactionData={{
          to: '0xCe4Eb76664210426e900C20D4A3741A6b0f64855',
          value: '0.1 ETH',
          gas: '21,000',
          function: 'transfer(address,uint256)',
        }}
      /> */}

      {/* Mini App Approval Modal for wallet transactions and signing */}
      <MiniAppApprovalModal
        visible={showApprovalModal}
        request={approvalRequest}
        onClose={handleApprovalModalClose}
      />
    </View>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets, isQNative: boolean) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
      paddingTop: insets.top,
    },
    errorContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: theme.colors.background,
    },
    errorText: {
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      marginBottom: Skin.space(20),
    },
    header: {
      paddingHorizontal: Skin.space(16),
      paddingBottom: Skin.space(12),
      paddingTop: Skin.space(8),
    },
    headerQNative: {
      backgroundColor: theme.colors.info,
    },
    urlContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(10),
    },
    closeButton: {
      marginRight: Skin.space(12),
      padding: Skin.space(4),
    },
    headerButton: {
      padding: Skin.space(4),
    },
    backButton: {
      marginRight: Skin.space(12),
      padding: Skin.space(4),
    },
    backButtonText: {
      color: theme.colors.primary,
      fontSize: Skin.font(16),
    },
    secureIndicator: {
      marginRight: Skin.space(8),
    },
    urlTextContainer: {
      flex: 1,
    },
    domainText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    pageTitle: {
      fontSize: Skin.font(11),
      color: theme.colors.textSubtle,
      marginTop: Skin.space(2),
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
      marginTop: Skin.space(16),
      fontSize: Skin.font(16),
      color: theme.colors.textSubtle,
    },
    primaryButtonContainer: {
      padding: Skin.space(16),
      paddingBottom: Skin.space(8),
      backgroundColor: theme.colors.background,
    },
    primaryButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(14),
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryButtonDisabled: {
      opacity: 0.5,
    },
    primaryButtonText: {
      color: '#fff',
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    navigationBar: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      paddingVertical: Skin.space(12),
      paddingBottom: Math.max(12, insets.bottom),
      borderTopWidth: Skin.border(1),
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    navButton: {
      padding: Skin.space(8),
    },
  });
