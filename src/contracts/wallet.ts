import {
  generatePrivateKey,
  secp256k1,
  hash160,
  encodeCashAddress,
  CashAddressType,
} from "@bitauth/libauth";
import { ElectrumNetworkProvider } from "cashscript";

// -----------------------------------------------------------------------
// Verified in this sandbox: key generation, pubkey derivation, hash160,
// and cashaddr encoding below were run end-to-end against the installed
// libauth 3.1.0-next.8 (see wallet.test.mjs / the console output posted
// alongside this file) and produce a well-formed chipnet P2PKH address.
// UTXO/balance fetching against a live Electrum server was NOT exercised
// here (no network access to chipnet in this sandbox) — confirm those
// two calls against a real server before relying on them.
// -----------------------------------------------------------------------

export interface WalletKeypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array; // 33-byte compressed
  pkHash: Uint8Array; // hash160(publicKey), 20 bytes — this is buyerPkHash for buyTicket()
  address: string; // chipnet cashaddr
}

// Derives the full keypair (pubkey, pkHash, chipnet address) from an
// existing private key, instead of generating a new one. Used both by
// generateWallet() below and by callers restoring a previously-saved key
// (e.g. from localStorage) so a page refresh doesn't strand funds at an
// address the app can no longer produce.
export function walletFromPrivateKey(privateKey: Uint8Array): WalletKeypair {
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === "string") {
    throw new Error(`Failed to derive public key: ${publicKey}`);
  }
  const pkHash = hash160(publicKey);

  const addressResult = encodeCashAddress({
    prefix: "bchtest", // chipnet uses the same "bchtest" prefix as testnet
    type: CashAddressType.p2pkh,
    payload: pkHash,
    throwErrors: false,
  });
  if (typeof addressResult === "string") {
    throw new Error(`Failed to encode address: ${addressResult}`);
  }

  return { privateKey, publicKey, pkHash, address: addressResult.address };
}

export function generateWallet(): WalletKeypair {
  return walletFromPrivateKey(generatePrivateKey());
}

// --- Private key <-> hex, for persistence -----------------------------
// Plain hex in localStorage is fine ONLY because this wallet talks to
// chipnet, where the "funds" are worthless test coins obtained from a
// faucet. Do not reuse this persistence approach for a mainnet wallet
// holding real value — that needs actual secure storage (encrypted at
// rest, ideally never touching localStorage at all).
export function privateKeyToHex(privateKey: Uint8Array): string {
  return Array.from(privateKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function privateKeyFromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// --- Balance / UTXOs -------------------------------------------------------
// Electrum's protocol takes a scripthash, not an address directly.
// cashscript's ElectrumNetworkProvider exposes address-based convenience
// methods that do this conversion internally — using those here rather
// than hand-rolling scripthash derivation, since that conversion is easy
// to get subtly wrong and cashscript already ships a tested version.
const provider = new ElectrumNetworkProvider("chipnet");

export async function getWalletUtxos(address: string) {
  return provider.getUtxos(address);
}

export async function getWalletBalanceSats(address: string): Promise<bigint> {
  const utxos = await getWalletUtxos(address);
  return utxos.reduce((sum, utxo) => sum + BigInt(utxo.satoshis), 0n);
}
