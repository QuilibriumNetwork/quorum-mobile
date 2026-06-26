/**
 * WarpcastWalletImportModal - Import Warpcast embedded wallet
 *
 * Opens the Farcaster wallet export WebView and handles the export flow.
 * User can then import the exported wallet to Quorum.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Clipboard from 'expo-clipboard';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import { useAuth } from '@/context';
import {
  fetchWalletRecoveryKey,
  checkWarpcastWallet,
  reportWalletExportInitiated,
} from '@/services/farcasterClient';
import {
  createSignedSiweMessage,
  toChecksumAddress,
} from '@/services/onboarding/farcasterService';
import { getFarcasterCustodyKey, getFarcasterFid } from '@/services/onboarding/secureStorage';
import { useWarpcastWallet } from '@/hooks/useWarpcastWallet';
import { deriveMultiChainKeys, deriveMultiChainKeysFromPrivateKey } from '@/services/wallet/multiChainWallet';
import * as Skin from '@/theme/skins/geometry';

const RECOVERY_WEBAPP_URL = 'https://wallet-export.farcaster.xyz/';
const WEBVIEW_ORIGIN_WHITELIST = [
  'https://wallet-export.farcaster.xyz',
  'https://auth.privy.io',
];

interface WarpcastWalletImportModalProps {
  visible: boolean;
  onClose: () => void;
  onImportSuccess?: () => void;
}

type ExportState =
  | 'loading'
  | 'ready'
  | 'exporting'
  | 'exported'
  | 'importing'
  | 'error';

export default function WarpcastWalletImportModal({
  visible,
  onClose,
  onImportSuccess,
}: WarpcastWalletImportModalProps) {
  const { theme, isDark } = useTheme();
  const { farcasterAuthToken, user } = useAuth();
  const { importWallet, availableAddress, refetch: refetchWarpcastWallet } = useWarpcastWallet();
  const fid = user?.farcaster?.fid;

  const webViewRef = useRef<WebView>(null);
  const [exportState, setExportState] = useState<ExportState>('loading');
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [exportedMnemonic, setExportedMnemonic] = useState<string | null>(null);
  const [exportedPrivateKey, setExportedPrivateKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const styles = createStyles(theme, isDark);

  // Check if user has a Warpcast wallet when modal opens
  // We already have the address from useWarpcastWallet, just use it
  useEffect(() => {
    if (visible && availableAddress) {
      setWalletAddress(availableAddress);
      setExportState('ready');
    } else if (visible && farcasterAuthToken && fid) {
      // Fallback: check again if we don't have the address cached
      const fidNum = typeof fid === 'string' ? parseInt(fid, 10) : fid;
      checkWarpcastWallet(farcasterAuthToken, fidNum).then(result => {
        if (result.hasWallet && result.address) {
          setWalletAddress(result.address);
          setExportState('ready');
        } else {
          setError('No Warpcast wallet found for your account');
          setExportState('error');
        }
      }).catch(() => {
        setError('Failed to check wallet status');
        setExportState('error');
      });
    } else if (visible) {
    }
  }, [visible, farcasterAuthToken, fid, availableAddress]);

  // Reset state when modal closes
  useEffect(() => {
    if (!visible) {
      setExportState('loading');
      setWalletAddress(null);
      setExportedMnemonic(null);
      setExportedPrivateKey(null);
      setError(null);
    }
  }, [visible]);

  // Handle messages from the WebView
  const handleWebViewMessage = useCallback(async (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'requestExport') {
        // WebView is requesting export data
        setExportState('exporting');

        const { nonce, expiresAt } = data;

        // Get custody key and FID
        const custodyKey = await getFarcasterCustodyKey();
        const fid = await getFarcasterFid();

        if (!custodyKey || !fid || !farcasterAuthToken) {
          throw new Error('Missing Farcaster credentials');
        }

        // Fetch recovery shard from Farcaster API
        const recoveryShard = await fetchWalletRecoveryKey(farcasterAuthToken);
        if (!recoveryShard) {
          throw new Error('Failed to fetch recovery key');
        }

        // Get custody address from the key
        const { deriveEthereumAddress } = await import('@/services/onboarding/farcasterService');
        // We need to reconstruct the address from the private key
        // For now, we'll use the stored custody key directly
        const custodyAddress = await getCustodyAddressFromKey(custodyKey);

        // Create and sign SIWE message
        const siwe = createSignedSiweMessage(
          'farcaster.xyz',
          RECOVERY_WEBAPP_URL,
          custodyAddress,
          custodyKey,
          fid,
          {
            nonce,
            expirationTime: expiresAt,
          }
        );

        // Report export initiation (for analytics)
        if (walletAddress && farcasterAuthToken) {
          reportWalletExportInitiated(farcasterAuthToken, walletAddress);
        }

        // Send response back to WebView
        const response = {
          type: 'exportResponse',
          siwe: {
            message: siwe.message,
            signature: siwe.signature,
            fid,
          },
          recoveryShard,
          address: custodyAddress,
        };

        webViewRef.current?.postMessage(JSON.stringify(response));
      } else if (data.type === 'requestClose') {
        // User wants to close without importing
        onClose();
      } else if (data.type === 'exportComplete') {
        // Custom event injected by our JS - export is complete
        // The mnemonic or private key should be captured
        if (data.mnemonic) {
          setExportedMnemonic(data.mnemonic);
          setExportState('exported');
        } else if (data.privateKey) {
          setExportedPrivateKey(data.privateKey);
          setExportState('exported');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
      setExportState('error');
    }
  }, [farcasterAuthToken, walletAddress, onClose]);

  // Derive custody address from private key
  const getCustodyAddressFromKey = async (privateKeyHex: string): Promise<string> => {
    const { secp256k1 } = await import('@noble/curves/secp256k1.js');
    const { keccak_256 } = await import('@noble/hashes/sha3.js');
    const { hexToBytes, bytesToHex } = await import('@noble/hashes/utils.js');

    const privateKey = hexToBytes(privateKeyHex);
    const publicKey = secp256k1.getPublicKey(privateKey, false);
    const publicKeyWithoutPrefix = publicKey.slice(1);
    const hash = keccak_256(publicKeyWithoutPrefix);
    const address = '0x' + bytesToHex(hash.slice(-20));

    return address.toLowerCase();
  };

  // Handle import button press
  const handleImport = useCallback(async () => {
    if (!walletAddress || (!exportedMnemonic && !exportedPrivateKey)) {
      return;
    }

    setExportState('importing');

    try {
      await importWallet({
        address: walletAddress,
        privateKey: exportedPrivateKey || '',
        mnemonic: exportedMnemonic || undefined,
      });

      // Refetch to update the UI state
      refetchWarpcastWallet();

      Alert.alert(
        'Wallet Imported',
        'Your Warpcast wallet has been imported to Quorum.',
        [{ text: 'OK', onPress: () => {
          onClose();
          onImportSuccess?.();
        }}]
      );
    } catch (err) {
      setError('Failed to import wallet');
      setExportState('error');
    }
  }, [walletAddress, exportedMnemonic, exportedPrivateKey, importWallet, onClose, onImportSuccess, refetchWarpcastWallet]);

  // Handle paste from clipboard
  const handlePasteFromClipboard = useCallback(async () => {
    try {
      const clipboardContent = await Clipboard.getStringAsync();
      if (!clipboardContent) {
        Alert.alert('Clipboard Empty', 'Please copy your recovery phrase or private key first.');
        return;
      }

      const trimmed = clipboardContent.trim();

      // Check for mnemonic (12-24 words)
      const words = trimmed.split(/\s+/);
      if (words.length >= 12 && words.length <= 24) {
        const isMnemonic = words.every(w => /^[a-z]+$/.test(w));
        if (isMnemonic) {
          try {
            // Derive Ethereum address from mnemonic
            const keys = deriveMultiChainKeys(words);
            const ethAddress = keys.ethereum.address;
            const ethPrivateKey = keys.ethereum.privateKey;
            setWalletAddress(ethAddress);
            setExportedMnemonic(trimmed);
            setExportedPrivateKey(ethPrivateKey);
            setExportState('exported');
            return;
          } catch (deriveErr) {
            Alert.alert('Invalid Mnemonic', 'Could not derive wallet from the recovery phrase.');
            return;
          }
        }
      }

      // Check for private key (0x followed by 64 hex chars)
      const pkMatch = trimmed.match(/^(0x)?[a-fA-F0-9]{64}$/);
      if (pkMatch) {
        const privateKey = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
        try {
          // Derive Ethereum address from private key
          const keys = deriveMultiChainKeysFromPrivateKey(privateKey);
          const ethAddress = keys.ethereum.address;
          setWalletAddress(ethAddress);
          setExportedPrivateKey(privateKey);
          setExportState('exported');
          return;
        } catch (deriveErr) {
          Alert.alert('Invalid Key', 'Could not derive wallet from the private key.');
          return;
        }
      }

      Alert.alert(
        'Invalid Format',
        'The clipboard content doesn\'t appear to be a valid recovery phrase (12-24 words) or private key.',
      );
    } catch (err) {
      Alert.alert('Error', 'Failed to read from clipboard');
    }
  }, []);

  // JS to inject into WebView to capture exported wallet data
  const injectedJS = `
    (function() {
      // Monitor for mnemonic or private key display
      const observer = new MutationObserver((mutations) => {
        // Look for elements that might contain the mnemonic/private key
        const textElements = document.querySelectorAll('p, span, div, code, pre');
        for (const el of textElements) {
          const text = el.textContent || '';

          // Check for mnemonic (12-24 words)
          const words = text.trim().split(/\\s+/);
          if (words.length >= 12 && words.length <= 24) {
            // Verify it looks like a mnemonic (lowercase words)
            const isMnemonic = words.every(w => /^[a-z]+$/.test(w));
            if (isMnemonic) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'exportComplete',
                mnemonic: text.trim()
              }));
              observer.disconnect();
              return;
            }
          }

          // Check for private key (0x followed by 64 hex chars)
          const pkMatch = text.match(/0x[a-fA-F0-9]{64}/);
          if (pkMatch) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'exportComplete',
              privateKey: pkMatch[0]
            }));
            observer.disconnect();
            return;
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    })();
    true;
  `;

  const renderContent = () => {
    if (exportState === 'loading') {
      return (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.statusText}>Checking wallet status...</Text>
        </View>
      );
    }

    if (exportState === 'error') {
      return (
        <View style={styles.centerContainer}>
          <IconSymbol name="exclamationmark.triangle.fill" size={48} color="#F59E0B" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={onClose}>
            <Text style={styles.retryButtonText}>Close</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (exportState === 'exported') {
      return (
        <View style={styles.centerContainer}>
          <IconSymbol name="checkmark.circle.fill" size={48} color="#22C55E" />
          <Text style={styles.successTitle}>Wallet Exported</Text>
          <Text style={styles.statusText}>
            Your Warpcast wallet is ready to import to Quorum.
          </Text>
          {walletAddress && (
            <View style={styles.addressContainer}>
              <Text style={styles.addressLabel}>Wallet Address</Text>
              <Text style={styles.addressText}>
                {walletAddress.slice(0, 10)}...{walletAddress.slice(-8)}
              </Text>
            </View>
          )}
          <TouchableOpacity
            style={styles.importButton}
            onPress={handleImport}
          >
            <Text style={styles.importButtonText}>Import to Quorum</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.skipButton}
            onPress={onClose}
          >
            <Text style={styles.skipButtonText}>Maybe Later</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (exportState === 'importing') {
      return (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.statusText}>Importing wallet...</Text>
        </View>
      );
    }

    // Show WebView for export flow
    return (
      <View style={styles.webViewContainer}>
        <View style={styles.header}>
          <IconSymbol name="wallet.pass.fill" size={24} color={theme.colors.primary} />
          <Text style={styles.headerTitle}>Export Warpcast Wallet</Text>
        </View>
        <Text style={styles.infoText}>
          Copy your recovery phrase below, then tap "Paste & Import".
        </Text>
        <TouchableOpacity style={styles.pasteButton} onPress={handlePasteFromClipboard}>
          <IconSymbol name="doc.on.clipboard" size={18} color="#fff" />
          <Text style={styles.pasteButtonText}>Paste & Import</Text>
        </TouchableOpacity>
        <WebView
          ref={webViewRef}
          source={{ uri: RECOVERY_WEBAPP_URL }}
          originWhitelist={['*']}
          style={styles.webView}
          onMessage={handleWebViewMessage}
          javaScriptEnabled
          injectedJavaScript={injectedJS}
          injectedJavaScriptBeforeContentLoaded={`window.ReactNativeWebView = window.ReactNativeWebView || {}; true;`}
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          cacheEnabled
          startInLoadingState
          allowsBackForwardNavigationGestures
        />
      </View>
    );
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.85} fillHeight>
      <View style={styles.container}>
        {renderContent()}
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    centerContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: Skin.space(24),
    },
    webViewContainer: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: Skin.space(16),
      gap: Skin.space(8),
    },
    headerTitle: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    infoText: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      paddingHorizontal: Skin.space(16),
      paddingBottom: Skin.space(12),
      lineHeight: Skin.font(20),
    },
    pasteButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      padding: Skin.space(14),
      marginHorizontal: Skin.space(16),
      marginBottom: Skin.space(12),
      gap: Skin.space(8),
    },
    pasteButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
    webView: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    statusText: {
      fontSize: Skin.font(16),
      color: theme.colors.textSubtle,
      marginTop: Skin.space(16),
      textAlign: 'center',
    },
    errorText: {
      fontSize: Skin.font(16),
      color: theme.colors.danger,
      marginTop: Skin.space(16),
      textAlign: 'center',
    },
    successTitle: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginTop: Skin.space(16),
    },
    addressContainer: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      marginTop: Skin.space(24),
      width: '100%',
    },
    addressLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
      marginBottom: Skin.space(4),
    },
    addressText: {
      fontSize: Skin.font(16),
      fontFamily: 'monospace',
      color: theme.colors.textMain,
    },
    importButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      marginTop: Skin.space(24),
      width: '100%',
      alignItems: 'center',
    },
    importButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
    skipButton: {
      padding: Skin.space(16),
      marginTop: Skin.space(8),
    },
    skipButtonText: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
    },
    retryButton: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      marginTop: Skin.space(24),
      paddingHorizontal: Skin.space(32),
    },
    retryButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
  });
