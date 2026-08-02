import {
  Contract,
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  placeholderPublicKey,
  placeholderSignature,
} from "cashscript";
import type { Utxo } from "cashscript";
import { secp256k1 } from "@bitauth/libauth";
import CompleteLotteryArtifact from "./Lottery.json";
import { signWithPaytaca, type PaytacaSignedTx } from "./paytacaconnect";
import {
  normalizeChipnetAddress,
  toTokenAwareChipnetAddress,
} from "./wallet";

const provider = new ElectrumNetworkProvider("chipnet");

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- CashScript / Script-Number encoding ---------------------------------
export function numberToScriptNumBytes(n: number | bigint): Uint8Array {
  let abs = typeof n === "bigint" ? (n < 0n ? -n : n) : BigInt(Math.abs(n));
  if (abs === 0n) return new Uint8Array(0);

  const negative = typeof n === "bigint" ? n < 0n : n < 0;
  const bytes: number[] = [];

  while (abs > 0n) {
    bytes.push(Number(abs & 0xffn));
    abs >>= 8n;
  }

  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(negative ? 0x80 : 0x00);
  } else if (negative) {
    bytes[bytes.length - 1] |= 0x80;
  }

  return new Uint8Array(bytes);
}

export function numberToScriptNumHex(n: number | bigint): string {
  return bytesToHex(numberToScriptNumBytes(n));
}

export interface LotteryParams {
  oraclePk: Uint8Array;
  drawTimestamp: number; // Unix timestamp in seconds
  ticketPriceSats: bigint;
  maxTicketRange: number;
}

/**
 * Instantiate the updated CashTokens CompleteLottery Contract.
 */
export function getLotteryContract(params: LotteryParams) {
  return new Contract(
    CompleteLotteryArtifact,
    [
      params.oraclePk,
      BigInt(params.drawTimestamp),
      params.ticketPriceSats,
      BigInt(params.maxTicketRange),
    ],
    { provider },
  );
}

// --- Direct jackpot-wallet ticket purchase ---------------------------------

/**
 * Ticket purchases now pay a fixed jackpot P2PKH wallet directly.
 *
 * There is deliberately no seed/fund transaction and no requirement for an
 * existing CashScript contract UTXO. The bettor only spends their own BCH
 * input and creates the jackpot payment output. Ticket metadata remains in the
 * frontend/backend rather than being added to the WalletConnect transaction.
 *
 * Note: because a normal P2PKH jackpot wallet is used, this function does not
 * mint the previous contract-controlled CashToken NFT. Persist the returned
 * txid together with the buyer address and picked number in your backend.
 */
export async function buyTicket(
  jackpotAddress: string,
  ticketPriceSats: bigint,
  buyerPkHash: Uint8Array,
  pickedNumber: number | bigint,
  buyerPrivateKey: Uint8Array,
  buyerAddress: string,
) {
  const normalizedBuyerAddress =
    normalizeChipnetAddress(buyerAddress);

  const normalizedJackpotAddress =
    normalizeChipnetAddress(jackpotAddress);

  const buyerUtxos =
    await provider.getUtxos(normalizedBuyerAddress);

  const fundingUtxo = buyerUtxos.find(
    (utxo: Utxo) =>
      !utxo.token &&
      BigInt(utxo.satoshis) >= ticketPriceSats + 1500n,
  );

  if (!fundingUtxo) {
    throw new Error(
      "Buyer wallet has no UTXO large enough to cover the ticket price and network fee.",
    );
  }

  const sigTemplate =
    new SignatureTemplate(buyerPrivateKey);

  const numberHex =
    numberToScriptNumHex(pickedNumber);

  const builder =
    new TransactionBuilder({ provider });

  builder
    .addInput(
      fundingUtxo,
      sigTemplate.unlockP2PKH(),
    )
    .addOutput({
      to: normalizedJackpotAddress,
      amount: ticketPriceSats,
    })
    .addBchChangeOutputIfNeeded({
      to: normalizedBuyerAddress,
      feeRate: 3.0,
    });

  return builder.send();
}

/**
 * Paytaca version of the direct jackpot-wallet ticket purchase.
 * Paytaca signs only the bettor's P2PKH input through WalletConnect.
 */
export async function buyTicketViaPaytaca(
  jackpotAddress: string,
  ticketPriceSats: bigint,
  buyerAddress: string,
  buyerPkHash: Uint8Array,
  pickedNumber: number | bigint,
): Promise<PaytacaSignedTx> {
  const normalizedBuyerAddress =
    normalizeChipnetAddress(buyerAddress);

  const normalizedJackpotAddress =
    normalizeChipnetAddress(jackpotAddress);

  const buyerUtxos =
    await provider.getUtxos(normalizedBuyerAddress);

  const fundingUtxo = buyerUtxos.find(
    (utxo: Utxo) =>
      !utxo.token &&
      BigInt(utxo.satoshis) >= ticketPriceSats + 1500n,
  );

  if (!fundingUtxo) {
    throw new Error(
      "Paytaca wallet has no UTXO large enough to cover the ticket price and network fee. Use the faucet first.",
    );
  }

  const numberHex =
    numberToScriptNumHex(pickedNumber);

  const builder =
    new TransactionBuilder({ provider });

  builder
    .addInput(
      fundingUtxo,
      placeholderP2PKHUnlocker(
        normalizedBuyerAddress,
      ),
    )
    .addOutput({
      to: normalizedJackpotAddress,
      amount: ticketPriceSats,
    })
    .addBchChangeOutputIfNeeded({
      to: normalizedBuyerAddress,
      feeRate: 3.0,
    });

  const wcTransactionObj =
    builder.generateWcTransactionObject({
      // Paytaca only signs. The dapp broadcasts through Electrum below.
      // A 3 sat/byte fee rate is used above because the final DER signature
      // can be larger than the WalletConnect placeholder used for estimation.
      broadcast: false,
      userPrompt:
        `Buy 3D Lotto ticket #${pickedNumber.toString()} for ${Number(ticketPriceSats) / 1e8} BCH`,
    });

  const result =
    await signWithPaytaca(wcTransactionObj);

  if (
    !result ||
    typeof result.signedTransaction !== "string" ||
    !result.signedTransaction
  ) {
    throw new Error(
      "Paytaca did not return a signed transaction.",
    );
  }

  let broadcastTxid: string;

  try {
    broadcastTxid = await provider.sendRawTransaction(
      result.signedTransaction,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);

    throw new Error(
      `The ticket was signed, but broadcasting failed: ${message}`,
    );
  }

  return {
    ...result,
    signedTransactionHash: broadcastTxid,
  };
}


/**
 * Spend all non-token BCH UTXOs from the jackpot wallet and send the balance,
 * minus the network fee, to the winning wallet.
 *
 * The connected Paytaca wallet MUST be the jackpot wallet because Paytaca
 * signs the P2PKH inputs. This function does not embed any private key.
 */
export async function payWinnerViaPaytaca(
  jackpotAddress: string,
  winnerAddress: string,
): Promise<PaytacaSignedTx> {
  const normalizedJackpotAddress =
    normalizeChipnetAddress(jackpotAddress);

  const normalizedWinnerAddress =
    normalizeChipnetAddress(winnerAddress);

  const jackpotUtxos =
    await provider.getUtxos(
      normalizedJackpotAddress,
    );

  const spendableUtxos =
    jackpotUtxos.filter(
      (utxo: Utxo) => !utxo.token,
    );

  if (spendableUtxos.length === 0) {
    throw new Error(
      "The jackpot wallet has no spendable BCH.",
    );
  }

  const totalSats =
    spendableUtxos.reduce(
      (sum, utxo) =>
        sum + BigInt(utxo.satoshis),
      0n,
    );

  /**
   * Conservative fee reserve. Any remainder beyond the actual required fee is
   * included in the miner fee because this transaction empties the jackpot.
   */
  const feeReserve =
    1200n +
    BigInt(spendableUtxos.length) * 900n;

  if (totalSats <= feeReserve) {
    throw new Error(
      "The jackpot is too small to cover the payout network fee.",
    );
  }

  const payoutAmount =
    totalSats - feeReserve;

  const builder =
    new TransactionBuilder({
      provider,
    });

  for (const utxo of spendableUtxos) {
    builder.addInput(
      utxo,
      placeholderP2PKHUnlocker(
        normalizedJackpotAddress,
      ),
    );
  }

  builder.addOutput({
    to: normalizedWinnerAddress,
    amount: payoutAmount,
  });

  const wcTransactionObj =
    builder.generateWcTransactionObject({
      broadcast: false,
      userPrompt:
        `Send ${Number(payoutAmount) / 1e8} BCH jackpot to ${normalizedWinnerAddress}`,
    });

  const result =
    await signWithPaytaca(
      wcTransactionObj,
    );

  if (
    !result ||
    typeof result.signedTransaction !==
      "string" ||
    !result.signedTransaction
  ) {
    throw new Error(
      "Paytaca did not return a signed jackpot payout transaction.",
    );
  }

  let broadcastTxid: string;

  try {
    broadcastTxid =
      await provider.sendRawTransaction(
        result.signedTransaction,
      );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);

    throw new Error(
      `The jackpot payout was signed, but broadcasting failed: ${message}`,
    );
  }

  return {
    ...result,
    signedTransactionHash:
      broadcastTxid,
  };
}

// --- Oracle signing ---------------------------------------------------------
export async function signOracleWinningNumber(
  oraclePrivateKey: Uint8Array,
  winningNumber: number,
): Promise<{ oracleSig: Uint8Array; oracleMessage: Uint8Array }> {
  const oracleMessage = numberToScriptNumBytes(winningNumber);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", oracleMessage),
  );
  const sigResult = secp256k1.signMessageHashDER(oraclePrivateKey, digest);
  if (typeof sigResult === "string") {
    throw new Error(`Failed to sign oracle message: ${sigResult}`);
  }
  return { oracleSig: sigResult, oracleMessage };
}

// --- resolveDraw (local private-key demo wallet) --------------------------
export async function resolveDraw(
  contract: Contract,
  oracleSig: Uint8Array,
  oracleMessage: Uint8Array,
  winnerAddress: string,
  winnerPkHash: Uint8Array,
  winningNumber: number,
  winnerPrivateKey: Uint8Array,
) {
  const contractUtxos = await contract.getUtxos();
  if (contractUtxos.length === 0) {
    throw new Error("Lottery contract has no UTXO to resolve.");
  }
  const contractUtxo = contractUtxos[0];

  const normalizedWinnerAddress = normalizeChipnetAddress(winnerAddress);
  const winnerTokenAddress = toTokenAwareChipnetAddress(normalizedWinnerAddress);
  const winnerUtxos = await provider.getUtxos(winnerTokenAddress);
  const numberHex = numberToScriptNumHex(winningNumber);

  const winnerNftUtxo = winnerUtxos.find(
    (u: Utxo) => u.token?.nft?.commitment === numberHex,
  );

  if (!winnerNftUtxo) {
    throw new Error(
      "Winner address does not hold the winning CashToken NFT ticket.",
    );
  }

  const sigTemplate = new SignatureTemplate(winnerPrivateKey);
  const payoutAmount = contractUtxo.satoshis - 1500n; // Fee margin

  const builder = new TransactionBuilder({ provider });
  builder.setLocktime(Math.floor(Date.now() / 1000));

  builder
    .addInput(
      contractUtxo,
      contract.unlock.resolveDraw(
        oracleSig,
        oracleMessage,
        winnerPkHash,
        BigInt(winningNumber),
      ),
    )
    .addInput(winnerNftUtxo, sigTemplate.unlockP2PKH())
    .addOutput({ to: normalizedWinnerAddress, amount: payoutAmount });

  return builder.send();
}

// --- resolveDraw (Paytaca WalletConnect) -----------------------------------
/**
 * Same as resolveDraw() above, but the winner's ticket-NFT input (input 1)
 * is signed by a connected Paytaca wallet instead of a local private key.
 */
export async function resolveDrawViaPaytaca(
  contract: Contract,
  oracleSig: Uint8Array,
  oracleMessage: Uint8Array,
  winnerAddress: string,
  winnerPkHash: Uint8Array,
  winningNumber: number,
): Promise<PaytacaSignedTx> {
  const contractUtxos = await contract.getUtxos();
  if (contractUtxos.length === 0) {
    throw new Error("Lottery contract has no UTXO to resolve.");
  }
  const contractUtxo = contractUtxos[0];

  const normalizedWinnerAddress = normalizeChipnetAddress(winnerAddress);
  const winnerTokenAddress = toTokenAwareChipnetAddress(normalizedWinnerAddress);
  const winnerUtxos = await provider.getUtxos(winnerTokenAddress);
  const numberHex = numberToScriptNumHex(winningNumber);

  const winnerNftUtxo = winnerUtxos.find(
    (u: Utxo) => u.token?.nft?.commitment === numberHex,
  );

  if (!winnerNftUtxo) {
    throw new Error(
      "Connected Paytaca wallet does not hold the winning CashToken NFT ticket.",
    );
  }

  const payoutAmount = contractUtxo.satoshis - 1500n; // Fee margin

  const builder = new TransactionBuilder({ provider });
  builder.setLocktime(Math.floor(Date.now() / 1000));

  builder
    .addInput(
      contractUtxo,
      contract.unlock.resolveDraw(
        oracleSig,
        oracleMessage,
        winnerPkHash,
        BigInt(winningNumber),
      ),
    )
    // Input 1: Winner's ticket NFT — placeholder, filled in by Paytaca
    .addInput(winnerNftUtxo, placeholderP2PKHUnlocker(normalizedWinnerAddress))
    .addOutput({ to: normalizedWinnerAddress, amount: payoutAmount });

  const wcTransactionObj = builder.generateWcTransactionObject({
    broadcast: true,
    userPrompt: "Claim your Swertres jackpot",
  });

  const result = await signWithPaytaca(wcTransactionObj);
  if (!result) throw new Error("Paytaca declined to sign resolveDraw().");
  return result;
}

// --- reclaimRefund (local private-key demo wallet) -------------------------
export async function reclaimRefund(
  contract: Contract,
  buyerPublicKey: Uint8Array,
  buyerPrivateKey: Uint8Array,
  buyerAddress: string,
) {
  const normalizedBuyerAddress = normalizeChipnetAddress(buyerAddress);
  const contractUtxos = await contract.getUtxos();
  if (contractUtxos.length === 0) {
    throw new Error("Lottery contract has no UTXO to refund.");
  }
  const contractUtxo = contractUtxos[0];
  const sigTemplate = new SignatureTemplate(buyerPrivateKey);

  const builder = new TransactionBuilder({ provider });
  builder.setLocktime(Math.floor(Date.now() / 1000));

  builder
    .addInput(
      contractUtxo,
      contract.unlock.reclaimRefund(buyerPublicKey, sigTemplate),
    )
    .addOutput({
      to: normalizedBuyerAddress,
      amount: contractUtxo.satoshis - 1500n,
    });

  return builder.send();
}

// --- reclaimRefund (Paytaca WalletConnect) ----------------------------------
/**
 * Same as reclaimRefund() above, but the buyer's pubkey and signature are
 * filled in by Paytaca rather than a local key. Paytaca detects the
 * placeholder pubkey/signature patterns inside the contract's unlocking
 * arguments and substitutes the connected wallet's real values.
 */
export async function reclaimRefundViaPaytaca(
  contract: Contract,
  buyerAddress: string,
): Promise<PaytacaSignedTx> {
  const normalizedBuyerAddress = normalizeChipnetAddress(buyerAddress);
  const contractUtxos = await contract.getUtxos();
  if (contractUtxos.length === 0) {
    throw new Error("Lottery contract has no UTXO to refund.");
  }
  const contractUtxo = contractUtxos[0];

  const builder = new TransactionBuilder({ provider });
  builder.setLocktime(Math.floor(Date.now() / 1000));

  builder
    .addInput(
      contractUtxo,
      contract.unlock.reclaimRefund(
        placeholderPublicKey(),
        placeholderSignature(),
      ),
    )
    .addOutput({
      to: normalizedBuyerAddress,
      amount: contractUtxo.satoshis - 1500n,
    });

  const wcTransactionObj = builder.generateWcTransactionObject({
    broadcast: true,
    userPrompt: "Reclaim your Swertres ticket refund",
  });

  const result = await signWithPaytaca(wcTransactionObj);
  if (!result) throw new Error("Paytaca declined to sign reclaimRefund().");
  return result;
}
