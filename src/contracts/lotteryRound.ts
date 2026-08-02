import {
  generateWallet,
  privateKeyFromHex,
  privateKeyToHex,
  walletFromPrivateKey,
} from "./wallet";

const ORACLE_STORAGE_KEY =
  "lottery:shared-oracle-private-key";

const ROUND_STORAGE_KEY =
  "lottery:shared-round-epoch";

export function getSharedOracleWallet() {
  let privateKeyHex =
    localStorage.getItem(
      ORACLE_STORAGE_KEY,
    );

  if (!privateKeyHex) {
    const wallet = generateWallet();

    privateKeyHex = privateKeyToHex(
      wallet.privateKey,
    );

    localStorage.setItem(
      ORACLE_STORAGE_KEY,
      privateKeyHex,
    );

    return wallet;
  }

  return walletFromPrivateKey(
    privateKeyFromHex(privateKeyHex),
  );
}

export function getSharedRoundEpoch(): number {
  const saved =
    localStorage.getItem(
      ROUND_STORAGE_KEY,
    );

  if (saved) {
    return Number(saved);
  }

  const roundEpoch = Date.now();

  localStorage.setItem(
    ROUND_STORAGE_KEY,
    String(roundEpoch),
  );

  return roundEpoch;
}

export function startNewSharedRound(): number {
  const roundEpoch = Date.now();

  localStorage.setItem(
    ROUND_STORAGE_KEY,
    String(roundEpoch),
  );

  return roundEpoch;
}