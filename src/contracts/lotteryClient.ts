import {
  Contract,
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from "cashscript";
import type { Utxo } from "cashscript";
import { secp256k1 } from "@bitauth/libauth";
import CompleteLotteryArtifact from "./Lottery.json";

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

// --- buyTicket ---------------------------------------------------------
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
    .addOpReturnOutput([
      `0x${bytesToHex(buyerPkHash)}`,
      `0x${numberHex}`,
    ])
    .addBchChangeOutputIfNeeded({ to: buyerAddress, feeRate: 1.2 });

  return builder.send();
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

// --- resolveDraw ---------------------------------------------------------
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

// --- reclaimRefund ---------------------------------------------------------
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