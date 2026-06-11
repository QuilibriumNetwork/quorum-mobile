/**
 * QNS Payment hooks - orchestrate in-app payment flows for name registration,
 * marketplace purchases, auction payments, and offer payments.
 */

import { useState, useCallback } from 'react';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, base, optimism, arbitrum, polygon } from 'viem/chains';
import { useWalletKeys, useWallet } from '@/hooks/useWallet';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import { useWarpcastWallet } from '@/hooks/useWarpcastWallet';
import { getQNSClient, type Ownership } from '@/services/api/qnsClient';
import {
  sendERC20Transfer,
  executePermitSplitterPayment,
  QNS_TOKEN_ADDRESSES,
  QNS_CHAIN_IDS,
  QNS_CHAIN_NAMES,
  TOKEN_DECIMALS,
} from '@/services/wallet/qnsPaymentService';
import {
  generateStealthOwnership,
  stealthOwnershipToApi,
} from '@/services/onboarding/keyService';
import type { Hash, Hex } from 'viem';

const CHAIN_MAP = {
  1: mainnet,
  10: optimism,
  137: polygon,
  8453: base,
  42161: arbitrum,
} as const;

const RPC_PROXY_BASE = 'https://rpc-proxy.quorummessenger.com';
function getRpcUrl(chainId: number): string {
  return `${RPC_PROXY_BASE}/api/alchemy/${chainId}/rpc`;
}

export type RegistrationStep =
  | 'idle'
  | 'signing_message'
  | 'getting_payment_address'
  | 'sending_payment'
  | 'registering'
  | 'confirming'
  | 'success'
  | 'error';

/**
 * Hook for in-app name registration payment.
 * Orchestrates: sign message -> get payment address -> send ERC20 transfer -> register -> poll verification
 */
export function useRegistrationPayment() {
  const { refetch: fetchKeys } = useWalletKeys();
  const { activeType } = useWalletSelection();
  const { importedWallet } = useWarpcastWallet();

  const [step, setStep] = useState<RegistrationStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [registrationId, setRegistrationId] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep('idle');
    setError(null);
    setTxHash(null);
    setRegistrationId(null);
  }, []);

  const execute = useCallback(async (params: {
    name: string;
    nameType: 'username' | 'domain';
    tokenSymbol: 'wQUIL' | 'USDC';
    chainName: string;
    tokenAmount: string;
    quilibriumAddress: string;
  }): Promise<{ registrationId: string; txHash: string } | null> => {
    const { name, nameType, tokenSymbol, chainName, tokenAmount, quilibriumAddress } = params;

    try {
      setError(null);
      setTxHash(null);
      setRegistrationId(null);

      // Get private key
      let privateKey: string | null = null;
      if (activeType === 'warpcast') {
        privateKey = importedWallet?.privateKey ?? null;
      } else {
        const keysResult = await fetchKeys();
        privateKey = keysResult.data?.ethereum?.privateKey ?? null;
      }

      if (!privateKey) {
        throw new Error('Could not access wallet keys');
      }

      const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
      const account = privateKeyToAccount(formattedKey);
      const chainId = QNS_CHAIN_IDS[chainName];
      if (!chainId) throw new Error(`Unsupported chain: ${chainName}`);

      const chain = CHAIN_MAP[chainId as keyof typeof CHAIN_MAP];
      if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);

      const tokenAddress = QNS_TOKEN_ADDRESSES[chainId]?.[tokenSymbol];
      if (!tokenAddress) throw new Error(`Token ${tokenSymbol} not available on ${chainName}`);

      // Step 1: Sign the signature message
      setStep('signing_message');
      const { message } = await getQNSClient().getSignatureMessage();
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(getRpcUrl(chainId)),
      });
      const signature = await walletClient.signMessage({ message });

      // Step 2: Get payment address
      setStep('getting_payment_address');
      const paymentInfo = await getQNSClient().getPaymentAddress(
        account.address,
        signature
      );

      // Step 3: Send ERC20 transfer
      setStep('sending_payment');
      const decimals = TOKEN_DECIMALS[tokenSymbol] || 18;
      // Convert tokenAmount string to bigint wei
      const [whole = '0', fraction = ''] = tokenAmount.split('.');
      const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
      const amountWei = BigInt(whole + paddedFraction);

      const hash = await sendERC20Transfer(
        privateKey,
        chainId,
        tokenAddress,
        paymentInfo.payment_address,
        amountWei
      );
      setTxHash(hash);

      // Step 4: Generate stealth ownership and register
      setStep('registering');
      const stealth = generateStealthOwnership(quilibriumAddress);
      const ownership: Ownership = stealthOwnershipToApi(stealth);

      const registration = await getQNSClient().registerWithPayment(
        name,
        nameType,
        ownership,
        {
          txHash: hash,
          token: tokenSymbol,
          chain: chainName,
          paymentAddress: paymentInfo.payment_address,
          tokenAmount,
        }
      );
      setRegistrationId(registration.id);

      // Step 5: Wait for confirmation
      setStep('confirming');

      // Poll verification status
      let confirmed = false;
      let attempts = 0;
      const maxAttempts = 60; // 5 minutes at 5s intervals
      while (!confirmed && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
        try {
          const status = await getQNSClient().getVerificationStatus(registration.id);
          if (status.state === 'confirmed') {
            confirmed = true;
          } else if (status.state === 'failed') {
            throw new Error('Registration verification failed');
          }
        } catch (e) {
          // Keep polling on network errors
          if (attempts >= maxAttempts) throw e;
        }
      }

      if (!confirmed) {
        // Still confirming but timed out - return success since payment was sent
        setStep('success');
        return { registrationId: registration.id, txHash: hash };
      }

      setStep('success');
      return { registrationId: registration.id, txHash: hash };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Payment failed';
      setError(errorMessage);
      setStep('error');
      return null;
    }
  }, [activeType, importedWallet, fetchKeys]);

  return {
    execute,
    reset,
    step,
    isProcessing: step !== 'idle' && step !== 'success' && step !== 'error',
    error,
    txHash,
    registrationId,
  };
}

// Marketplace Buy Payment

export type MarketplaceBuyStep =
  | 'idle'
  | 'locking'
  | 'signing_permit'
  | 'sending_payment'
  | 'submitting_purchase'
  | 'confirming'
  | 'success'
  | 'error';

/**
 * Helper to get wallet private key based on active wallet type
 */
export async function getWalletPrivateKey(
  activeType: string,
  importedWallet: { privateKey?: string } | null,
  fetchKeys: () => Promise<{ data?: { ethereum?: { privateKey: string } } | null }>
): Promise<string> {
  let privateKey: string | null = null;
  if (activeType === 'warpcast') {
    privateKey = importedWallet?.privateKey ?? null;
  } else {
    const keysResult = await fetchKeys();
    privateKey = keysResult.data?.ethereum?.privateKey ?? null;
  }
  if (!privateKey) throw new Error('Could not access wallet keys');
  return privateKey;
}

/**
 * Sign the QNS payment-address signature message with the wallet's private key
 * (EIP-191 personal_sign). The server derives a deterministic payment address
 * from this signature and uses it to verify the caller owns the wallet address.
 */
export async function signQNSSignatureMessage(
  privateKey: string
): Promise<{ address: string; signature: string }> {
  const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
  const account = privateKeyToAccount(formattedKey);
  const { message } = await getQNSClient().getSignatureMessage();
  const signature = await account.signMessage({ message });
  return { address: account.address, signature };
}

/**
 * Hook for marketplace purchases via permit+splitter.
 * Orchestrates: lock listing -> sign permit -> send splitter tx -> submit purchase -> poll status
 */
export function useMarketplaceBuy() {
  const { refetch: fetchKeys } = useWalletKeys();
  const { activeType } = useWalletSelection();
  const { importedWallet } = useWarpcastWallet();

  const [step, setStep] = useState<MarketplaceBuyStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep('idle');
    setError(null);
    setTxHash(null);
  }, []);

  const execute = useCallback(async (params: {
    listingId: string;
    chainName: string;
    quilibriumAddress: string;
  }): Promise<{ txHash: string } | null> => {
    const { listingId, chainName, quilibriumAddress } = params;

    try {
      setError(null);
      setTxHash(null);

      const chainId = QNS_CHAIN_IDS[chainName];
      if (!chainId) throw new Error(`Unsupported chain: ${chainName}`);

      // Get private key
      const privateKey = await getWalletPrivateKey(activeType, importedWallet, fetchKeys);
      const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
      const account = privateKeyToAccount(formattedKey);

      // Step 1: Lock the listing
      setStep('locking');
      const chain = CHAIN_MAP[chainId as keyof typeof CHAIN_MAP];
      if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);

      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(getRpcUrl(chainId)),
      });

      // Sign a message for the lock request
      const resaleInfo = await getQNSClient().getResaleInfo();
      const lockSignature = await walletClient.signMessage({
        message: resaleInfo.signature_message,
      });

      const lockResult = await getQNSClient().lockResaleListing(
        listingId,
        account.address,
        lockSignature,
        chainName
      );

      // Step 2: Sign permit and send splitter payment
      setStep('signing_permit');
      const tokenSymbol = lockResult.price_token as 'wQUIL' | 'USDC';

      setStep('sending_payment');
      const hash = await executePermitSplitterPayment({
        privateKey,
        chainId,
        tokenSymbol,
        platformAddress: lockResult.platform_address,
        sellerAddress: lockResult.seller_address,
        feeAmount: lockResult.fee_amount,
        sellerAmount: lockResult.seller_amount,
        lockExpiresAt: lockResult.lock_expires_at,
      });
      setTxHash(hash);

      // Step 3: Submit purchase with stealth ownership
      setStep('submitting_purchase');
      const stealth = generateStealthOwnership(quilibriumAddress);
      const newOwnership: Ownership = stealthOwnershipToApi(stealth);

      await getQNSClient().submitResalePurchase(
        listingId,
        account.address,
        hash,
        chainName,
        newOwnership
      );

      // Step 4: Poll for confirmation
      setStep('confirming');
      let confirmed = false;
      let attempts = 0;
      const maxAttempts = 60;
      while (!confirmed && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
        try {
          const status = await getQNSClient().getResalePurchaseStatus(listingId);
          if (status.state === 'sold') {
            confirmed = true;
          } else if (status.state === 'failed') {
            throw new Error(status.message || 'Purchase confirmation failed');
          }
        } catch (e) {
          if (attempts >= maxAttempts) throw e;
        }
      }

      setStep('success');
      return { txHash: hash };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Purchase failed';
      setError(errorMessage);
      setStep('error');
      return null;
    }
  }, [activeType, importedWallet, fetchKeys]);

  return {
    execute,
    reset,
    step,
    isProcessing: step !== 'idle' && step !== 'success' && step !== 'error',
    error,
    txHash,
  };
}

// Auction Payment

/**
 * Hook for auction payment (after winning or instant buy)
 * Same permit+splitter flow as marketplace buy
 */
export function useAuctionPayment() {
  const { refetch: fetchKeys } = useWalletKeys();
  const { activeType } = useWalletSelection();
  const { importedWallet } = useWarpcastWallet();

  const [step, setStep] = useState<MarketplaceBuyStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep('idle');
    setError(null);
    setTxHash(null);
  }, []);

  const execute = useCallback(async (params: {
    auctionId: string;
    chainName: string;
    tokenSymbol: 'wQUIL' | 'USDC';
    platformAddress: string;
    sellerAddress: string;
    feeAmount: string;
    sellerAmount: string;
    paymentWindowEndsAt?: string;
    quilibriumAddress: string;
  }): Promise<{ txHash: string } | null> => {
    try {
      setError(null);
      setTxHash(null);

      const chainId = QNS_CHAIN_IDS[params.chainName];
      if (!chainId) throw new Error(`Unsupported chain: ${params.chainName}`);

      const privateKey = await getWalletPrivateKey(activeType, importedWallet, fetchKeys);
      const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
      const account = privateKeyToAccount(formattedKey);

      // Sign permit and send splitter payment
      setStep('signing_permit');

      setStep('sending_payment');
      const hash = await executePermitSplitterPayment({
        privateKey,
        chainId,
        tokenSymbol: params.tokenSymbol,
        platformAddress: params.platformAddress,
        sellerAddress: params.sellerAddress,
        feeAmount: params.feeAmount,
        sellerAmount: params.sellerAmount,
        lockExpiresAt: params.paymentWindowEndsAt,
      });
      setTxHash(hash);

      // Submit payment to backend
      setStep('submitting_purchase');
      const stealth = generateStealthOwnership(params.quilibriumAddress);
      const buyerOwnership: Ownership = stealthOwnershipToApi(stealth);

      await getQNSClient().submitAuctionPayment(params.auctionId, {
        buyer_address: account.address,
        tx_hash: hash,
        chain: params.chainName,
        ownership: buyerOwnership,
      });

      // Poll for confirmation
      setStep('confirming');
      let confirmed = false;
      let attempts = 0;
      const maxAttempts = 60;
      while (!confirmed && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
        try {
          const status = await getQNSClient().getAuctionPurchaseStatus(params.auctionId);
          if (status.state === 'sold') {
            confirmed = true;
          } else if (status.state === 'failed') {
            throw new Error(status.message || 'Auction payment confirmation failed');
          }
        } catch (e) {
          if (attempts >= maxAttempts) throw e;
        }
      }

      setStep('success');
      return { txHash: hash };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Payment failed';
      setError(errorMessage);
      setStep('error');
      return null;
    }
  }, [activeType, importedWallet, fetchKeys]);

  return { execute, reset, step, isProcessing: step !== 'idle' && step !== 'success' && step !== 'error', error, txHash };
}

// Offer Payment

/**
 * Hook for offer payment (after an offer is accepted)
 * Same permit+splitter flow
 */
export function useOfferPayment() {
  const { refetch: fetchKeys } = useWalletKeys();
  const { activeType } = useWalletSelection();
  const { importedWallet } = useWarpcastWallet();

  const [step, setStep] = useState<MarketplaceBuyStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep('idle');
    setError(null);
    setTxHash(null);
  }, []);

  const execute = useCallback(async (params: {
    offerId: string;
    chainName: string;
    tokenSymbol: 'wQUIL' | 'USDC';
    platformAddress: string;
    sellerAddress: string;
    feeAmount: string;
    sellerAmount: string;
    paymentWindowEndsAt?: string;
    quilibriumAddress: string;
  }): Promise<{ txHash: string } | null> => {
    try {
      setError(null);
      setTxHash(null);

      const chainId = QNS_CHAIN_IDS[params.chainName];
      if (!chainId) throw new Error(`Unsupported chain: ${params.chainName}`);

      const privateKey = await getWalletPrivateKey(activeType, importedWallet, fetchKeys);
      const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
      const account = privateKeyToAccount(formattedKey);

      setStep('signing_permit');

      setStep('sending_payment');
      const hash = await executePermitSplitterPayment({
        privateKey,
        chainId,
        tokenSymbol: params.tokenSymbol,
        platformAddress: params.platformAddress,
        sellerAddress: params.sellerAddress,
        feeAmount: params.feeAmount,
        sellerAmount: params.sellerAmount,
        lockExpiresAt: params.paymentWindowEndsAt,
      });
      setTxHash(hash);

      // Submit payment
      setStep('submitting_purchase');
      const stealth = generateStealthOwnership(params.quilibriumAddress);
      const buyerOwnership: Ownership = stealthOwnershipToApi(stealth);

      await getQNSClient().submitOfferPayment(params.offerId, {
        buyer_address: account.address,
        tx_hash: hash,
        chain: params.chainName,
        ownership: buyerOwnership,
      });

      // Poll for confirmation
      setStep('confirming');
      let confirmed = false;
      let attempts = 0;
      const maxAttempts = 60;
      while (!confirmed && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
        try {
          const status = await getQNSClient().getOfferPurchaseStatus(params.offerId);
          if (status.state === 'completed') {
            confirmed = true;
          } else if (status.state === 'failed') {
            throw new Error(status.message || 'Offer payment confirmation failed');
          }
        } catch (e) {
          if (attempts >= maxAttempts) throw e;
        }
      }

      setStep('success');
      return { txHash: hash };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Payment failed';
      setError(errorMessage);
      setStep('error');
      return null;
    }
  }, [activeType, importedWallet, fetchKeys]);

  return { execute, reset, step, isProcessing: step !== 'idle' && step !== 'success' && step !== 'error', error, txHash };
}
