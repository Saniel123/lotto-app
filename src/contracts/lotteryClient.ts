import {
  Contract,
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from "cashscript";
import type { Utxo } from "cashscript";
import LotteryArtifact from "./Lottery.json";

// -----------------------------------------------------------------------
// Rewritten against cashscript 0.13.2's actual shipped API (checked
// against the installed .d.ts files in this sandbox: Contract.d.ts,
// TransactionBuilder.d.ts, SignatureTemplate.d.ts, interfaces.d.ts).
// The previous version of this file used an older fluent
// `.functions.foo().from().to().send()` style that does NOT exist on
// this version — it's `contract.unlock.<fn>(...)` producing an
// `Unlocker`, consumed by a standalone `TransactionBuilder`.
//
// STILL NOT LIVE-TESTED: no chipnet/Electrum network access in this
// sandbox, so none of the calls below have actually broadcast. Fund a
// chipnet wallet from the faucet and run one of each function before
// trusting this in the UI.
// -----------------------------------------------------------------------

const provider = new ElectrumNetworkProvider("chipnet");

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface LotteryParams {
  ticketPriceSats: bigint;
  maxTicketRange: number;
  drawDeadline: number; // unix seconds
  refundDeadline: number; // unix seconds
}

export function getLotteryContract(params: LotteryParams) {
  // cashscript validates constructor args against the artifact's declared
  // types at runtime: an artifact 'int' input must be a JS bigint, not a
  // number — passing a number throws "Found type 'number' where type
  // 'int' was expected" the first time getUtxos()/functions touch the
  // contract. ticketPriceSats is already a bigint; the other three were
  // plain numbers (drawDeadline/refundDeadline are unix-second numbers,
  // maxTicketRange is a plain JS number computed from 10 ** pickCount) —
  // wrap all four in BigInt(...) here so callers can keep passing normal
  // numbers without having to know this cashscript quirk themselves.
  return new Contract(
    LotteryArtifact,
    [
      params.ticketPriceSats,
      BigInt(params.maxTicketRange),
      BigInt(params.drawDeadline),
      BigInt(params.refundDeadline),
    ],
    { provider },
  );
}

// --- buyTicket ---------------------------------------------------------
// Two inputs: the funding input from the buyer's own wallet (unlocked with
// a plain SignatureTemplate) comes first as input 0, and the contract's own
// UTXO comes second as input 1 (matching typical contract expectations where
// introspection checks input 1 or active indices). Two outputs the contract
// requires (new contract balance, OP_RETURN ticket record), plus buyer change.
export async function buyTicket(
  contract: Contract,
  ticketPriceSats: bigint,
  buyerPkHash: Uint8Array,
  pickedNumbers: Uint8Array,
  buyerPrivateKey: Uint8Array,
  buyerAddress: string,
) {
  const contractUtxos = await contract.getUtxos();
  if (contractUtxos.length === 0) {
    throw new Error("Lottery contract has no UTXO yet — fund/create it first.");
  }

  const contractUtxo = contractUtxos.reduce((best, u) =>
    u.satoshis > best.satoshis ? u : best,
  );

  if (contractUtxo.satoshis < ticketPriceSats) {
    throw new Error(
      "Contract's largest UTXO is smaller than one ticket price.",
    );
  }

  const buyerUtxos = await provider.getUtxos(buyerAddress);
  const fundingUtxo = buyerUtxos.find(
    (u: Utxo) => !u.token && u.satoshis >= ticketPriceSats + 1000n,
  );
  if (!fundingUtxo) {
    throw new Error(
      "Buyer wallet has no UTXO large enough to cover ticket + fee.",
    );
  }

  // Explicitly instantiate the signature template
  const sigTemplate = new SignatureTemplate(buyerPrivateKey);
  const newContractBalance = contractUtxo.satoshis + ticketPriceSats;

  const builder = new TransactionBuilder({ provider });
  builder
    .addInput(fundingUtxo, sigTemplate.unlockP2PKH())
    .addInput(
      contractUtxo,
      contract.unlock.buyTicket(buyerPkHash, pickedNumbers),
    )
    .addOutput({ to: contract.address, amount: newContractBalance })
    .addOpReturnOutput([
      `0x${bytesToHex(buyerPkHash)}`,
      `0x${bytesToHex(pickedNumbers)}`,
    ])
    .addBchChangeOutputIfNeeded({ to: buyerAddress, feeRate: 1.0 });

  return builder.send();
}

// --- seedContract ---------------------------------------------------------
// A fresh slot contract (see App.tsx's PER-SLOT CONTRACTS note — each
// drawDeadline gets its own address) starts with zero UTXOs. buyTicket()
// requires an existing contract UTXO to spend and extend
// (`tx.inputs[this.activeInputIndex].value >= ticketPrice` — note this
// means the FIRST funding UTXO already needs to hold at least one ticket's
// worth of sats, not just a dust amount), so something has to pay the
// contract's own address directly, once, before any buyTicket call works.
// This is an ordinary P2PKH-funded payment TO the contract address — no
// contract function is invoked, since nothing exists yet to unlock.
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

// Permissionless — no operator key, no signature requirement at all.
export async function resolveDraw(
  contract: Contract,
  header: Uint8Array, // raw 80-byte block header
  winnerAddress: string,
  winnerPkHash: Uint8Array,
) {
  const contractUtxos = await contract.getUtxos();
  if (contractUtxos.length === 0) {
    throw new Error("Lottery contract has no UTXO to resolve.");
  }
  const contractUtxo = contractUtxos[0];

  const builder = new TransactionBuilder({ provider });
  builder
    .addInput(contractUtxo, contract.unlock.resolveDraw(header, winnerPkHash))
    .addOutput({ to: winnerAddress, amount: contractUtxo.satoshis });

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
  builder
    .addInput(
      contractUtxo,
      contract.unlock.reclaimRefund(buyerPublicKey, sigTemplate),
    )
    .addOutput({ to: buyerAddress, amount: contractUtxo.satoshis });

  return builder.send();
}
