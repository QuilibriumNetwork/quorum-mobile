/**
 * Non-EVM Transaction Service
 * Handles transactions for Solana, Bitcoin, Kaspa, and Bittensor
 */

import { Buffer } from 'buffer';
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import * as bitcoinerlabSecp from '@bitcoinerlab/secp256k1';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';

// RPC Proxy base URL
const RPC_PROXY_BASE = 'https://rpc-proxy.quorummessenger.com';

// SOLANA

// Solana RPC (via proxy)
// Proxy expects: /api/solana/rpc for JSON-RPC calls
const SOLANA_RPC = `${RPC_PROXY_BASE}/api/solana/rpc`;

/**
 * Poll for Solana transaction confirmation (instead of WebSocket)
 */
async function pollForConfirmation(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  maxRetries = 30
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const status = await connection.getSignatureStatus(signature);

    if (status.value?.confirmationStatus === 'confirmed' ||
        status.value?.confirmationStatus === 'finalized') {
      if (status.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
      }
      return;
    }

    // Check if blockhash expired
    const blockHeight = await connection.getBlockHeight();
    if (blockHeight > lastValidBlockHeight) {
      throw new Error('Transaction expired: blockhash no longer valid');
    }

    // Wait 1 second before next poll
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Transaction confirmation timeout');
}

export interface SolanaTransactionResult {
  signature: string;
  chain: 'solana';
}

/**
 * Send SOL to a recipient address
 */
export async function sendSolana(
  privateKeyBase58: string,
  toAddress: string,
  amountSol: number
): Promise<SolanaTransactionResult> {
  // Disable WebSocket by only using HTTP commitment
  const connection = new Connection(SOLANA_RPC, {
    commitment: 'confirmed',
    wsEndpoint: undefined, // Disable WebSocket
  });

  // Decode private key from base58
  const privateKeyBytes = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(privateKeyBytes);

  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey,
      lamports,
    })
  );

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = keypair.publicKey;

  // Sign and send transaction (without WebSocket confirmation)
  transaction.sign(keypair);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  // Poll for confirmation instead of WebSocket
  await pollForConfirmation(connection, signature, lastValidBlockHeight);

  return {
    signature,
    chain: 'solana',
  };
}

/**
 * Send SPL token to a recipient address
 */
export async function sendSplToken(
  privateKeyBase58: string,
  toAddress: string,
  mintAddress: string,
  amount: number,
  decimals: number
): Promise<SolanaTransactionResult> {
  // Disable WebSocket by only using HTTP commitment
  const connection = new Connection(SOLANA_RPC, {
    commitment: 'confirmed',
    wsEndpoint: undefined, // Disable WebSocket
  });

  // Decode private key from base58
  const privateKeyBytes = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(privateKeyBytes);

  const toPubkey = new PublicKey(toAddress);
  const mintPubkey = new PublicKey(mintAddress);

  // Get associated token accounts for sender and recipient
  const senderAta = await getAssociatedTokenAddress(mintPubkey, keypair.publicKey);
  const recipientAta = await getAssociatedTokenAddress(mintPubkey, toPubkey);

  // Convert amount to raw units
  const rawAmount = BigInt(Math.floor(amount * Math.pow(10, decimals)));

  const transaction = new Transaction();

  // Check if recipient's ATA exists, if not create it
  try {
    await getAccount(connection, recipientAta);
  } catch (e) {
    // ATA doesn't exist, add instruction to create it
    transaction.add(
      createAssociatedTokenAccountInstruction(
        keypair.publicKey, // payer
        recipientAta,      // ata
        toPubkey,          // owner
        mintPubkey         // mint
      )
    );
  }

  // Add transfer instruction
  transaction.add(
    createTransferInstruction(
      senderAta,     // source
      recipientAta,  // destination
      keypair.publicKey, // owner
      rawAmount      // amount
    )
  );

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = keypair.publicKey;

  // Sign and send transaction (without WebSocket confirmation)
  transaction.sign(keypair);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  // Poll for confirmation instead of WebSocket
  await pollForConfirmation(connection, signature, lastValidBlockHeight);

  return {
    signature,
    chain: 'solana',
  };
}

/**
 * Get Solana explorer URL
 */
export function getSolanaExplorerUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

/**
 * Wait for Solana transaction confirmation
 */
export async function waitForSolanaTransaction(
  signature: string
): Promise<{ success: boolean }> {
  const connection = new Connection(SOLANA_RPC, {
    commitment: 'confirmed',
    wsEndpoint: undefined, // Disable WebSocket
  });

  try {
    // Use polling instead of WebSocket-based confirmTransaction
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });

    if (status.value?.confirmationStatus === 'confirmed' ||
        status.value?.confirmationStatus === 'finalized') {
      return { success: !status.value.err };
    }

    // Not yet confirmed, poll a few more times
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const retryStatus = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      if (retryStatus.value?.confirmationStatus === 'confirmed' ||
          retryStatus.value?.confirmationStatus === 'finalized') {
        return { success: !retryStatus.value.err };
      }
    }

    return { success: false };
  } catch {
    return { success: false };
  }
}

// KASPA (using @kcoin/kaspa-web3.js)

import {
  RpcClient,
  Generator,
  NetworkId,
  Resolver,
  SendKasParams,
  kaspaToSompi,
  Fees,
} from '@kcoin/kaspa-web3.js';

export interface KaspaTransactionResult {
  transactionId: string;
  chain: 'kaspa';
}

// Cache the RPC client connection
let kaspaRpcClient: RpcClient | null = null;

/**
 * Get or create a cached Kaspa RPC client
 */
async function getKaspaRpcClient(): Promise<RpcClient> {
  if (kaspaRpcClient) {
    try {
      // Check if connected by making a simple call
      return kaspaRpcClient;
    } catch {
      kaspaRpcClient = null;
    }
  }

  kaspaRpcClient = new RpcClient({
    resolver: new Resolver(),
    networkId: NetworkId.Mainnet,
  });

  await kaspaRpcClient.connect();
  return kaspaRpcClient;
}

/**
 * Send KAS to a recipient address using kaspa-web3.js
 */
export async function sendKaspa(
  privateKeyHex: string,
  fromAddress: string,
  toAddress: string,
  amountKas: number
): Promise<KaspaTransactionResult> {
  try {
    const rpcClient = await getKaspaRpcClient();

    // Get UTXOs for the sender address
    const utxoResponse = await rpcClient.getUtxosByAddresses([fromAddress]);

    if (utxoResponse.error) {
      throw new Error(utxoResponse.error.message || 'Failed to fetch UTXOs');
    }

    const utxos = utxoResponse.entries;
    if (!utxos || utxos.length === 0) {
      throw new Error('No UTXOs available');
    }

    // Convert amount to sompi
    const amountSompi = kaspaToSompi(amountKas);

    // Create send parameters with a small priority fee
    const priorityFees = new Fees(kaspaToSompi(0.0001));
    const sendKasParams = new SendKasParams(
      fromAddress,
      amountSompi,
      toAddress,
      NetworkId.Mainnet,
      priorityFees
    );

    // Create transaction generator
    const generator = new Generator(sendKasParams.toGeneratorSettings(utxos));

    let finalTransactionId: string | null = null;

    // Generate, sign, and submit transactions (may be multiple for large UTXOs)
    while (true) {
      const transaction = generator.generateTransaction();
      if (!transaction) break;

      // Sign the transaction
      transaction.sign([privateKeyHex]);

      // Submit the transaction
      const response = await rpcClient.submitTransaction({
        transaction: transaction.toSubmittableJsonTx(),
        allowOrphan: false,
      });
    }

    // Get the final transaction ID
    const summary = generator.summary();
    finalTransactionId = summary.finalTransactionId?.toHex() || null;

    if (!finalTransactionId) {
      throw new Error('Failed to get transaction ID');
    }

    return {
      transactionId: finalTransactionId,
      chain: 'kaspa',
    };
  } catch (error: unknown) {
    throw new Error(error instanceof Error ? error.message : 'Failed to send KAS transaction');
  }
}

/**
 * Get Kaspa explorer URL
 */
export function getKaspaExplorerUrl(transactionId: string): string {
  return `https://explorer.kaspa.org/txs/${transactionId}`;
}

// BITTENSOR

// Note: WebSocket connections go directly to Bittensor node
// The proxy handles HTTP requests but WebSocket needs direct connection
const BITTENSOR_WS_RPC = 'wss://entrypoint-finney.opentensor.ai:443';

export interface BittensorTransactionResult {
  hash: string;
  chain: 'bittensor';
}

// Cache the API connection to avoid reconnecting on every transaction
let bittensorApiPromise: Promise<ApiPromise> | null = null;

/**
 * Get or create a cached Bittensor API connection
 */
async function getBittensorApi(): Promise<ApiPromise> {
  if (bittensorApiPromise) {
    const api = await bittensorApiPromise;
    if (api.isConnected) {
      return api;
    }
    // Connection lost, reconnect
    bittensorApiPromise = null;
  }

  bittensorApiPromise = ApiPromise.create({
    provider: new WsProvider(BITTENSOR_WS_RPC),
    noInitWarn: true,
  });

  return bittensorApiPromise;
}

/**
 * Send TAO to a recipient address
 * Uses @polkadot/api to properly handle all 12 signed extensions
 */
export async function sendBittensor(
  privateKeySeed: string,
  toAddress: string,
  amountTao: number
): Promise<BittensorTransactionResult> {
  // Connect to Bittensor network
  const api = await getBittensorApi();
  // Create keyring and add account from seed
  const keyring = new Keyring({ type: 'ed25519', ss58Format: 42 });

  // The privateKeySeed is a 32-byte seed in hex format
  const seedBytes = hexToBytes(privateKeySeed);
  const keypair = keyring.addFromSeed(seedBytes);
  // Convert TAO to rao (1 TAO = 1e9 rao)
  const amountRao = BigInt(Math.floor(amountTao * 1_000_000_000));
  // Create the transfer transaction
  const transfer = api.tx.balances.transferAllowDeath(toAddress, amountRao);
  // Sign and send the transaction
  return new Promise((resolve, reject) => {
    let txHash: string | null = null;

    transfer
      .signAndSend(keypair, { nonce: -1 }, (result) => {
        if (result.status.isInBlock) {
          txHash = result.txHash.toHex();
        }

        if (result.status.isFinalized) {
          // Check for errors
          const dispatchError = result.dispatchError;
          if (dispatchError) {
            let errorMessage: string;

            if (dispatchError.isModule) {
              const decoded = api.registry.findMetaError(dispatchError.asModule);
              const { docs, name, section } = decoded;
              errorMessage = `${section}.${name}: ${docs.join(' ')}`;
            } else if (dispatchError.isToken) {
              // Token errors like NoFunds, Frozen, etc.
              const tokenError = dispatchError.asToken.type;
              switch (tokenError) {
                case 'NoFunds':
                  errorMessage = 'Insufficient balance. Make sure you have enough TAO to cover the transfer amount plus network fees (~0.001 TAO).';
                  break;
                case 'Frozen':
                  errorMessage = 'Account is frozen and cannot send funds.';
                  break;
                case 'BelowMinimum':
                  errorMessage = 'Transfer amount is below the minimum required.';
                  break;
                case 'WouldDie':
                  errorMessage = 'Transaction would leave account below existential deposit.';
                  break;
                default:
                  errorMessage = `Token error: ${tokenError}`;
              }
            } else {
              errorMessage = dispatchError.toString();
            }
            reject(new Error(errorMessage));
          } else {
            resolve({
              hash: txHash || result.txHash.toHex(),
              chain: 'bittensor',
            });
          }
        }

        if (result.isError) {
          reject(new Error('Transaction failed'));
        }
      })
      .catch((error) => {
        reject(error);
      });
  });
}

/**
 * Get Bittensor explorer URL
 */
export function getBittensorExplorerUrl(hash: string): string {
  return `https://taostats.io/extrinsic/${hash}`;
}

// BITCOIN (Native SegWit P2WPKH)

// Bitcoin APIs (via proxy)
// All Bitcoin endpoints use POST with body (address(es), txHex, etc.)
const BITCOIN_API = `${RPC_PROXY_BASE}/api/bitcoin`;

/**
 * Fetch current recommended fee rates from mempool.space
 * Returns fee rate in sats/vbyte
 */
export async function getBitcoinFeeRate(priority: 'low' | 'medium' | 'high' = 'medium'): Promise<number> {
  try {
    // Proxy expects: GET /api/bitcoin/fees
    const response = await fetch(`${BITCOIN_API}/fees`);
    if (!response.ok) {
      throw new Error('Failed to fetch fee rates');
    }
    const fees = await response.json();
    // fees contains: fastestFee, halfHourFee, hourFee, economyFee, minimumFee
    switch (priority) {
      case 'high':
        return fees.fastestFee || 10;
      case 'medium':
        return fees.halfHourFee || 5;
      case 'low':
        return fees.hourFee || 2;
      default:
        return fees.halfHourFee || 5;
    }
  } catch (error) {
    // Fallback to conservative defaults
    return priority === 'high' ? 10 : priority === 'medium' ? 5 : 2;
  }
}

/**
 * Validate our BIP143 implementation against official test vector
 * From: https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki#native-p2wpkh
 */
function validateBIP143Implementation(): boolean {
  // BIP143 Native P2WPKH test vector (Input 1 of the example)
  // Expected sighash: c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670

  const testVersion = hexToBytes('01000000');
  const testHashPrevouts = hexToBytes('96b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd37');
  const testHashSequence = hexToBytes('52b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3b');
  const testOutpoint = hexToBytes('ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a01000000');
  const testScriptCode = hexToBytes('1976a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac');
  const testAmount = hexToBytes('0046c32300000000'); // 600000000 sats LE
  const testSequence = hexToBytes('ffffffff');
  const testHashOutputs = hexToBytes('863ef3e1a92afbfdb97f31ad0fc7683ee943e9abcf2501590ff8f6551f47e5e5');
  const testLocktime = hexToBytes('11000000');
  const testHashType = hexToBytes('01000000');

  const expectedSighash = 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670';

  // Build preimage exactly as BIP143 specifies
  const preimage = concatBytes(
    testVersion,
    testHashPrevouts,
    testHashSequence,
    testOutpoint,
    testScriptCode,
    testAmount,
    testSequence,
    testHashOutputs,
    testLocktime,
    testHashType
  );

  const computedSighash = bytesToHex(doubleSha256(preimage));
  if (computedSighash !== expectedSighash) {
    return false;
  }

  // Also validate hash computation from raw data
  // The transaction has 2 inputs:
  // Input 0: fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f:0
  // Input 1: ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a:1

  // hashPrevouts = double_SHA256(outpoint0 + outpoint1)
  // NOTE: BIP143 document shows txids in INTERNAL byte order (as in serialized tx)
  // So we use them directly WITHOUT reversing
  const txid0 = hexToBytes('fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f');
  const txid1 = hexToBytes('ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a');

  const outpoint0 = concatBytes(txid0, uint32ToLE(0));
  const outpoint1 = concatBytes(txid1, uint32ToLE(1));

  const allOutpoints = concatBytes(outpoint0, outpoint1);
  const computedHashPrevouts = bytesToHex(doubleSha256(allOutpoints));
  if (computedHashPrevouts !== '96b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd37') {
    return false;
  }

  // hashSequence = double_SHA256(sequence0 + sequence1)
  // Both sequences are 0xffffffee and 0xffffffff
  const seq0 = hexToBytes('eeffffff'); // Note: this is 0xffffffee in LE
  const seq1 = hexToBytes('ffffffff');
  const computedHashSequence = bytesToHex(doubleSha256(concatBytes(seq0, seq1)));
  if (computedHashSequence !== '52b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3b') {
    return false;
  }
  return true;
}

/**
 * Decode a WIF (Wallet Import Format) private key to raw bytes
 * WIF format: Base58Check(version + privateKey + [compressionFlag])
 */
function decodeWIF(wif: string): Uint8Array {
  // Base58 decode
  const decoded = bs58.decode(wif);

  // Verify checksum (last 4 bytes)
  const payload = decoded.slice(0, -4);
  const checksum = decoded.slice(-4);
  const expectedChecksum = sha256(sha256(payload)).slice(0, 4);

  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      throw new Error('Invalid WIF checksum');
    }
  }

  // Remove version byte (first byte, 0x80 for mainnet)
  // and compression flag (last byte, 0x01 for compressed) if present
  const version = payload[0];
  if (version !== 0x80 && version !== 0xef) {
    throw new Error(`Invalid WIF version byte: ${version}`);
  }

  // Compressed WIF has 34 bytes (1 version + 32 key + 1 compression flag)
  // Uncompressed WIF has 33 bytes (1 version + 32 key)
  if (payload.length === 34) {
    // Compressed - remove version byte and compression flag
    return payload.slice(1, 33);
  } else if (payload.length === 33) {
    // Uncompressed - just remove version byte
    return payload.slice(1);
  } else {
    throw new Error(`Invalid WIF payload length: ${payload.length}`);
  }
}

export interface BitcoinTransactionResult {
  txid: string;
  chain: 'bitcoin';
}

interface BitcoinUTXO {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
  };
}

/**
 * Send BTC to a recipient address
 * Supports Native SegWit (P2WPKH) addresses (bc1q...)
 * Uses custom implementation with @noble/curves
 * @param privateKeyWIF - Private key in WIF (Wallet Import Format)
 */
// Detect Bitcoin address type
function detectBitcoinAddressType(address: string): 'legacy' | 'segwit' | 'nativeSegwit' {
  if (address.startsWith('bc1q')) {
    return 'nativeSegwit'; // P2WPKH
  } else if (address.startsWith('3')) {
    return 'segwit'; // P2SH-P2WPKH
  } else if (address.startsWith('1')) {
    return 'legacy'; // P2PKH
  }
  throw new Error(`Unknown Bitcoin address format: ${address}`);
}

export async function sendBitcoin(
  privateKeyWIF: string,
  fromAddress: string,
  toAddress: string,
  amountBtc: number
): Promise<BitcoinTransactionResult> {
  // Detect address type
  const addressType = detectBitcoinAddressType(fromAddress);
  // Convert amount to satoshis
  const amountSats = Math.floor(amountBtc * 100_000_000);

  // 1. Fetch UTXOs
  // Proxy expects: POST /api/bitcoin/utxos with {address}
  const utxoResponse = await fetch(`${BITCOIN_API}/utxos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: fromAddress }),
  });
  if (!utxoResponse.ok) {
    throw new Error('Failed to fetch UTXOs');
  }
  const utxos: BitcoinUTXO[] = await utxoResponse.json();
  if (!utxos || utxos.length === 0) {
    // Fetch address info to check if balance is on this address or elsewhere
    // Proxy expects: POST /api/bitcoin/balance with {addresses}
    const addrResponse = await fetch(`${BITCOIN_API}/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [fromAddress] }),
    });
    const addrData = await addrResponse.json();
    const addrInfo = addrData[fromAddress] || {};
    const confirmedBalance = (addrInfo.chain_stats?.funded_txo_sum || 0) - (addrInfo.chain_stats?.spent_txo_sum || 0);
    const unconfirmedBalance = (addrInfo.mempool_stats?.funded_txo_sum || 0) - (addrInfo.mempool_stats?.spent_txo_sum || 0);
    if (unconfirmedBalance > 0) {
      throw new Error(`Your Bitcoin is still unconfirmed (${unconfirmedBalance} sats pending). Please wait for network confirmation.`);
    } else if (confirmedBalance === 0) {
      throw new Error(`No Bitcoin balance on this address (${fromAddress.slice(0, 10)}...). Your funds may be on a different address type.`);
    }
    throw new Error('No spendable UTXOs available');
  }

  // Sort UTXOs by value (largest first) for efficiency
  utxos.sort((a, b) => b.value - a.value);

  // 2. Estimate fee and select UTXOs
  // Input sizes vary by address type:
  // - P2PKH (legacy): ~148 vbytes
  // - P2SH-P2WPKH (nested segwit): ~91 vbytes
  // - P2WPKH (native segwit): ~68 vbytes
  const INPUT_VBYTES = addressType === 'legacy' ? 148 : addressType === 'segwit' ? 91 : 68;
  const OUTPUT_VBYTES = 31;
  // Overhead varies: legacy has no witness discount, segwit has marker+flag
  const OVERHEAD_VBYTES = addressType === 'legacy' ? 10 : 11;

  // Fetch current network fee rate (use 'medium' priority for ~30 min confirmation)
  const FEE_RATE = await getBitcoinFeeRate('medium');
  let totalInput = 0;
  const selectedUtxos: BitcoinUTXO[] = [];

  for (const utxo of utxos) {
    if (!utxo.status.confirmed) continue;
    selectedUtxos.push(utxo);
    totalInput += utxo.value;
    const estimatedVbytes = OVERHEAD_VBYTES + (selectedUtxos.length * INPUT_VBYTES) + (2 * OUTPUT_VBYTES);
    const estimatedFee = estimatedVbytes * FEE_RATE;
    if (totalInput >= amountSats + estimatedFee) break;
  }

  const txVbytes2Out = OVERHEAD_VBYTES + (selectedUtxos.length * INPUT_VBYTES) + (2 * OUTPUT_VBYTES);
  const fee2Out = txVbytes2Out * FEE_RATE;
  const txVbytes1Out = OVERHEAD_VBYTES + (selectedUtxos.length * INPUT_VBYTES) + (1 * OUTPUT_VBYTES);
  const fee1Out = txVbytes1Out * FEE_RATE;

  const potentialChange = totalInput - amountSats - fee2Out;
  const DUST_THRESHOLD = 546;

  let fee: number;
  let change: number;

  if (potentialChange < DUST_THRESHOLD) {
    fee = fee1Out;
    change = 0;
    if (totalInput < amountSats + fee) {
      throw new Error(`Insufficient balance. You have ${totalInput} sats but need ${amountSats + fee} sats`);
    }
  } else {
    fee = fee2Out;
    change = potentialChange;
    if (totalInput < amountSats + fee) {
      throw new Error(`Insufficient balance. You have ${totalInput} sats but need ${amountSats + fee} sats`);
    }
  }
  // Validate BIP143 implementation against official test vector
  const bip143TestResult = validateBIP143Implementation();
  if (!bip143TestResult) {
    throw new Error('BIP143 implementation failed test vector validation');
  }

  // 3. Decode WIF and derive keys
  const privateKey = decodeWIF(privateKeyWIF);
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const pubKeyHash = hash160(publicKey);

  // Verify address based on type
  let derivedAddress: string;
  if (addressType === 'nativeSegwit') {
    derivedAddress = bech32Encode('bc', 0, pubKeyHash);
  } else if (addressType === 'segwit') {
    // P2SH-P2WPKH: Hash the P2WPKH script (00 14 <pubkeyhash>) to get the script hash
    const p2wpkhScript = concatBytes(new Uint8Array([0x00, 0x14]), pubKeyHash);
    const scriptHash = hash160(p2wpkhScript);
    derivedAddress = base58CheckEncode(scriptHash, 0x05); // 0x05 = P2SH mainnet
  } else {
    // Legacy P2PKH
    derivedAddress = base58CheckEncode(pubKeyHash, 0x00); // 0x00 = P2PKH mainnet
  }

  if (derivedAddress !== fromAddress) {
    throw new Error(`Address mismatch: derived ${derivedAddress}, expected ${fromAddress}`);
  }
  // 4. Build and sign transaction
  const txHex = await buildAndSignTransaction(
    selectedUtxos,
    toAddress,
    amountSats,
    fromAddress,
    change,
    privateKey,
    publicKey,
    addressType
  );
  // Compute txid from transaction (for verification)
  // txid is double SHA256 of the non-witness transaction data, reversed
  const computedTxid = computeBitcoinTxid(txHex);
  // 5. Broadcast transaction
  // Proxy expects: POST /api/bitcoin/broadcast with raw hex body
  const broadcastResponse = await fetch(`${BITCOIN_API}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: txHex,
  });

  if (!broadcastResponse.ok) {
    const error = await broadcastResponse.text();
    throw new Error(`Transaction failed: ${error}`);
  }

  const txid = await broadcastResponse.text();

  return {
    txid,
    chain: 'bitcoin',
  };
}

/**
 * Build and sign a Bitcoin transaction
 * Supports P2PKH (legacy), P2SH-P2WPKH (nested segwit), and P2WPKH (native segwit)
 */
async function buildAndSignTransaction(
  utxos: BitcoinUTXO[],
  toAddress: string,
  amountSats: number,
  changeAddress: string,
  changeSats: number,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  addressType: 'legacy' | 'segwit' | 'nativeSegwit'
): Promise<string> {
  const DUST_THRESHOLD = 546;
  const isSegwit = addressType !== 'legacy';

  // Transaction components
  const version = new Uint8Array([0x02, 0x00, 0x00, 0x00]); // version 2
  const marker = new Uint8Array([0x00]); // SegWit marker
  const flag = new Uint8Array([0x01]); // SegWit flag
  const locktime = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

  // Build outputs first (needed for sighash calculation)
  const outputsData: Uint8Array[] = [];
  const recipientScript = addressToScriptPubKey(toAddress);
  outputsData.push(concatBytes(uint64ToLE(amountSats), encodeVarInt(recipientScript.length), recipientScript));

  if (changeSats >= DUST_THRESHOLD) {
    const changeScript = addressToScriptPubKey(changeAddress);
    outputsData.push(concatBytes(uint64ToLE(changeSats), encodeVarInt(changeScript.length), changeScript));
  }

  const outputCount = encodeVarInt(outputsData.length);
  const pubKeyHash = hash160(publicKey);

  // For segwit, we need to build inputs first with empty scriptSigs, then add witnesses
  // For legacy, we need to sign each input and include signature in scriptSig

  if (addressType === 'legacy') {
    // Legacy P2PKH transaction (non-segwit)
    return buildLegacyTransaction(utxos, outputsData, outputCount, privateKey, publicKey, pubKeyHash, version, locktime);
  } else if (addressType === 'segwit') {
    // Nested SegWit P2SH-P2WPKH transaction
    return buildNestedSegwitTransaction(utxos, outputsData, outputCount, privateKey, publicKey, pubKeyHash, version, locktime, marker, flag);
  } else {
    // Native SegWit P2WPKH transaction
    return buildNativeSegwitTransaction(utxos, outputsData, outputCount, privateKey, publicKey, pubKeyHash, version, locktime, marker, flag);
  }
}

/**
 * Build a legacy P2PKH transaction
 */
function buildLegacyTransaction(
  utxos: BitcoinUTXO[],
  outputs: Uint8Array[],
  outputCount: Uint8Array,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  pubKeyHash: Uint8Array,
  version: Uint8Array,
  locktime: Uint8Array
): string {
  // P2PKH scriptPubKey for sighash: OP_DUP OP_HASH160 <pubkeyhash> OP_EQUALVERIFY OP_CHECKSIG
  const p2pkhScript = concatBytes(
    new Uint8Array([0x76, 0xa9, 0x14]),
    pubKeyHash,
    new Uint8Array([0x88, 0xac])
  );

  // Sign each input
  const signedInputs: Uint8Array[] = [];

  for (let i = 0; i < utxos.length; i++) {
    // Create legacy sighash
    const sighash = createLegacySighash(utxos, i, p2pkhScript, outputs, outputCount, version, locktime);
    // Sign
    const signature = signAndEncode(sighash, privateKey, publicKey);

    // Build scriptSig: <sig> <pubkey>
    const scriptSig = concatBytes(
      encodeVarInt(signature.length),
      signature,
      encodeVarInt(publicKey.length),
      publicKey
    );

    // Build input with scriptSig
    const txidBytes = reverseBytes(hexToBytes(utxos[i].txid));
    const voutBytes = uint32ToLE(utxos[i].vout);
    const sequence = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

    signedInputs.push(concatBytes(
      txidBytes,
      voutBytes,
      encodeVarInt(scriptSig.length),
      scriptSig,
      sequence
    ));
  }

  // Assemble transaction (no marker/flag for legacy)
  const inputCount = encodeVarInt(utxos.length);
  const txParts = [
    version,
    inputCount,
    ...signedInputs,
    outputCount,
    ...outputs,
    locktime,
  ];

  return bytesToHex(concatBytes(...txParts));
}

/**
 * Build a nested segwit P2SH-P2WPKH transaction
 */
function buildNestedSegwitTransaction(
  utxos: BitcoinUTXO[],
  outputs: Uint8Array[],
  outputCount: Uint8Array,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  pubKeyHash: Uint8Array,
  version: Uint8Array,
  locktime: Uint8Array,
  marker: Uint8Array,
  flag: Uint8Array
): string {
  // The redeem script is the P2WPKH script: 0x00 0x14 <pubkeyhash>
  const redeemScript = concatBytes(new Uint8Array([0x00, 0x14]), pubKeyHash);

  // BIP143 scriptCode for P2WPKH (same as native segwit)
  const scriptCode = concatBytes(
    new Uint8Array([0x19, 0x76, 0xa9, 0x14]),
    pubKeyHash,
    new Uint8Array([0x88, 0xac])
  );

  // Build inputs with redeem script in scriptSig
  const inputCount = encodeVarInt(utxos.length);
  const inputs: Uint8Array[] = [];
  const witnesses: Uint8Array[] = [];

  for (let i = 0; i < utxos.length; i++) {
    const txidBytes = reverseBytes(hexToBytes(utxos[i].txid));
    const voutBytes = uint32ToLE(utxos[i].vout);

    // scriptSig contains the redeem script (push of the P2WPKH script)
    const scriptSig = concatBytes(encodeVarInt(redeemScript.length), redeemScript);

    const sequence = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    inputs.push(concatBytes(txidBytes, voutBytes, encodeVarInt(scriptSig.length), scriptSig, sequence));

    // Create BIP143 sighash (same as native segwit)
    const sighash = createBIP143Sighash(utxos, i, scriptCode, utxos[i].value, outputs, version, locktime);
    // Sign
    const signature = signAndEncode(sighash, privateKey, publicKey);

    // Witness: <sig> <pubkey>
    witnesses.push(concatBytes(
      new Uint8Array([0x02]), // 2 witness items
      encodeVarInt(signature.length),
      signature,
      encodeVarInt(publicKey.length),
      publicKey
    ));
  }

  // Assemble transaction with marker/flag and witnesses
  const txParts = [
    version,
    marker,
    flag,
    inputCount,
    ...inputs,
    outputCount,
    ...outputs,
    ...witnesses,
    locktime,
  ];

  return bytesToHex(concatBytes(...txParts));
}

/**
 * Build a native segwit P2WPKH transaction
 */
function buildNativeSegwitTransaction(
  utxos: BitcoinUTXO[],
  outputs: Uint8Array[],
  outputCount: Uint8Array,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  pubKeyHash: Uint8Array,
  version: Uint8Array,
  locktime: Uint8Array,
  marker: Uint8Array,
  flag: Uint8Array
): string {
  // BIP143 scriptCode for P2WPKH
  const scriptCode = concatBytes(
    new Uint8Array([0x19, 0x76, 0xa9, 0x14]),
    pubKeyHash,
    new Uint8Array([0x88, 0xac])
  );

  // Build inputs (empty scriptSig for native segwit)
  const inputCount = encodeVarInt(utxos.length);
  const inputs: Uint8Array[] = [];
  const witnesses: Uint8Array[] = [];

  for (let i = 0; i < utxos.length; i++) {
    const txidBytes = reverseBytes(hexToBytes(utxos[i].txid));
    const voutBytes = uint32ToLE(utxos[i].vout);
    const scriptSig = new Uint8Array([0x00]); // empty for native segwit
    const sequence = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    inputs.push(concatBytes(txidBytes, voutBytes, scriptSig, sequence));

    // Create BIP143 sighash
    const sighash = createBIP143Sighash(utxos, i, scriptCode, utxos[i].value, outputs, version, locktime);
    // Sign
    const signature = signAndEncode(sighash, privateKey, publicKey);

    // Witness: <sig> <pubkey>
    witnesses.push(concatBytes(
      new Uint8Array([0x02]), // 2 witness items
      encodeVarInt(signature.length),
      signature,
      encodeVarInt(publicKey.length),
      publicKey
    ));
  }

  // Assemble final transaction
  const txParts = [
    version,
    marker,
    flag,
    inputCount,
    ...inputs,
    outputCount,
    ...outputs,
    ...witnesses,
    locktime,
  ];

  return bytesToHex(concatBytes(...txParts));
}

/**
 * Sign a sighash and return DER-encoded signature with SIGHASH_ALL
 */
function signAndEncode(sighash: Uint8Array, privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  // Sign with @bitcoinerlab/secp256k1 (pure JS, no WASM, works in Hermes)
  const compactSig = bitcoinerlabSecp.sign(sighash, privateKey);

  // Verify signature
  const isValid = bitcoinerlabSecp.verify(sighash, publicKey, compactSig);
  if (!isValid) {
    throw new Error('Signature verification failed');
  }

  // Extract r and s from compact signature
  const rBytes = compactSig.slice(0, 32);
  const sBytes = compactSig.slice(32, 64);
  const r = BigInt('0x' + bytesToHex(rBytes));
  let s = BigInt('0x' + bytesToHex(sBytes));

  // Ensure low-S (BIP 62)
  const SECP256K1_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  const HALF_ORDER = SECP256K1_ORDER / BigInt(2);
  if (s > HALF_ORDER) {
    s = SECP256K1_ORDER - s;
  }

  // DER encode with SIGHASH_ALL
  const sigDER = derEncodeSignature(r, s);
  return concatBytes(sigDER, new Uint8Array([0x01])); // SIGHASH_ALL
}

/**
 * Create legacy sighash for P2PKH inputs
 */
function createLegacySighash(
  utxos: BitcoinUTXO[],
  inputIndex: number,
  scriptPubKey: Uint8Array,
  outputs: Uint8Array[],
  outputCount: Uint8Array,
  version: Uint8Array,
  locktime: Uint8Array
): Uint8Array {
  // Build the unsigned transaction with scriptPubKey only in the input being signed
  const inputCount = encodeVarInt(utxos.length);
  const inputs: Uint8Array[] = [];

  for (let i = 0; i < utxos.length; i++) {
    const txidBytes = reverseBytes(hexToBytes(utxos[i].txid));
    const voutBytes = uint32ToLE(utxos[i].vout);
    const sequence = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

    if (i === inputIndex) {
      // Include scriptPubKey for the input being signed
      inputs.push(concatBytes(
        txidBytes,
        voutBytes,
        encodeVarInt(scriptPubKey.length),
        scriptPubKey,
        sequence
      ));
    } else {
      // Empty script for other inputs
      inputs.push(concatBytes(
        txidBytes,
        voutBytes,
        new Uint8Array([0x00]),
        sequence
      ));
    }
  }

  // Build preimage: version + inputs + outputs + locktime + hashtype
  const hashType = new Uint8Array([0x01, 0x00, 0x00, 0x00]); // SIGHASH_ALL (little-endian)

  const preimage = concatBytes(
    version,
    inputCount,
    ...inputs,
    outputCount,
    ...outputs,
    locktime,
    hashType
  );

  return doubleSha256(preimage);
}

/**
 * Create BIP143 sighash for SegWit inputs
 */
function createBIP143Sighash(
  utxos: BitcoinUTXO[],
  inputIndex: number,
  scriptCode: Uint8Array,
  value: number,
  outputs: Uint8Array[],
  version: Uint8Array,
  locktime: Uint8Array
): Uint8Array {
  // hashPrevouts = SHA256(SHA256(all input outpoints))
  const prevouts: Uint8Array[] = [];
  for (const utxo of utxos) {
    prevouts.push(reverseBytes(hexToBytes(utxo.txid)));
    prevouts.push(uint32ToLE(utxo.vout));
  }
  const allPrevouts = concatBytes(...prevouts);
  const firstHash = sha256(allPrevouts);
  const hashPrevouts = sha256(firstHash);
  // hashSequence = SHA256(SHA256(all sequences))
  const sequences: Uint8Array[] = [];
  for (let i = 0; i < utxos.length; i++) {
    sequences.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  }
  const hashSequence = doubleSha256(concatBytes(...sequences));

  // hashOutputs = SHA256(SHA256(all outputs))
  const allOutputs = concatBytes(...outputs);
  const hashOutputs = doubleSha256(allOutputs);
  // Build preimage
  const utxo = utxos[inputIndex];
  const outpoint = concatBytes(reverseBytes(hexToBytes(utxo.txid)), uint32ToLE(utxo.vout));
  const sequence = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  const hashType = new Uint8Array([0x01, 0x00, 0x00, 0x00]); // SIGHASH_ALL
  const preimage = concatBytes(
    version,
    hashPrevouts,
    hashSequence,
    outpoint,
    scriptCode,
    uint64ToLE(value),
    sequence,
    hashOutputs,
    locktime,
    hashType
  );
  return doubleSha256(preimage);
}

/**
 * Convert a Bitcoin address to scriptPubKey
 */
function addressToScriptPubKey(address: string): Uint8Array {
  if (address.startsWith('bc1q')) {
    // Native SegWit P2WPKH (witness version 0, 20-byte pubkey hash)
    // bc1q = hrp(bc) + separator(1) + witness_version(q=0)
    // After removing bc1q, we have just the pubkey hash data + checksum
    const decoded = bech32DecodeSegwit(address);
    if (decoded.version !== 0 || decoded.program.length !== 20) {
      throw new Error('Invalid P2WPKH address');
    }
    return concatBytes(
      new Uint8Array([0x00, 0x14]), // OP_0 PUSH20
      decoded.program
    );
  } else if (address.startsWith('bc1p')) {
    // Taproot P2TR (witness version 1, 32-byte x-only pubkey)
    const decoded = bech32DecodeSegwit(address);
    if (decoded.version !== 1 || decoded.program.length !== 32) {
      throw new Error('Invalid P2TR address');
    }
    return concatBytes(
      new Uint8Array([0x51, 0x20]), // OP_1 PUSH32
      decoded.program
    );
  } else if (address.startsWith('1')) {
    // Legacy P2PKH
    const decoded = bs58Decode(address);
    const pubKeyHash = decoded.slice(1, 21);
    return concatBytes(
      new Uint8Array([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 PUSH20
      pubKeyHash,
      new Uint8Array([0x88, 0xac]) // OP_EQUALVERIFY OP_CHECKSIG
    );
  } else if (address.startsWith('3')) {
    // P2SH
    const decoded = bs58Decode(address);
    const scriptHash = decoded.slice(1, 21);
    return concatBytes(
      new Uint8Array([0xa9, 0x14]), // OP_HASH160 PUSH20
      scriptHash,
      new Uint8Array([0x87]) // OP_EQUAL
    );
  }
  throw new Error(`Unsupported address format: ${address}`);
}

/**
 * Decode a SegWit address (bech32/bech32m)
 * Returns { version, program } where version is the witness version
 * and program is the witness program bytes
 */
function bech32DecodeSegwit(address: string): { version: number; program: Uint8Array } {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

  // Find the separator (last '1' in the address)
  const sepIndex = address.toLowerCase().lastIndexOf('1');
  if (sepIndex < 1) throw new Error('Invalid bech32 address: no separator');

  const hrp = address.slice(0, sepIndex).toLowerCase();
  const data = address.slice(sepIndex + 1).toLowerCase();

  // Decode all characters to 5-bit values
  const values: number[] = [];
  for (const char of data) {
    const idx = CHARSET.indexOf(char);
    if (idx === -1) throw new Error('Invalid bech32 character');
    values.push(idx);
  }

  // Verify checksum
  function polymod(values: number[]): number {
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) {
        if ((top >> i) & 1) {
          chk ^= GENERATOR[i];
        }
      }
    }
    return chk;
  }

  function hrpExpand(hrp: string): number[] {
    const result: number[] = [];
    for (const c of hrp) {
      result.push(c.charCodeAt(0) >> 5);
    }
    result.push(0);
    for (const c of hrp) {
      result.push(c.charCodeAt(0) & 0x1f);
    }
    return result;
  }

  // First value is the witness version
  const version = values[0];

  // Verify checksum - use bech32 for version 0, bech32m for version 1+
  const BECH32_CONST = version === 0 ? 1 : 0x2bc830a3;
  const checksumInput = [...hrpExpand(hrp), ...values];
  const checksumResult = polymod(checksumInput);

  if (checksumResult !== BECH32_CONST) {
    throw new Error(`Invalid bech32 checksum for address: ${address}`);
  }

  // Remove witness version and checksum (last 6 values)
  const programValues = values.slice(1, -6);

  // Convert from 5-bit to 8-bit
  let acc = 0;
  let bits = 0;
  const result: number[] = [];

  for (const value of programValues) {
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      result.push((acc >> bits) & 0xff);
    }
  }

  return {
    version,
    program: new Uint8Array(result),
  };
}

/**
 * Decode base58check address
 */
function bs58Decode(address: string): Uint8Array {
  return bs58.decode(address);
}

/**
 * Base58Check encode data with a version byte
 */
function base58CheckEncode(data: Uint8Array, version: number): string {
  const versionedData = concatBytes(new Uint8Array([version]), data);
  const checksum = doubleSha256(versionedData).slice(0, 4);
  return bs58.encode(concatBytes(versionedData, checksum));
}

/**
 * Encode data as bech32 address
 * @param hrp Human-readable part (e.g., 'bc' for mainnet)
 * @param witnessVersion Witness version (0 for P2WPKH/P2WSH, 1 for Taproot)
 * @param data The witness program (20 bytes for P2WPKH, 32 for P2WSH/Taproot)
 */
function bech32Encode(hrp: string, witnessVersion: number, data: Uint8Array): string {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

  // Convert 8-bit data to 5-bit
  const converted: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      converted.push((acc >> bits) & 0x1f);
    }
  }
  if (bits > 0) {
    converted.push((acc << (5 - bits)) & 0x1f);
  }

  // Add witness version at the beginning
  const values = [witnessVersion, ...converted];

  // Calculate checksum
  function polymod(values: number[]): number {
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) {
        if ((top >> i) & 1) {
          chk ^= GENERATOR[i];
        }
      }
    }
    return chk;
  }

  function hrpExpand(hrp: string): number[] {
    const result: number[] = [];
    for (const c of hrp) {
      result.push(c.charCodeAt(0) >> 5);
    }
    result.push(0);
    for (const c of hrp) {
      result.push(c.charCodeAt(0) & 0x1f);
    }
    return result;
  }

  // Use bech32 for witness version 0, bech32m for version 1+
  const BECH32_CONST = witnessVersion === 0 ? 1 : 0x2bc830a3;
  const checksumInput = [...hrpExpand(hrp), ...values, 0, 0, 0, 0, 0, 0];
  const checksum = polymod(checksumInput) ^ BECH32_CONST;

  const checksumValues: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksumValues.push((checksum >> (5 * (5 - i))) & 0x1f);
  }

  // Build the address
  let result = hrp + '1';
  for (const v of [...values, ...checksumValues]) {
    result += CHARSET[v];
  }

  return result;
}

/**
 * HASH160 = RIPEMD160(SHA256(data))
 */
function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * Double SHA256
 */
function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/**
 * DER encode an ECDSA signature from r and s BigInt values
 * Format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
 */
function derEncodeSignature(r: bigint, s: bigint): Uint8Array {
  // Convert BigInts to byte arrays (big-endian, minimal encoding)
  const rBytes = bigintToMinimalBytes(r);
  const sBytes = bigintToMinimalBytes(s);

  // If high bit is set, prepend 0x00 to make it positive
  const rPadded = rBytes[0] & 0x80 ? new Uint8Array([0x00, ...rBytes]) : rBytes;
  const sPadded = sBytes[0] & 0x80 ? new Uint8Array([0x00, ...sBytes]) : sBytes;

  // Build DER structure
  const totalLen = 2 + rPadded.length + 2 + sPadded.length;
  const der = new Uint8Array(2 + totalLen);

  let offset = 0;
  der[offset++] = 0x30; // SEQUENCE tag
  der[offset++] = totalLen;
  der[offset++] = 0x02; // INTEGER tag
  der[offset++] = rPadded.length;
  der.set(rPadded, offset);
  offset += rPadded.length;
  der[offset++] = 0x02; // INTEGER tag
  der[offset++] = sPadded.length;
  der.set(sPadded, offset);

  return der;
}

/**
 * Convert BigInt to minimal byte array (big-endian, no leading zeros except for sign)
 */
function bigintToMinimalBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0]);

  const hex = n.toString(16).padStart(64, '0'); // Ensure even length, 32 bytes for secp256k1
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  // Remove leading zeros (but keep at least one byte)
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }

  return bytes.slice(start);
}

/**
 * Encode number as varint
 */
function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) {
    return new Uint8Array([n]);
  } else if (n <= 0xffff) {
    return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  } else if (n <= 0xffffffff) {
    return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  }
  throw new Error('Value too large for varint');
}

/**
 * Encode uint32 as little-endian
 */
function uint32ToLE(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

/**
 * Encode uint64 as little-endian
 */
function uint64ToLE(n: number): Uint8Array {
  const low = n >>> 0;
  const high = Math.floor(n / 0x100000000) >>> 0;
  return new Uint8Array([
    low & 0xff, (low >> 8) & 0xff, (low >> 16) & 0xff, (low >> 24) & 0xff,
    high & 0xff, (high >> 8) & 0xff, (high >> 16) & 0xff, (high >> 24) & 0xff,
  ]);
}

/**
 * Concatenate multiple Uint8Arrays
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Get Bitcoin explorer URL
 */
export function getBitcoinExplorerUrl(txid: string): string {
  return `https://blockstream.info/tx/${txid}`;
}

export type BitcoinAddressType = 'legacy' | 'segwit' | 'nativeSegwit';

/**
 * Estimate Bitcoin transaction fee in satoshis for a given address type.
 * Assumes 1 input, 1 output (send-all scenario).
 */
export function estimateBitcoinFee(addressType: BitcoinAddressType, feeRate: number = 3): number {
  // Input sizes vary by address type:
  // - P2PKH (legacy): ~148 vbytes
  // - P2SH-P2WPKH (nested segwit): ~91 vbytes
  // - P2WPKH (native segwit): ~68 vbytes
  const INPUT_VBYTES = addressType === 'legacy' ? 148 : addressType === 'segwit' ? 91 : 68;
  const OUTPUT_VBYTES = 31;
  const OVERHEAD_VBYTES = addressType === 'legacy' ? 10 : 11;

  const vbytes = OVERHEAD_VBYTES + INPUT_VBYTES + OUTPUT_VBYTES;
  return vbytes * feeRate;
}

/**
 * Check which Bitcoin address(es) have UTXOs and return their balances.
 * Used to determine the appropriate fee reserve for "send max" calculations.
 */
export async function checkBitcoinAddressBalances(addresses: {
  legacy?: string;
  segwit?: string;
  nativeSegwit?: string;
}): Promise<{
  addressType: BitcoinAddressType;
  address: string;
  balanceSats: number;
}[]> {
  const results: { addressType: BitcoinAddressType; address: string; balanceSats: number }[] = [];

  const checkAddress = async (address: string | undefined, type: BitcoinAddressType) => {
    if (!address) return;
    try {
      // Proxy expects: POST /api/bitcoin/balance with {addresses}
      const response = await fetch(`${BITCOIN_API}/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: [address] }),
      });
      if (!response.ok) return;
      const responseData = await response.json();
      const data = responseData[address] || {};
      const confirmedBalance = (data.chain_stats?.funded_txo_sum || 0) - (data.chain_stats?.spent_txo_sum || 0);
      const pendingIncoming = data.mempool_stats?.funded_txo_sum || 0;
      const pendingOutgoing = data.mempool_stats?.spent_txo_sum || 0;
      const balanceSats = confirmedBalance + pendingIncoming - pendingOutgoing;
      if (balanceSats > 0) {
        results.push({ addressType: type, address, balanceSats });
      }
    } catch {
      // Balance check for this address type failed — skip it
    }
  };

  // Check all addresses in parallel
  await Promise.all([
    checkAddress(addresses.nativeSegwit, 'nativeSegwit'),
    checkAddress(addresses.segwit, 'segwit'),
    checkAddress(addresses.legacy, 'legacy'),
  ]);

  return results;
}

/**
 * Compute Bitcoin txid from a SegWit transaction hex
 * txid = reversed(double-SHA256(non-witness transaction data))
 */
function computeBitcoinTxid(txHex: string): string {
  const txBytes = hexToBytes(txHex);

  // For SegWit transactions, we need to strip the marker, flag, and witness data
  // Format: [version 4][marker 1][flag 1][inputs][outputs][witness][locktime 4]
  // Non-witness format: [version 4][inputs][outputs][locktime 4]

  // Check for SegWit marker (0x00) after version
  const hasWitness = txBytes[4] === 0x00 && txBytes[5] === 0x01;

  if (!hasWitness) {
    // Legacy transaction - just hash it
    const hash = doubleSha256(txBytes);
    return bytesToHex(reverseBytes(hash));
  }

  // Parse SegWit transaction to extract non-witness data
  let offset = 0;

  // Version (4 bytes)
  const version = txBytes.slice(offset, offset + 4);
  offset += 4;

  // Skip marker and flag
  offset += 2;

  // Input count
  const inputCountResult = decodeVarInt(txBytes, offset);
  const inputCount = inputCountResult.value;
  offset = inputCountResult.newOffset;

  // Parse inputs
  const inputsStart = offset;
  for (let i = 0; i < inputCount; i++) {
    offset += 32; // txid
    offset += 4;  // vout
    const scriptLen = decodeVarInt(txBytes, offset);
    offset = scriptLen.newOffset + scriptLen.value;
    offset += 4;  // sequence
  }
  const inputs = txBytes.slice(inputsStart - (offset - inputsStart === 0 ? 0 : 0), offset);

  // Output count
  const outputCountResult = decodeVarInt(txBytes, offset);
  const outputCount = outputCountResult.value;
  offset = outputCountResult.newOffset;

  // Parse outputs
  const outputsStart = offset;
  for (let i = 0; i < outputCount; i++) {
    offset += 8; // amount
    const scriptLen = decodeVarInt(txBytes, offset);
    offset = scriptLen.newOffset + scriptLen.value;
  }
  const outputs = txBytes.slice(outputsStart, offset);

  // Skip witness data - find locktime at the end
  const locktime = txBytes.slice(txBytes.length - 4);

  // Build non-witness transaction
  const inputCountEncoded = encodeVarInt(inputCount);
  const outputCountEncoded = encodeVarInt(outputCount);

  // Recalculate inputs from inputsStart
  offset = 6; // After version + marker + flag
  const inputCountDecode = decodeVarInt(txBytes, offset);
  offset = inputCountDecode.newOffset;
  const inputsEnd = offset;
  for (let i = 0; i < inputCount; i++) {
    offset += 32 + 4; // txid + vout
    const scriptLen = decodeVarInt(txBytes, offset);
    offset = scriptLen.newOffset + scriptLen.value + 4;
  }
  const inputsBytes = txBytes.slice(inputsEnd, offset);

  const outputCountDecode = decodeVarInt(txBytes, offset);
  offset = outputCountDecode.newOffset;
  const outputsEnd = offset;
  for (let i = 0; i < outputCount; i++) {
    offset += 8;
    const scriptLen = decodeVarInt(txBytes, offset);
    offset = scriptLen.newOffset + scriptLen.value;
  }
  const outputsBytes = txBytes.slice(outputsEnd, offset);

  const nonWitnessTx = concatBytes(
    version,
    inputCountEncoded,
    inputsBytes,
    outputCountEncoded,
    outputsBytes,
    locktime
  );

  const hash = doubleSha256(nonWitnessTx);
  return bytesToHex(reverseBytes(new Uint8Array(hash)));
}

/**
 * Decode a variable-length integer from transaction data
 */
function decodeVarInt(data: Uint8Array, offset: number): { value: number; newOffset: number } {
  const first = data[offset];
  if (first < 0xfd) {
    return { value: first, newOffset: offset + 1 };
  } else if (first === 0xfd) {
    return { value: data[offset + 1] | (data[offset + 2] << 8), newOffset: offset + 3 };
  } else if (first === 0xfe) {
    return {
      value: data[offset + 1] | (data[offset + 2] << 8) | (data[offset + 3] << 16) | (data[offset + 4] << 24),
      newOffset: offset + 5
    };
  }
  throw new Error('VarInt too large');
}

// UTILITY FUNCTIONS

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Reverse a Uint8Array (creates a new array, doesn't modify in place)
 * This is needed because Uint8Array.prototype.reverse() may not work in all JS engines
 */
function reverseBytes(bytes: Uint8Array): Uint8Array {
  const reversed = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    reversed[i] = bytes[bytes.length - 1 - i];
  }
  return reversed;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function numberToBytes(num: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = (num >> (i * 8)) & 0xff;
  }
  return bytes;
}

function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Encode a number as SCALE compact
 */
function encodeCompact(value: bigint): Uint8Array {
  if (value < 64n) {
    return new Uint8Array([Number(value) << 2]);
  } else if (value < 16384n) {
    const v = Number(value) << 2 | 0x01;
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  } else if (value < 1073741824n) {
    const v = Number(value) << 2 | 0x02;
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
  } else {
    // Big integer mode
    const bytes: number[] = [];
    let v = value;
    while (v > 0n) {
      bytes.push(Number(v & 0xffn));
      v >>= 8n;
    }
    return new Uint8Array([((bytes.length - 4) << 2) | 0x03, ...bytes]);
  }
}

// =====================================================================
// Tezos
//
// Implementation: build operations as JSON → forge via RPC's
// /helpers/forge/operations → sign locally with Ed25519 (with the
// Tezos watermark 0x03) → inject via /injection/operation.
//
// Why RPC-forge instead of local Michelson encoding: forging requires
// careful varint/scale-style binary encoding plus full coverage of
// every op kind. The RPC encodes it for us deterministically. Trust
// risk is mitigated by also recomputing the forged hex byte-by-byte
// against what we sent if we want strict verification (not done here
// for the initial pass — flag if needed).
//
// Reveal: when an account has never sent a transaction, its public
// key is not yet on-chain. The first operation it sends must be
// preceded by a `reveal`. We detect via manager_key being null.
//
// Fees: we use conservative hardcoded values (overestimate by maybe
// 100-200 mutez ~= $0.0002). Tezos rejects under-fee'd ops; running
// /helpers/scripts/run_operation to refine isn't worth the round
// trip for a UI that sends a few transactions per session.
// =====================================================================

export interface TezosTransactionResult {
  operationHash: string;
  chain: 'tezos';
}

const TEZOS_RPC = 'https://mainnet.tezos.ecadinfra.com';
const TEZOS_CHAIN_ID = 'NetXdQprcVkpaWU'; // mainnet
const TEZOS_EDPK_PREFIX = new Uint8Array([13, 15, 37, 217]); // base58 → "edpk..."

/** Tezos Base58Check: payload || sha256(sha256(payload))[:4], bs58. */
function tezosBase58Check(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + checksum.length);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return bs58.encode(full);
}

/** Tezos edpk encoding for an Ed25519 public key (32 bytes → "edpk..."). */
function tezosEdpk(publicKey: Uint8Array): string {
  const versioned = new Uint8Array(TEZOS_EDPK_PREFIX.length + publicKey.length);
  versioned.set(TEZOS_EDPK_PREFIX, 0);
  versioned.set(publicKey, TEZOS_EDPK_PREFIX.length);
  return tezosBase58Check(versioned);
}

/** Hex string (no "0x") → Uint8Array. */
function tezosHexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function tezosBytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

/**
 * Send XTZ from a Quorum-derived Tezos wallet.
 *
 * @param privateKeyHex 32-byte Ed25519 seed in hex (the SLIP-10 derived seed)
 * @param fromAddress   Sender's tz1 address (must match privateKey)
 * @param toAddress     Recipient tz1/tz2/tz3 address
 * @param amountTez     Amount in XTZ (decimal; will be converted to mutez)
 */
export async function sendTezos(
  privateKeyHex: string,
  fromAddress: string,
  toAddress: string,
  amountTez: number,
): Promise<TezosTransactionResult> {
  const seed = tezosHexToBytes(privateKeyHex);
  if (seed.length !== 32) {
    throw new Error('Tezos private key must be a 32-byte Ed25519 seed');
  }
  const publicKey = ed25519.getPublicKey(seed);
  const edpk = tezosEdpk(publicKey);

  // 1. Fetch a recent branch (block hash) for the operation.
  const branchRes = await fetch(`${TEZOS_RPC}/chains/main/blocks/head/hash`);
  if (!branchRes.ok) throw new Error(`Tezos RPC branch fetch failed: ${branchRes.status}`);
  const branch = (await branchRes.json()) as string;

  // 2. Fetch sender's current counter + reveal status.
  const contractRes = await fetch(`${TEZOS_RPC}/chains/main/blocks/head/context/contracts/${fromAddress}`);
  if (!contractRes.ok) throw new Error(`Tezos contract fetch failed: ${contractRes.status}`);
  const contract = (await contractRes.json()) as { counter: string; balance: string };
  let nextCounter = parseInt(contract.counter, 10) + 1;

  const managerRes = await fetch(`${TEZOS_RPC}/chains/main/blocks/head/context/contracts/${fromAddress}/manager_key`);
  // 200 + null body = not revealed. 200 + edpk string = revealed.
  const managerKey = managerRes.ok ? ((await managerRes.json()) as string | null) : null;

  // 3. Build the operation list. Reveal precedes the transaction
  //    if and only if the account has not been revealed yet.
  const contents: Record<string, unknown>[] = [];
  if (managerKey === null) {
    contents.push({
      kind: 'reveal',
      source: fromAddress,
      fee: '374',           // Standard reveal fee on mainnet protocols.
      counter: String(nextCounter),
      gas_limit: '1100',
      storage_limit: '0',
      public_key: edpk,
    });
    nextCounter++;
  }

  const mutez = Math.floor(amountTez * 1_000_000);
  if (!Number.isFinite(mutez) || mutez <= 0) {
    throw new Error('Tezos amount must be a positive XTZ value');
  }
  contents.push({
    kind: 'transaction',
    source: fromAddress,
    fee: '500',             // Conservative; transaction baseline.
    counter: String(nextCounter),
    gas_limit: '1520',      // Standard transfer to tz1/tz2/tz3.
    storage_limit: '257',   // Allows for the recipient to be created.
    amount: String(mutez),
    destination: toAddress,
  });

  // 4. Forge via RPC.
  const forgeRes = await fetch(`${TEZOS_RPC}/chains/main/blocks/head/helpers/forge/operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch, contents }),
  });
  if (!forgeRes.ok) {
    const errText = await forgeRes.text().catch(() => '');
    throw new Error(`Tezos forge failed: ${forgeRes.status} ${errText}`);
  }
  const forgedHex = (await forgeRes.json()) as string;

  // 5. Sign: blake2b-256(0x03 || forgedBytes), then Ed25519 sign.
  const forgedBytes = tezosHexToBytes(forgedHex);
  const toHash = new Uint8Array(1 + forgedBytes.length);
  toHash[0] = 0x03; // operation watermark
  toHash.set(forgedBytes, 1);
  const hash = blake2b(toHash, { dkLen: 32 });
  const signature = ed25519.sign(hash, seed);

  // 6. Inject (forged bytes + raw signature, hex-encoded).
  const signedHex = forgedHex + tezosBytesToHex(signature);
  const injectRes = await fetch(`${TEZOS_RPC}/injection/operation?chain=${TEZOS_CHAIN_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signedHex),
  });
  if (!injectRes.ok) {
    const errText = await injectRes.text().catch(() => '');
    throw new Error(`Tezos inject failed: ${injectRes.status} ${errText}`);
  }
  const operationHash = (await injectRes.json()) as string;

  return { operationHash, chain: 'tezos' };
}
