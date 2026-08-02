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
import { signWithPaytaca, type PaytacaSignedTx } from "./paytacaConnect";

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

// --- seedContract ---------------------------------------------------------
export async function seedContract(
  contract: Contract,
  amountSats: bigint,
  funderPrivateKey: Uint8Array,
  funderAddress: string,
) {
  const funderUtxos = await provider.getUtxos(funderAddress);
  const fundingUtxo = funderUtxos.find(
    (u: Utxo) => !u.token && u.satoshis >= amountSats + 1000n,
  );
  if (!fundingUtxo) {
    throw new Error(
      "Wallet has no UTXO large enough to seed the contract (amount + fee).",
    );
  }

  const sigTemplate = new SignatureTemplate(funderPrivateKey);
  const builder = new TransactionBuilder({ provider });
  builder
    .addInput(fundingUtxo, sigTemplate.unlockP2PKH())
    .addOutput({ to: contract.address, amount: amountSats })
    .addBchChangeOutputIfNeeded({ to: funderAddress, feeRate: 1.0 });

  return builder.send();
}

/**
 * Seed the contract using a Paytaca-connected wallet instead of a local
 * private key. Paytaca signs the funding input over WalletConnect.
 */
export async function seedContractViaPaytaca(
  contract: Contract,
  amountSats: bigint,
  funderAddress: string,
): Promise<PaytacaSignedTx> {
  const funderUtxos = await provider.getUtxos(funderAddress);
  const fundingUtxo = funderUtxos.find(
    (u: Utxo) => !u.token && u.satoshis >= amountSats + 1000n,
  );
  if (!fundingUtxo) {
    throw new Error(
      "Paytaca wallet has no UTXO large enough to seed the contract (amount + fee). Use the faucet first.",
    );
  }

  const builder = new TransactionBuilder({ provider });
  builder
    .addInput(fundingUtxo, placeholderP2PKHUnlocker(funderAddress))
    .addOutput({ to: contract.address, amount: amountSats })
    .addBchChangeOutputIfNeeded({ to: funderAddress, feeRate: 1.0 });

  const wcTransactionObj = builder.generateWcTransactionObject({
    broadcast: true,
    userPrompt: "Seed the Swertres lottery jackpot",
  });

  const result = await signWithPaytaca(wcTransactionObj);
  if (!result)
    throw new Error("Paytaca declined to sign the seed transaction.");
  return result;
}

// --- buyTicket (local private-key demo wallet) ---------------------------
export async function buyTicket(
  contract: Contract,
  ticketPriceSats: bigint,
  buyerPkHash: Uint8Array,
  pickedNumber: number | bigint,
  buyerPrivateKey: Uint8Array,
  buyerAddress: string,
) {
  const contractUtxos = await contract.getUtxos();
  if (contractUtxos.length === 0) {
    throw new Error("Lottery contract has no UTXO yet — fund/seed it first.");
  }

  // Contract UTXO MUST be Input 0
  const contractUtxo = contractUtxos.reduce((best, u) =>
    u.satoshis > best.satoshis ? u : best,
  );

  const buyerUtxos = await provider.getUtxos(buyerAddress);
  const fundingUtxo = buyerUtxos.find(
    (u: Utxo) => !u.token && u.satoshis >= ticketPriceSats + 2000n,
  );
  if (!fundingUtxo) {
    throw new Error(
      "Buyer wallet has no UTXO large enough to cover ticket price + fee.",
    );
  }

  const sigTemplate = new SignatureTemplate(buyerPrivateKey);
  const newContractBalance = contractUtxo.satoshis + ticketPriceSats;
  const numberHex = numberToScriptNumHex(pickedNumber);

  const builder = new TransactionBuilder({ provider });
  builder
    // Input 0: Contract Jackpot UTXO
    .addInput(
      contractUtxo,
      contract.unlock.buyTicket(buyerPkHash, BigInt(pickedNumber)),
    )
    // Input 1: Buyer Funding UTXO
    .addInput(fundingUtxo, sigTemplate.unlockP2PKH())
    // Output 0: Contract Continuation (Jackpot + Ticket Price)
    .addOutput({ to: contract.address, amount: newContractBalance })
    // Output 1: CashToken NFT Ticket sent to buyer
    // Token Category MUST match contractUtxo.txid or contract's token category logic
    .addOutput({
      to: buyerAddress,
      amount: 1000n,
      token: {
        category: contractUtxo.token?.category || contractUtxo.txid,
        amount: 0n,
        nft: {
          capability: "none",
          commitment: numberHex,
        },
      },
    })
    // Output 2: OP_RETURN Audit Record
    .addOpReturnOutput([`0x${bytesToHex(buyerPkHash)}`, `0x${numberHex}`])
    .addBchChangeOutputIfNeeded({ to: buyerAddress, feeRate: 1.2 });

  return builder.send();
}

// --- buyTicket (Paytaca WalletConnect) ------------------------------------
/**
 * Same as buyTicket() above, but the buyer's funding input is signed by a
 * connected Paytaca wallet over WalletConnect instead of a local private key.
 * The oracle/contract-covenant input still unlocks with `contract.unlock`,
 * since it doesn't require the buyer's signature — only their funding UTXO
 * (input 1) does, so that's the one we hand to Paytaca as a placeholder.
 */
export async function buyTicketViaPaytaca(
  contract: Contract,
  ticketPriceSats: bigint,
  buyerAddress: string,
  buyerPkHash: Uint8Array,
  pickedNumber: number | bigint,
): Promise<PaytacaSignedTx> {
  const contractUtxos = await contract.getUtxos();
  if (contractUtxos.length === 0) {
    throw new Error("Lottery contract has no UTXO yet — fund/seed it first.");
  }

  const contractUtxo = contractUtxos.reduce((best, u) =>
    u.satoshis > best.satoshis ? u : best,
  );

  const buyerUtxos = await provider.getUtxos(buyerAddress);
  const fundingUtxo = buyerUtxos.find(
    (u: Utxo) => !u.token && u.satoshis >= ticketPriceSats + 2000n,
  );
  if (!fundingUtxo) {
    throw new Error(
      "Paytaca wallet has no UTXO large enough to cover ticket price + fee. Use the faucet first.",
    );
  }

  const newContractBalance = contractUtxo.satoshis + ticketPriceSats;
  const numberHex = numberToScriptNumHex(pickedNumber);

  const builder = new TransactionBuilder({ provider });
  builder
    // Input 0: Contract Jackpot UTXO (unlocked via the covenant, no wallet sig needed)
    .addInput(
      contractUtxo,
      contract.unlock.buyTicket(buyerPkHash, BigInt(pickedNumber)),
    )
    // Input 1: Buyer Funding UTXO — placeholder, filled in by Paytaca
    .addInput(fundingUtxo, placeholderP2PKHUnlocker(buyerAddress))
    // Output 0: Contract Continuation (Jackpot + Ticket Price)
    .addOutput({ to: contract.address, amount: newContractBalance })
    // Output 1: CashToken NFT Ticket sent to buyer
    .addOutput({
      to: buyerAddress,
      amount: 1000n,
      token: {
        category: contractUtxo.token?.category || contractUtxo.txid,
        amount: 0n,
        nft: {
          capability: "none",
          commitment: numberHex,
        },
      },
    })
    // Output 2: OP_RETURN Audit Record
    .addOpReturnOutput([`0x${bytesToHex(buyerPkHash)}`, `0x${numberHex}`])
    .addBchChangeOutputIfNeeded({ to: buyerAddress, feeRate: 1.2 });

  const wcTransactionObj = builder.generateWcTransactionObject({
    broadcast: true,
    userPrompt: `Buy Swertres ticket #${numberHex ? pickedNumber : pickedNumber}`,
  });

  const result = await signWithPaytaca(wcTransactionObj);
  if (!result) throw new Error("Paytaca declined to sign the ticket purchase.");
  return result;
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

  const winnerUtxos = await provider.getUtxos(winnerAddress);
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
    .addOutput({ to: winnerAddress, amount: payoutAmount });

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

  const winnerUtxos = await provider.getUtxos(winnerAddress);
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
    .addInput(winnerNftUtxo, placeholderP2PKHUnlocker(winnerAddress))
    .addOutput({ to: winnerAddress, amount: payoutAmount });

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
      to: buyerAddress,
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
      to: buyerAddress,
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
