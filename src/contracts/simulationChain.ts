/**
 * simulationChain.ts
 *
 * Fully offline stand-in for the real chipnet flow (Electrum + CashScript
 * contract calls + Paytaca WalletConnect signing). Used by "Simulation Mode"
 * in App.tsx so the whole demo — seed, buy ticket, draw, resolve — can be
 * run with zero dependency on:
 *   - the chipnet faucet actually having funds
 *   - the chipnet Electrum server being reachable
 *   - Paytaca being installed / a QR scan succeeding
 *
 * Nothing here touches the network. Every function is a pure state
 * transition or a local-only random generator, so it's safe to call from
 * React state setters directly (see App.tsx's `sim*` handlers).
 */

// --- Fake transaction / block identifiers ----------------------------------

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A realistic-looking 32-byte txid, entirely local — never broadcast. */
export function fakeTxid(): string {
  return randomHex(32);
}

/** A realistic-looking 32-byte block hash, entirely local. */
export function fakeBlockHash(): string {
  return randomHex(32);
}

// --- Simulated per-slot contract state --------------------------------------

export interface SimTicket {
  id: string;
  pickedNumber: bigint;
  numbers: number[];
}

export interface SimSlotState {
  /** Mirrors `contractUtxo.satoshis` in the real flow. */
  contractSats: bigint;
  tickets: SimTicket[];
}

export function emptySimSlot(): SimSlotState {
  return { contractSats: 0n, tickets: [] };
}

/** Mirrors seedContract() / seedContractViaPaytaca(). */
export function simSeed(state: SimSlotState, amountSats: bigint): SimSlotState {
  return { ...state, contractSats: state.contractSats + amountSats };
}

/** Mirrors buyTicket() / buyTicketViaPaytaca(). */
export function simBuyTicket(
  state: SimSlotState,
  ticketPriceSats: bigint,
  numbers: number[],
  pickedNumber: bigint,
): SimSlotState {
  const ticket: SimTicket = {
    id: Math.random().toString(36).slice(2, 9),
    pickedNumber,
    numbers,
  };
  return {
    contractSats: state.contractSats + ticketPriceSats,
    tickets: [...state.tickets, ticket],
  };
}

/** Mirrors resolveDraw() / resolveDrawViaPaytaca() — pays out and empties the pool. */
export function simResolve(state: SimSlotState): SimSlotState {
  return { ...state, contractSats: 0n };
}

// --- Simulated draw (replaces real block-hash-derived randomness) ----------

export interface SimResolvedDraw {
  gameId: string;
  slotEpochMs: number;
  blockHeight: number;
  blockHash: string;
  winningNumber: number;
  numbers: number[];
}

/**
 * Locally generates a "winning number" the same way the real flow derives
 * one from a block hash — just using crypto.getRandomValues() instead of an
 * actual chipnet block, since Simulation Mode never touches the network.
 */
export function simulateDraw(
  gameId: string,
  slotEpochMs: number,
  maxTicketRange: number,
  pickCount: number,
): SimResolvedDraw {
  const randomBytes = crypto.getRandomValues(new Uint32Array(1))[0];
  const winningNumber = (randomBytes % maxTicketRange) + 1;
  const numbers = String(winningNumber - 1)
    .padStart(pickCount, "0")
    .split("")
    .map(Number);

  return {
    gameId,
    slotEpochMs,
    // Fake but plausible-looking chipnet block height for the demo UI.
    blockHeight: 1_700_000 + Math.floor(Math.random() * 5000),
    blockHash: fakeBlockHash(),
    winningNumber,
    numbers,
  };
}

/** A fixed placeholder cashaddr shown when no real wallet is connected in Simulation Mode. */
export const SIMULATED_ADDRESS =
  "bchtest:qsimulated00000000000000000000000000demo";

/** Generous fake balance so Simulation Mode never blocks on "insufficient funds". */
export const SIMULATED_BALANCE_SATS = 5_000_000n; // 0.05 BCH
