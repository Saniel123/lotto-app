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
// Two inputs: the contract's own UTXO (carried forward via the contract's
// unlock function) and a funding input from the buyer's own wallet
// (unlocked with a plain SignatureTemplate). Two outputs the contract
// requires (new contract balance, OP_RETURN ticket record), plus buyer
// change. Caller passes ticketPriceSats so this function doesn't need to
// re-derive it from the artifact.
export async function buyTicket(
  contract: Contract,
  ticketPriceSats: bigint,
  buyerPkHash: Uint8Array, // hash160(buyerPublicKey), 20 bytes
  pickedNumbers: Uint8Array,
  buyerPrivateKey: Uint8Array,
  buyerAddress: string,
) {
  const contractUtxos = await contract.getUtxos();
  if (contractUtxos.length === 0) {
    throw new Error("Lottery contract has no UTXO yet — fund/create it first.");
  }
  const contractUtxo = contractUtxos[0];

  const buyerUtxos = await provider.getUtxos(buyerAddress);
  // Needs a UTXO covering at least ticketPrice + fee; a real wallet layer
  // would do coin selection here. Simplified to "first big-enough UTXO".
  const fundingUtxo = buyerUtxos.find(
    (u: Utxo) => !u.token && u.satoshis >= ticketPriceSats + 1000n,
  );
  if (!fundingUtxo) {
    throw new Error(
      "Buyer wallet has no UTXO large enough to cover the ticket + fee.",
    );
  }

  const sigTemplate = new SignatureTemplate(buyerPrivateKey);
  const newContractBalance = contractUtxo.satoshis + ticketPriceSats;

  const builder = new TransactionBuilder({ provider });
  builder
    .addInput(
      contractUtxo,
      contract.unlock.buyTicket(buyerPkHash, pickedNumbers),
    )
    .addInput(fundingUtxo, sigTemplate.unlockP2PKH())
    .addOutput({ to: contract.address, amount: newContractBalance })
    .addOpReturnOutput([
      // addOpReturnOutput adds the 0x6a prefix and push opcodes itself —
      // matching the contract's required 0x6a14<buyerPkHash><pickedNumbers>
      // layout only requires passing the two data chunks. Uses a
      // browser-safe hex encoder (bytesToHex) instead of Node's Buffer,
      // since this runs in the React app, not Node.
      `0x${bytesToHex(buyerPkHash)}`,
      `0x${bytesToHex(pickedNumbers)}`,
    ])
    .addBchChangeOutputIfNeeded({ to: buyerAddress, feeRate: 1.0 });

  return builder.send();
}

// --- resolveDraw ---------------------------------------------------------
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
