import {
  generatePrivateKey,
  secp256k1,
  hash160,
  encodeCashAddress,
  decodeCashAddress,
  CashAddressType,
} from "@bitauth/libauth";

import {
  ElectrumNetworkProvider,
} from "cashscript";

import type {
  Utxo,
} from "cashscript";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const CHIPNET_PREFIX = "bchtest";
const LOCAL_STORAGE_KEY = "lottery_demo_wallet_privkey";

/**
 * Paste a funded 64-character Chipnet private-key hex here if you want the
 * local demo wallet to always use the same private key.
 *
 * Never use a mainnet private key here.
 */
const HARDCODED_DEMO_PRIVKEY_HEX = "";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface WalletKeypair {
  /**
   * Raw 32-byte secp256k1 private key.
   */
  privateKey: Uint8Array;

  /**
   * Compressed 33-byte secp256k1 public key.
   */
  publicKey: Uint8Array;

  /**
   * hash160(publicKey), used as buyerPkHash by the CashScript contract.
   */
  pkHash: Uint8Array;

  /**
   * Complete Chipnet token-aware CashAddress.
   *
   * Example:
   * bchtest:zr...
   */
  address: string;
}

export interface WalletTicket {
  utxo: Utxo;
  pickedNumber: number;
  commitmentHex: string;
}

// -----------------------------------------------------------------------------
// Address Utilities
// -----------------------------------------------------------------------------

/**
 * Ensures that an address has the complete Chipnet "bchtest:" prefix.
 *
 * Paytaca and other wallets may return a prefixless CashAddress payload.
 *
 * Examples:
 *
 * qzabc...         -> bchtest:qzabc...
 * zqabc...         -> bchtest:zqabc...
 * bchtest:qzabc... -> bchtest:qzabc...
 */
export function normalizeChipnetAddress(
  address: string,
): string {
  if (typeof address !== "string") {
    throw new TypeError(
      "Wallet address must be a string.",
    );
  }

  const cleanedAddress = address.trim();

  if (!cleanedAddress) {
    throw new Error("Wallet address is empty.");
  }

  const lowerAddress = cleanedAddress.toLowerCase();

  // Address is already a complete Chipnet CashAddress.
  if (
    lowerAddress.startsWith(
      `${CHIPNET_PREFIX}:`,
    )
  ) {
    return lowerAddress;
  }

  // Reject mainnet addresses rather than incorrectly changing their network.
  if (
    lowerAddress.startsWith("bitcoincash:") ||
    lowerAddress.startsWith("simpleledger:")
  ) {
    throw new Error(
      `Expected a Chipnet address, but received a mainnet address: ${cleanedAddress}`,
    );
  }

  // The address contains a prefix, but it is not supported here.
  if (lowerAddress.includes(":")) {
    const suppliedPrefix =
      lowerAddress.split(":")[0];

    throw new Error(
      `Unsupported CashAddress prefix "${suppliedPrefix}". Expected "${CHIPNET_PREFIX}".`,
    );
  }

  return `${CHIPNET_PREFIX}:${lowerAddress}`;
}

/**
 * Validates and normalizes a Chipnet CashAddress.
 *
 * This confirms that the resulting address can actually be decoded rather than
 * only attaching "bchtest:" to an arbitrary string.
 */
export function validateChipnetAddress(
  address: string,
): string {
  const normalizedAddress =
    normalizeChipnetAddress(address);

  const decoded =
    decodeCashAddress(normalizedAddress);

  if (typeof decoded === "string") {
    throw new Error(
      `Invalid Chipnet address "${normalizedAddress}": ${decoded}`,
    );
  }

  return normalizedAddress;
}


/**
 * Converts a standard Chipnet P2PKH address into its token-aware equivalent.
 *
 * Examples:
 * bchtest:q... -> bchtest:z...
 * bchtest:z... -> bchtest:z...
 *
 * This is required when sending CashTokens or NFT tickets to a wallet.
 */
export function toTokenAwareChipnetAddress(
  address: string,
): string {
  const normalizedAddress =
    validateChipnetAddress(address);

  const decoded =
    decodeCashAddress(normalizedAddress);

  if (typeof decoded === "string") {
    throw new Error(
      `Failed to decode address "${normalizedAddress}": ${decoded}`,
    );
  }

  if (decoded.payload.length !== 20) {
    throw new Error(
      `Expected a 20-byte public-key hash, but received ${decoded.payload.length} bytes.`,
    );
  }

  const encodedAddress =
    encodeCashAddress({
      prefix: CHIPNET_PREFIX,
      type: CashAddressType.p2pkhWithTokens,
      payload: decoded.payload,
      throwErrors: false,
    });

  if (typeof encodedAddress === "string") {
    throw new Error(
      `Failed to create token-aware Chipnet address: ${encodedAddress}`,
    );
  }

  return normalizeChipnetAddress(
    encodedAddress.address,
  );
}

/**
 * Extracts the 20-byte payload from a Chipnet CashAddress.
 *
 * This works with:
 *
 * - Standard P2PKH Chipnet addresses
 * - Token-aware P2PKH Chipnet addresses
 * - Prefixless addresses returned by connected wallets
 */
export function pkHashFromAddress(
  address: string,
): Uint8Array {
  const normalizedAddress =
    validateChipnetAddress(address);

  const decoded =
    decodeCashAddress(normalizedAddress);

  if (typeof decoded === "string") {
    throw new Error(
      `Failed to decode address "${normalizedAddress}": ${decoded}`,
    );
  }

  if (decoded.payload.length !== 20) {
    throw new Error(
      `Expected a 20-byte public-key hash, but received ${decoded.payload.length} bytes.`,
    );
  }

  return decoded.payload;
}

// -----------------------------------------------------------------------------
// Wallet Generation
// -----------------------------------------------------------------------------

/**
 * Derives a public key, public-key hash, and token-aware Chipnet address from
 * an existing private key.
 */
export function walletFromPrivateKey(
  privateKey: Uint8Array,
): WalletKeypair {
  if (!(privateKey instanceof Uint8Array)) {
    throw new TypeError(
      "Private key must be a Uint8Array.",
    );
  }

  if (privateKey.length !== 32) {
    throw new Error(
      `Invalid private-key length. Expected 32 bytes, received ${privateKey.length}.`,
    );
  }

  const publicKey =
    secp256k1.derivePublicKeyCompressed(
      privateKey,
    );

  if (typeof publicKey === "string") {
    throw new Error(
      `Failed to derive public key: ${publicKey}`,
    );
  }

  const pkHash = hash160(publicKey);

  /**
   * Use p2pkhWithTokens because NFT ticket outputs are sent back to the
   * buyer's token-aware address.
   */
  const addressResult = encodeCashAddress({
    prefix: CHIPNET_PREFIX,
    type: CashAddressType.p2pkhWithTokens,
    payload: pkHash,
    throwErrors: false,
  });

  if (typeof addressResult === "string") {
    throw new Error(
      `Failed to encode address: ${addressResult}`,
    );
  }

  /**
   * Some versions or consumers may work with the prefixless form. Normalize it
   * here so WalletKeypair.address always contains "bchtest:".
   */
  const address = validateChipnetAddress(
    addressResult.address,
  );

  return {
    privateKey,
    publicKey,
    pkHash,
    address,
  };
}

/**
 * Generates a new random Chipnet wallet.
 */
export function generateWallet(): WalletKeypair {
  const privateKey = generatePrivateKey();

  if (typeof privateKey === "string") {
    throw new Error(
      `Failed to generate private key: ${privateKey}`,
    );
  }

  return walletFromPrivateKey(privateKey);
}

// -----------------------------------------------------------------------------
// Private-Key Hex Serialization
// -----------------------------------------------------------------------------

/**
 * Converts a 32-byte private key into a 64-character hexadecimal string.
 */
export function privateKeyToHex(
  privateKey: Uint8Array,
): string {
  if (!(privateKey instanceof Uint8Array)) {
    throw new TypeError(
      "Private key must be a Uint8Array.",
    );
  }

  if (privateKey.length !== 32) {
    throw new Error(
      `Invalid private-key length. Expected 32 bytes, received ${privateKey.length}.`,
    );
  }

  return Array.from(privateKey)
    .map((byte) =>
      byte.toString(16).padStart(2, "0"),
    )
    .join("");
}

/**
 * Converts a 64-character private-key hex string into a 32-byte Uint8Array.
 */
export function privateKeyFromHex(
  hex: string,
): Uint8Array {
  if (typeof hex !== "string") {
    throw new TypeError(
      "Private-key hex must be a string.",
    );
  }

  const cleanHex = hex
    .trim()
    .replace(/^0x/i, "");

  if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
    throw new Error(
      "Invalid private key: expected exactly 64 hexadecimal characters.",
    );
  }

  const privateKey = new Uint8Array(32);

  for (
    let index = 0;
    index < privateKey.length;
    index++
  ) {
    privateKey[index] = Number.parseInt(
      cleanHex.slice(
        index * 2,
        index * 2 + 2,
      ),
      16,
    );
  }

  return privateKey;
}

// -----------------------------------------------------------------------------
// Network Provider
// -----------------------------------------------------------------------------

const provider =
  new ElectrumNetworkProvider("chipnet");

/**
 * Retrieves all UTXOs belonging to an address.
 *
 * The address is always normalized to the complete "bchtest:" CashAddress
 * before it is sent to CashScript's Electrum provider.
 */
export async function getWalletUtxos(
  address: string,
): Promise<Utxo[]> {
  const normalizedAddress =
    validateChipnetAddress(address);

  console.debug(
    "Fetching Chipnet UTXOs for:",
    normalizedAddress,
  );

  return provider.getUtxos(
    normalizedAddress,
  );
}

/**
 * Calculates the wallet's spendable, non-token BCH balance in satoshis.
 *
 * Token-bearing UTXOs are excluded because spending them as ordinary BCH could
 * accidentally destroy or move the NFT/token.
 */
export async function getWalletBalanceSats(
  address: string,
): Promise<bigint> {
  const utxos =
    await getWalletUtxos(address);

  return utxos
    .filter((utxo) => !utxo.token)
    .reduce(
      (total, utxo) =>
        total + BigInt(utxo.satoshis),
      0n,
    );
}

/**
 * Calculates all BCH held by the wallet, including satoshis attached to token
 * and NFT UTXOs.
 *
 * Use this for a displayed total balance. Use getWalletBalanceSats() when
 * selecting ordinary spendable BCH inputs.
 */
export async function getWalletTotalBalanceSats(
  address: string,
): Promise<bigint> {
  const utxos =
    await getWalletUtxos(address);

  return utxos.reduce(
    (total, utxo) =>
      total + BigInt(utxo.satoshis),
    0n,
  );
}

// -----------------------------------------------------------------------------
// CashToken NFT Ticket Utilities
// -----------------------------------------------------------------------------

/**
 * Decodes a Bitcoin Cash Script Number from little-endian sign-and-magnitude
 * hexadecimal format.
 */
function scriptNumHexToNumber(
  hex: string,
): number {
  if (!hex) {
    return 0;
  }

  if (
    hex.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(hex)
  ) {
    throw new Error(
      `Invalid script-number hexadecimal value: ${hex}`,
    );
  }

  const bytes =
    hex.match(/.{2}/g)?.map((byte) =>
      Number.parseInt(byte, 16),
    ) ?? [];

  if (bytes.length === 0) {
    return 0;
  }

  let result = 0;

  for (
    let index = bytes.length - 1;
    index >= 0;
    index--
  ) {
    let byte = bytes[index];

    if (index === bytes.length - 1) {
      // Remove the sign bit from the most significant byte.
      byte &= 0x7f;
    }

    result =
      result * 256 + byte;
  }

  const finalByte =
    bytes[bytes.length - 1];

  const isNegative =
    (finalByte & 0x80) !== 0;

  return isNegative
    ? -result
    : result;
}

/**
 * Retrieves all CashToken NFT tickets owned by the wallet.
 */
export async function getWalletTickets(
  address: string,
): Promise<WalletTicket[]> {
  const utxos =
    await getWalletUtxos(address);

  return utxos
    .filter(
      (utxo) =>
        Boolean(
          utxo.token?.nft,
        ),
    )
    .map((utxo) => {
      const commitmentHex =
        utxo.token?.nft?.commitment ?? "";

      return {
        utxo,
        pickedNumber:
          scriptNumHexToNumber(
            commitmentHex,
          ),
        commitmentHex,
      };
    });
}

// -----------------------------------------------------------------------------
// Demo Wallet Persistence
// -----------------------------------------------------------------------------

/**
 * Checks whether localStorage is available.
 */
function getBrowserStorage():
  | Storage
  | null {
  if (
    typeof window === "undefined" ||
    !window.localStorage
  ) {
    return null;
  }

  return window.localStorage;
}

/**
 * Returns a persistent local demo wallet.
 *
 * A newly generated private key is stored in localStorage and restored across
 * page reloads.
 */
export function getDemoWallet(): WalletKeypair {
  const storage =
    getBrowserStorage();

  let keyHex =
    storage?.getItem(
      LOCAL_STORAGE_KEY,
    ) ?? null;

  const storedKeyIsValid =
    keyHex !== null &&
    /^[0-9a-fA-F]{64}$/.test(keyHex);

  if (!storedKeyIsValid) {
    const hardcodedKeyIsValid =
      /^[0-9a-fA-F]{64}$/.test(
        HARDCODED_DEMO_PRIVKEY_HEX,
      );

    if (hardcodedKeyIsValid) {
      keyHex =
        HARDCODED_DEMO_PRIVKEY_HEX;
    } else {
      const newWallet =
        generateWallet();

      keyHex =
        privateKeyToHex(
          newWallet.privateKey,
        );
    }

    storage?.setItem(
      LOCAL_STORAGE_KEY,
      keyHex,
    );
  }

  return walletFromPrivateKey(
    privateKeyFromHex(keyHex),
  );
}

/**
 * Imports a private key into the local demo wallet and returns the resulting
 * keypair.
 */
export function setDemoWalletKey(
  hex: string,
): WalletKeypair {
  const privateKey =
    privateKeyFromHex(hex);

  const normalizedHex =
    privateKeyToHex(privateKey);

  const storage =
    getBrowserStorage();

  storage?.setItem(
    LOCAL_STORAGE_KEY,
    normalizedHex,
  );

  return walletFromPrivateKey(
    privateKey,
  );
}

/**
 * Removes the saved local demo private key.
 */
export function clearDemoWallet(): void {
  const storage =
    getBrowserStorage();

  storage?.removeItem(
    LOCAL_STORAGE_KEY,
  );
}