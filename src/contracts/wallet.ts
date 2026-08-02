import {
  generatePrivateKey,
  secp256k1,
  hash160,
  encodeCashAddress,
  decodeCashAddress,
  CashAddressType,
} from "@bitauth/libauth";
import { ElectrumNetworkProvider } from "cashscript";
import type { Utxo } from "cashscript";

export interface WalletKeypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array; // 33-byte compressed
  pkHash: Uint8Array; // hash160(publicKey), 20 bytes — buyerPkHash for buyTicket()
  address: string; // chipnet cashaddr (p2pkhWithTokens)
}

/**
 * Derives the full keypair (pubkey, pkHash, chipnet address) from an existing private key.
 */
export function walletFromPrivateKey(privateKey: Uint8Array): WalletKeypair {
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === "string") {
    throw new Error(`Failed to derive public key: ${publicKey}`);
  }
  const pkHash = hash160(publicKey);

  // IMPORTANT: this must be a token-aware address type (p2pkhWithTokens).
  const addressResult = encodeCashAddress({
    prefix: "bchtest", // Chipnet uses "bchtest"
    type: CashAddressType.p2pkhWithTokens,
    payload: pkHash,
    throwErrors: false,
  });
  if (typeof addressResult === "string") {
    throw new Error(`Failed to encode address: ${addressResult}`);
  }

  return { privateKey, publicKey, pkHash, address: addressResult.address };
}

/**
 * Generates a fresh random keypair.
 */
export function generateWallet(): WalletKeypair {
  return walletFromPrivateKey(generatePrivateKey());
}

/**
 * Extracts the 20-byte pubkey hash (hash160) from any chipnet cashaddr —
 * including addresses supplied by an externally-connected wallet like
 * Paytaca, where we never see the private key or public key directly.
 */
export function pkHashFromAddress(address: string): Uint8Array {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === "string") {
    throw new Error(`Failed to decode address "${address}": ${decoded}`);
  }
  return decoded.payload;
}

// --- Private Key Hex Serialization -------------------------------------

export function privateKeyToHex(privateKey: Uint8Array): string {
  return Array.from(privateKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function privateKeyFromHex(hex: string): Uint8Array {
  const cleanHex = hex.trim().replace(/^0x/, "");
  const match = cleanHex.match(/.{1,2}/g);
  if (!match || cleanHex.length % 2 !== 0) {
    throw new Error("Invalid hex string format.");
  }
  return new Uint8Array(match.map((byte) => parseInt(byte, 16)));
}

// --- Network Provider & Token UTXO Methods ----------------------------------

const provider = new ElectrumNetworkProvider("chipnet");

/**
 * Retrieves all UTXOs belonging to the specified address.
 * Works for any chipnet address — a locally generated demo wallet or a
 * connected Paytaca address — since it's just an Electrum lookup.
 */
export async function getWalletUtxos(address: string): Promise<Utxo[]> {
  return provider.getUtxos(address);
}

/**
 * Calculates spendable BCH balance (in Satoshis), filtering out Token UTXOs.
 */
export async function getWalletBalanceSats(address: string): Promise<bigint> {
  const utxos = await getWalletUtxos(address);
  return utxos
    .filter((u) => !u.token) // Exclude token UTXOs
    .reduce((sum, utxo) => sum + BigInt(utxo.satoshis), 0n);
}

// Inverse of Script-Number encoding (little-endian, sign-and-magnitude)
function scriptNumHexToNumber(hex: string): number {
  if (!hex) return 0;
  const bytes = hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16));
  let result = 0;
  for (let i = bytes.length - 1; i >= 0; i--) {
    let byte = bytes[i];
    if (i === bytes.length - 1) {
      byte &= 0x7f; // strip sign flag
    }
    result = result * 256 + byte;
  }
  return result;
}

/**
 * Retrieves all CashToken NFT tickets owned by the wallet address.
 */
export async function getWalletTickets(address: string): Promise<
  {
    utxo: Utxo;
    pickedNumber: number;
    commitmentHex: string;
  }[]
> {
  const utxos = await getWalletUtxos(address);

  return utxos
    .filter((u) => u.token && u.token.nft)
    .map((u) => {
      const commitmentHex = u.token?.nft?.commitment || "";
      return {
        utxo: u,
        pickedNumber: scriptNumHexToNumber(commitmentHex),
        commitmentHex,
      };
    });
}

// --- Demo Key Persistence & Hardcode Fallback ----------------------------------
// This local-key wallet is kept only as a fallback demo mode for testing
// without a real Paytaca wallet installed. Prefer the Paytaca WalletConnect
// flow (see paytacaConnect.ts) for real usage.

const LOCAL_STORAGE_KEY = "lottery_demo_wallet_privkey";

// 💡 Paste a 64-char funded Chipnet private key hex here for permanent demo stability
const HARDCODED_DEMO_PRIVKEY_HEX = "";

/**
 * Returns a persistent demo wallet across page reloads.
 */
export function getDemoWallet(): WalletKeypair {
  let keyHex = localStorage.getItem(LOCAL_STORAGE_KEY);

  if (!keyHex || keyHex.length !== 64) {
    if (
      HARDCODED_DEMO_PRIVKEY_HEX &&
      HARDCODED_DEMO_PRIVKEY_HEX.length === 64
    ) {
      keyHex = HARDCODED_DEMO_PRIVKEY_HEX;
    } else {
      const newKeyPair = generateWallet();
      keyHex = privateKeyToHex(newKeyPair.privateKey);
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, keyHex);
  }

  return walletFromPrivateKey(privateKeyFromHex(keyHex));
}

/**
 * Allows importing a new funded key into localStorage and returning the new wallet.
 */
export function setDemoWalletKey(hex: string): WalletKeypair {
  const cleanHex = hex.trim().replace(/^0x/, "");
  if (cleanHex.length !== 64) {
    throw new Error("Invalid private key: must be a 64-character hex string.");
  }
  localStorage.setItem(LOCAL_STORAGE_KEY, cleanHex);
  return walletFromPrivateKey(privateKeyFromHex(cleanHex));
}
