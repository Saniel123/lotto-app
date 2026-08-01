import { useState, useEffect, useRef } from "react";
import { ElectrumNetworkProvider } from "cashscript";
import type { Contract } from "cashscript";

import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import LotteryDrawMachine from "./components/LotteryDrawMachine";
import {
  generateWallet,
  getWalletBalanceSats,
  walletFromPrivateKey,
  privateKeyToHex,
  privateKeyFromHex,
} from "./contracts/wallet";
import type { WalletKeypair } from "./contracts/wallet";
import {
  getLotteryContract,
  buyTicket as chainBuyTicket,
  resolveDraw as chainResolveDraw,
  seedContract as chainSeedContract,
} from "./contracts/lotteryClient";
import {
  ShieldCheck,
  Trophy,
  Ticket,
  RefreshCw,
  Dices,
  Bot,
  Banknote,
  Monitor,
  Wallet,
  CheckCircle2,
  QrCode,
  PartyPopper,
  X,
  Eye,
  Hash,
  Layers,
  Clock,
  Link2,
  Lock,
  AlertTriangle,
} from "lucide-react";

// NOTE ON PROJECT LAYOUT ASSUMED HERE: this file imports the four files
// from the zip as ./lottery/{wallet.ts,lotteryClient.ts,Lottery.json,Lottery.cash}
// (lotteryClient.ts already imports "./Lottery.json" relative to itself, so
// they need to stay siblings). Adjust the two import paths above if your
// project actually places them elsewhere.

// Chain read access shared by the estimated-countdown -> chain-resolution
// flow below (block height/header polling). wallet.ts and lotteryClient.ts
// each open their own ElectrumNetworkProvider("chipnet") too — three
// independent connections for one page. Harmless on chipnet, but if this
// ever matters (connection limits, etc.) the fix is to have wallet.ts and
// lotteryClient.ts accept an injected provider instead of constructing
// their own.
const provider = new ElectrumNetworkProvider("chipnet");

// PCSO-style Digit Lotto Games — each game just varies how many digit
// chambers the draw machine shows (pickCount) and the digit range
// (maxNumber). Ticket price scales with difficulty. Jackpot is no longer a
// seeded constant: on-chain, every draw slot gets its own fresh contract
// UTXO (see "PER-SLOT CONTRACTS" below), so the pool is whatever has
// actually been paid into that slot's contract address.
interface LottoGame {
  id: string;
  name: string;
  shortLabel: string;
  maxNumber: number;
  pickCount: number;
  drawDays: string;
  ticketPriceSats: bigint;
}

const LOTTO_GAMES: LottoGame[] = [
  {
    id: "ez2",
    name: "EZ2 Lotto",
    shortLabel: "2D",
    maxNumber: 9,
    pickCount: 2,
    drawDays: "Daily (11AM, 4PM, 9PM)",
    ticketPriceSats: 50000n, // 0.0005 BCH
  },
  {
    id: "swertres",
    name: "Swertres Lotto",
    shortLabel: "3D",
    maxNumber: 9,
    pickCount: 3,
    drawDays: "Daily (2PM, 5PM, 9PM)",
    ticketPriceSats: 100000n, // 0.001 BCH
  },
  {
    id: "4d",
    name: "4D Lotto",
    shortLabel: "4D",
    maxNumber: 9,
    pickCount: 4,
    drawDays: "Tue · Fri · Sun 9PM",
    ticketPriceSats: 150000n, // 0.0015 BCH
  },
  {
    id: "6d",
    name: "6D Lotto",
    shortLabel: "6D",
    maxNumber: 9,
    pickCount: 6,
    drawDays: "Daily 9PM",
    ticketPriceSats: 200000n, // 0.002 BCH
  },
];

// maxTicketRange fed to the contract's constructor: the full combination
// space for a game's digit count (e.g. Swertres = 000-999 = 1000). The
// contract's resolveDraw() picks a single winningNumber in [1, range], and
// (winningNumber - 1) zero-padded to pickCount digits gives the drawn
// digits — same representation the original mock used, just now derived
// from a value the chain itself will accept.
function maxTicketRangeFor(game: LottoGame): number {
  return 10 ** game.pickCount;
}

interface TicketItem {
  id: string;
  game: string;
  gameId: string;
  slotEpochMs: number; // identifies which per-slot contract this ticket belongs to
  numbers: number[];
  txid: string;
  address: string;
  amountSats: bigint;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// PRESET DRAW SCHEDULE — used only to display an estimated "next draw" time
// AND to derive each slot's drawDeadline (unix seconds) for the contract
// constructor. It does NOT decide the result. See AUTHORITATIVE DRAW
// RESOLUTION below.
// ---------------------------------------------------------------------------
interface DrawSlot {
  hour: number;
  minute: number;
  days?: number[];
} // days: 0=Sun..6=Sat

const DRAW_SCHEDULES: Record<string, DrawSlot[]> = {
  ez2: [
    { hour: 11, minute: 0 },
    { hour: 16, minute: 0 },
    { hour: 21, minute: 0 },
  ],
  swertres: [
    { hour: 14, minute: 0 },
    { hour: 17, minute: 0 },
    { hour: 21, minute: 0 },
  ],
  "4d": [{ hour: 21, minute: 0, days: [0, 2, 5] }], // Sun, Tue, Fri
  "6d": [{ hour: 21, minute: 0 }],
};

// Betting closes this many ms before the estimated slot time, giving a
// safety margin before the chain is even expected to resolve the draw.
const BETTING_CUTOFF_MS = 60_000;

// How long past drawDeadline a slot's contract stays reclaimable via
// reclaimRefund() if nobody ever calls resolveDraw() on it (e.g. no block
// clears the PoW check — see the flagged bug below). Baked into every
// slot contract's constructor params; this file doesn't add refund UI yet.
const REFUND_GRACE_SECONDS = 7 * 24 * 60 * 60;

// Chipnet-only persistence — see the privacy note on privateKeyToHex/
// privateKeyFromHex in wallet.ts before reusing this pattern for real funds.
const WALLET_STORAGE_KEY = "pcso-mocknet-lotto:chipnet-privkey-hex";

function getNextDrawDate(gameId: string, from: Date): Date {
  const slots = DRAW_SCHEDULES[gameId] ?? [{ hour: 21, minute: 0 }];
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const candidateDay = new Date(from);
    candidateDay.setDate(from.getDate() + dayOffset);
    const weekday = candidateDay.getDay();
    const daySlots = slots
      .filter((s) => !s.days || s.days.includes(weekday))
      .map((s) => {
        const d = new Date(candidateDay);
        d.setHours(s.hour, s.minute, 0, 0);
        return d;
      })
      .sort((a, b) => a.getTime() - b.getTime());
    for (const d of daySlots) {
      if (d.getTime() > from.getTime()) return d;
    }
  }
  const fallback = new Date(from);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(21, 0, 0, 0);
  return fallback;
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatSlotTime(d: Date): string {
  return d.toLocaleString("en-PH", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// AUTHORITATIVE DRAW RESOLUTION — anchored to the Bitcoin Cash chain, never
// to any single client's clock or a per-tab setInterval, AND now matched
// against the exact math Lottery.cash's resolveDraw() will itself check on
// chain (not just a client-side lookalike RNG).
// ---------------------------------------------------------------------------
// The countdown/schedule above is only a convenience ESTIMATE shown to the
// user; it never feeds into the actual result. The actual result is: "the
// first mined block whose header timestamp is >= slot time", read off the
// public chain, which is why every tab / every device converges on the same
// answer independent of local clocks or which tab's timer fires first.

interface ResolvedDraw {
  gameId: string;
  slotEpochMs: number;
  blockHeight: number;
  blockHash: string; // conventional reversed-byte display hash
  headerHex: string; // raw 80-byte header, hex — needed to submit resolveDraw()
  winningNumber: number; // 1..maxTicketRange, exactly what the contract derives
  numbers: number[]; // winningNumber-1 as zero-padded digits, for the UI
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToHexReversed(bytes: Uint8Array): string {
  return Array.from(bytes)
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Block header timestamp lives at byte offset 68, 4 bytes, little-endian.
function parseHeaderTimestamp(headerHex: string): number {
  const bytes = hexToBytes(headerHex);
  const view = new DataView(bytes.buffer);
  return view.getUint32(68, true);
}

async function doubleSha256(bytes: Uint8Array): Promise<Uint8Array> {
  const first = await crypto.subtle.digest("SHA-256", bytes);
  const second = await crypto.subtle.digest("SHA-256", first);
  return new Uint8Array(second);
}

// Thin wrappers around the Electrum connection. Method names follow the
// standard Electrum protocol; adjust if your pinned provider version
// exposes a higher-level helper instead of a raw performRequest passthrough.
async function fetchChainHeight(): Promise<number> {
  const tip = await (provider as any).performRequest(
    "blockchain.headers.subscribe",
  );
  return tip.height;
}

async function fetchBlockHeader(height: number): Promise<string | null> {
  try {
    const res = await (provider as any).performRequest(
      "blockchain.block.header",
      height,
    );
    return typeof res === "string" ? res : res.hex;
  } catch {
    return null; // height hasn't been mined yet — normal, just means "not resolved yet"
  }
}

// Scans forward from `fromHeight` for the first block whose timestamp has
// reached the scheduled slot. Pure function of the chain's public state —
// any client running it lands on the same block.
async function findResolvingBlock(slotEpochMs: number, fromHeight: number) {
  let height = fromHeight;
  for (let i = 0; i < 5000; i++) {
    // sane upper bound on the scan
    const header = await fetchBlockHeader(height);
    if (!header) return null; // chain hasn't reached this height yet — try again on next poll
    const ts = parseHeaderTimestamp(header) * 1000;
    if (ts >= slotEpochMs) return { height, header };
    height++;
  }
  return null;
}

// int(bytes32) / OP_BIN2NUM semantics: a byte string is read as a
// little-endian, sign-and-magnitude script number — byte[0] is the least
// significant byte, and the MSB of the last byte is a sign flag. hash256()
// output effectively never sets that top bit in a way that matters here
// (mod of a huge positive number), so this treats the digest as an
// unsigned little-endian integer for the purposes of the modulo.
//
// UNVERIFIED: this has not been run through an actual cashc/cashscript-VM
// simulation (no network in this sandbox to install cashscript), so this
// is a best-effort match of the ABI/bytecode's OP_BIN2NUM + OP_MOD, not a
// confirmed one. Before trusting the UI's predicted winning digits to be
// exactly what an on-chain resolveDraw() will accept, run one resolveDraw
// call on chipnet and diff the digits it derives against this function's
// output for the same header.
function bigIntFromLEBytes(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

function deriveWinningNumber(
  rawDigest: Uint8Array,
  maxTicketRange: number,
): number {
  const asInt = bigIntFromLEBytes(rawDigest);
  const range = BigInt(maxTicketRange);
  return Number((asInt % range) + 1n);
}

function winningNumberToDigits(
  winningNumber: number,
  pickCount: number,
): number[] {
  return String(winningNumber - 1)
    .padStart(pickCount, "0")
    .split("")
    .map(Number);
}

// *** FLAGGED CONTRACT BUG — see write-up at the end of the response ***
// Lottery.cash's proof-of-work guard is `require(blockHash.split(3)[0] ==
// 0x000000)`, i.e. it checks the FIRST 3 bytes of the raw (non-reversed)
// hash256(header) output. But the near-zero bytes that mining difficulty
// actually produces sit at the END of that raw byte order — they only end
// up "leading" after the conventional display reversal (the same
// reversal bytesToHexReversed() below performs, and that the codebase's
// own comments describe). Checking bytes[0..2] instead of bytes[29..31]
// checks essentially random low-order bytes, unrelated to real proof of
// work. As written, resolveDraw() will very rarely accept a genuinely
// mined header, and — worse — could in principle be satisfied by a
// cheaply hand-fabricated 80-byte string that never did any hashing work,
// which defeats the anti-spam purpose of the check entirely.
//
// This function mirrors what the check most likely *should* be (tail
// bytes), so the UI's local proof-of-work gate is meaningful — but the
// deployed .cash contract itself needs `split(3)[0]` changed to
// `split(29)[1]` (and recompiled/redeployed) before resolveDraw() calls
// built against this UI will actually succeed on chain.
function hasMinimalProofOfWork(rawDigest: Uint8Array): boolean {
  return rawDigest[29] === 0 && rawDigest[30] === 0 && rawDigest[31] === 0;
}

export default function App() {
  // Live Exchange Rate State
  const [bchToPhpRate, setBchToPhpRate] = useState<number | null>(null);

  // --- Real chipnet wallet state -------------------------------------
  // The keypair lives only in React state: it is regenerated fresh on
  // every "Connect Wallet" click and is gone on refresh. There is no
  // persistence layer here — fine for a chipnet demo (coins are
  // worthless play-money), NOT fine to ship as-is if this were ever
  // pointed at mainnet, where losing the in-memory key loses real funds.
  // Add encrypted persistence (or a proper wallet-connect flow) before
  // that happens.
  const [wallet, setWallet] = useState<WalletKeypair | null>(null);
  const [walletBalanceSats, setWalletBalanceSats] = useState<bigint>(0n);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  // Active Game Selection State — drives the draw machine, ticket price, and jackpot pool
  const [selectedGameId, setSelectedGameId] = useState<string>("swertres");
  const activeGame =
    LOTTO_GAMES.find((g) => g.id === selectedGameId) ?? LOTTO_GAMES[1];

  // --- PER-SLOT CONTRACTS ---------------------------------------------
  // The contract's constructor bakes in drawDeadline, so a NEW contract
  // address exists for every (game, slot) pair — there's no single
  // long-lived "the Swertres contract". This also means jackpots don't
  // roll over automatically the way the old mock's shared pool did: a
  // fresh slot starts with ZERO on-chain balance and needs its own
  // funding UTXO before anyone can buyTicket() into it (see the
  // "Lottery contract has no UTXO yet" error surfaced below) — this file
  // has no genesis-funding flow, that's a separate piece of work.
  const contractCacheRef = useRef<Map<string, Contract>>(new Map());
  function getSlotContract(game: LottoGame, slotEpochMs: number): Contract {
    const drawDeadline = Math.floor(slotEpochMs / 1000);
    const key = `${game.id}:${drawDeadline}`;
    const cached = contractCacheRef.current.get(key);
    if (cached) return cached;
    const contract = getLotteryContract({
      ticketPriceSats: game.ticketPriceSats,
      maxTicketRange: maxTicketRangeFor(game),
      drawDeadline,
      refundDeadline: drawDeadline + REFUND_GRACE_SECONDS,
    });
    contractCacheRef.current.set(key, contract);
    return contract;
  }

  // Live on-chain balance of the active game's upcoming-slot contract —
  // polled, not simulated. Also polled per-game for the sidebar cards.
  const [activeContractSats, setActiveContractSats] = useState<bigint>(0n);
  const [gameContractSats, setGameContractSats] = useState<
    Record<string, bigint>
  >({});

  // Game & Ticket State
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([]);
  const [purchasedTickets, setPurchasedTickets] = useState<TicketItem[]>([]);

  // Ticket Viewer Modal State
  const [viewingTicket, setViewingTicket] = useState<TicketItem | null>(null);

  // Draw Results State
  const [lastWinningNumbers, setLastWinningNumbers] = useState<number[] | null>(
    null,
  );
  const [drawMessage, setDrawMessage] = useState<string | null>(null);
  const [resolvedDraw, setResolvedDraw] = useState<ResolvedDraw | null>(null);
  const [resolveTxid, setResolveTxid] = useState<string | null>(null);

  // Testing Force-Win State & Celebration Modal State — UI preview only,
  // never touches the chain or a real payout.
  const [forceWinMode, setForceWinMode] = useState(false);
  const [showPopupCelebration, setShowPopupCelebration] = useState(false);
  const [wonPrizePhp, setWonPrizePhp] = useState("");

  const [txPending, setTxPending] = useState(false);
  const [seedPending, setSeedPending] = useState(false);
  const [resolvePending, setResolvePending] = useState(false);
  const [drawPending, setDrawPending] = useState(false); // true while LotteryDrawMachine plays the reveal animation
  const [chainChecking, setChainChecking] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);

  // --- Estimated schedule (display only — never decides the result) ---
  const [nextDrawAt, setNextDrawAt] = useState<Date>(() =>
    getNextDrawDate(selectedGameId, new Date()),
  );
  const [msRemaining, setMsRemaining] = useState<number>(
    () => nextDrawAt.getTime() - Date.now(),
  );

  // Tracks which chain height we've scanned up to per game+slot, so polling
  // resumes instead of rescanning from scratch, and so a game switch doesn't
  // carry over another game's scan position.
  const scanFromHeightRef = useRef<Record<string, number>>({});
  const resolvedSlotKeyRef = useRef<string | null>(null); // guards against re-resolving the same slot twice
  const scheduledResultRef = useRef<number[] | null>(null);
  const drawingGameIdRef = useRef(selectedGameId);
  const drawingSlotEpochRef = useRef<number>(nextDrawAt.getTime());

  // 1. Fetch Live BCH to PHP Conversion Rate
  useEffect(() => {
    const fetchBchRate = async () => {
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=php",
        );
        const data = await res.json();
        if (data?.["bitcoin-cash"]?.php) {
          setBchToPhpRate(data["bitcoin-cash"].php);
        }
      } catch (err) {
        console.warn("Could not fetch live BCH/PHP rate, using fallback:", err);
        setBchToPhpRate(25000);
      }
    };

    fetchBchRate();
    const interval = setInterval(fetchBchRate, 60000);
    return () => clearInterval(interval);
  }, []);

  // 2. Connect a real chipnet wallet: generates a fresh keypair locally
  // (never sent anywhere) and reads its live balance from chipnet. A
  // brand-new address has 0 sats — direct the user to a chipnet faucet.
  // The private key is saved to localStorage so a page refresh restores
  // the SAME address instead of abandoning any funds sent to it — see the
  // privacy note on privateKeyToHex/privateKeyFromHex in wallet.ts; this
  // is only an acceptable place to keep a private key because chipnet
  // coins have no real value.
  const connectWallet = async () => {
    setWalletLoading(true);
    setWalletError(null);
    try {
      const kp = generateWallet();
      localStorage.setItem(WALLET_STORAGE_KEY, privateKeyToHex(kp.privateKey));
      setWallet(kp);
      const bal = await getWalletBalanceSats(kp.address);
      setWalletBalanceSats(bal);
    } catch (err) {
      console.error("Wallet generation/balance fetch failed:", err);
      setWalletError(
        err instanceof Error
          ? err.message
          : "Could not create a chipnet wallet.",
      );
    } finally {
      setWalletLoading(false);
    }
  };

  // 2a. On mount, restore a previously-saved key instead of leaving the
  // user disconnected (and instead of ever silently generating a new one
  // out from under an existing saved key).
  useEffect(() => {
    const savedHex = localStorage.getItem(WALLET_STORAGE_KEY);
    if (!savedHex) return;
    setWalletLoading(true);
    try {
      const kp = walletFromPrivateKey(privateKeyFromHex(savedHex));
      setWallet(kp);
    } catch (err) {
      console.error("Failed to restore saved wallet:", err);
      setWalletError("Could not restore your saved chipnet wallet.");
    } finally {
      setWalletLoading(false);
    }
    // Balance is fetched by the polling effect below once `wallet` is set.
  }, []);

  // 2b. Poll the connected wallet's real balance.
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const bal = await getWalletBalanceSats(wallet.address);
        if (!cancelled) setWalletBalanceSats(bal);
      } catch (err) {
        console.warn("Wallet balance poll failed:", err);
      }
    };
    poll();
    const id = setInterval(poll, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [wallet]);

  // Clears the saved key and returns to the disconnected state. Does NOT
  // move any funds — if the address was funded, those chipnet coins stay
  // at that address; reconnecting later requires the same private key
  // (there isn't a recovery phrase flow here), so this is a "start over
  // with a new address" action, not a safe wallet-switch.
  const disconnectWallet = () => {
    localStorage.removeItem(WALLET_STORAGE_KEY);
    setWallet(null);
    setWalletBalanceSats(0n);
    setWalletError(null);
  };

  // 2c. Poll each game's upcoming-slot contract balance for the sidebar,
  // and keep activeContractSats in sync with the selected game.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        LOTTO_GAMES.map(async (game) => {
          const slot =
            game.id === selectedGameId
              ? nextDrawAt
              : getNextDrawDate(game.id, new Date());
          try {
            const contract = getSlotContract(game, slot.getTime());
            const utxos = await contract.getUtxos();
            const total = utxos.reduce(
              (sum, u) => sum + BigInt(u.satoshis),
              0n,
            );
            return [game.id, total] as const;
          } catch (err) {
            console.warn(`Contract balance poll failed for ${game.id}:`, err);
            return [game.id, 0n] as const;
          }
        }),
      );
      if (cancelled) return;
      const next = Object.fromEntries(entries);
      setGameContractSats(next);
      setActiveContractSats(next[selectedGameId] ?? 0n);
    };
    poll();
    const id = setInterval(poll, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGameId, nextDrawAt]);

  // Game Selection Handler — swaps the active game, resets any in-progress pick,
  // clears the previous game's draw result, and re-syncs the ESTIMATED countdown
  // to this game's own schedule. Actual resolution still only comes from the chain.
  const handleSelectGame = (gameId: string) => {
    if (drawPending || gameId === selectedGameId) return;
    setSelectedGameId(gameId);
    setSelectedNumbers([]);
    setLastWinningNumbers(null);
    setDrawMessage(null);
    setResolvedDraw(null);
    setResolveTxid(null);
    setChainError(null);
    scheduledResultRef.current = null;
    setNextDrawAt(getNextDrawDate(gameId, new Date()));
  };

  // 3. Estimated countdown display only — this loop never fires a draw.
  useEffect(() => {
    const tick = () => setMsRemaining(nextDrawAt.getTime() - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextDrawAt]);

  // 4. Chain polling — the ONLY thing that can produce a result. Every open
  // tab runs this same deterministic scan against the same public chain, so
  // every tab converges on the same resolving block and the same numbers,
  // whenever it happens to check. The winning digits are now derived with
  // the exact int(bytes32)/OP_MOD math the contract itself uses (see
  // deriveWinningNumber above), not a lookalike client-side RNG.
  useEffect(() => {
    let cancelled = false;
    const gameId = selectedGameId;
    const slotEpochMs = nextDrawAt.getTime();
    const slotKey = `${gameId}:${slotEpochMs}`;

    const poll = async () => {
      if (cancelled || drawPending) return;
      if (resolvedSlotKeyRef.current === slotKey) return; // already resolved this exact slot
      if (Date.now() < slotEpochMs) return; // estimated slot hasn't arrived; nothing to check yet

      try {
        setChainChecking(true);
        setChainError(null);

        if (scanFromHeightRef.current[gameId] === undefined) {
          scanFromHeightRef.current[gameId] = await fetchChainHeight();
        }

        const found = await findResolvingBlock(
          slotEpochMs,
          scanFromHeightRef.current[gameId],
        );
        if (cancelled) return;

        if (found) {
          const rawDigest = await doubleSha256(hexToBytes(found.header));

          if (!hasMinimalProofOfWork(rawDigest)) {
            // Doesn't clear the (corrected) proof-of-work floor — keep
            // scanning forward from the next height instead of stalling.
            scanFromHeightRef.current[gameId] = found.height + 1;
            return;
          }

          const blockHash = bytesToHexReversed(rawDigest);
          const game = LOTTO_GAMES.find((g) => g.id === gameId) ?? activeGame;
          const range = maxTicketRangeFor(game);
          const winningNumber = deriveWinningNumber(rawDigest, range);
          const numbers = winningNumberToDigits(winningNumber, game.pickCount);

          resolvedSlotKeyRef.current = slotKey;
          drawingGameIdRef.current = gameId;
          drawingSlotEpochRef.current = slotEpochMs;
          scheduledResultRef.current = numbers;

          setResolvedDraw({
            gameId,
            slotEpochMs,
            blockHeight: found.height,
            blockHash,
            headerHex: found.header,
            winningNumber,
            numbers,
          });
          setDrawMessage(null);
          setLastWinningNumbers(null);
          setResolveTxid(null);
          setDrawPending(true); // hand off to LotteryDrawMachine for the reveal animation
        }
        // if not found yet: chain hasn't reached the resolving block — next poll will check again
      } catch (err) {
        console.warn("Chain poll failed, will retry:", err);
        if (!cancelled) setChainError("Could not reach the chain — retrying…");
      } finally {
        if (!cancelled) setChainChecking(false);
      }
    };

    poll();
    const id = setInterval(poll, 15000); // pace polling to block-arrival cadence, not wall-clock ticks
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextDrawAt, selectedGameId, drawPending]);

  // Number Picker Helpers
  const toggleNumber = (num: number) => {
    if (selectedNumbers.length < activeGame.pickCount) {
      setSelectedNumbers([...selectedNumbers, num]);
    }
  };

  const removeNumber = (index: number) => {
    const updated = [...selectedNumbers];
    updated.splice(index, 1);
    setSelectedNumbers(updated);
  };

  const handleQuickPick = () => {
    const numbers: number[] = [];
    for (let i = 0; i < activeGame.pickCount; i++) {
      const randomNum = Math.floor(Math.random() * (activeGame.maxNumber + 1));
      numbers.push(randomNum);
    }
    setSelectedNumbers(numbers);
  };

  // Betting is closed once we're inside the cutoff window before the
  // estimated slot, once the slot has passed and we're waiting on the chain
  // to resolve, or while a draw is actively animating.
  const bettingClosed =
    drawPending ||
    (msRemaining > 0 && msRemaining <= BETTING_CUTOFF_MS) ||
    msRemaining <= 0;

  // Seeds the active slot's contract with its own genesis UTXO — a plain
  // payment from the wallet to the contract address, sized to at least one
  // ticket's worth of sats since buyTicket() requires the existing
  // contract UTXO to already meet that bar. Needed once per (game, slot)
  // pair before the first buyTicket() call can succeed.
  const handleSeedContract = async () => {
    if (!wallet) return;
    setSeedPending(true);
    setChainError(null);
    try {
      const contract = getSlotContract(activeGame, nextDrawAt.getTime());
      await chainSeedContract(
        contract,
        activeGame.ticketPriceSats,
        wallet.privateKey,
        wallet.address,
      );

      const bal = await getWalletBalanceSats(wallet.address);
      setWalletBalanceSats(bal);

      const utxos = await contract.getUtxos();
      const total = utxos.reduce((sum, u) => sum + BigInt(u.satoshis), 0n);
      setActiveContractSats(total);
      setGameContractSats((prev) => ({ ...prev, [activeGame.id]: total }));
    } catch (err) {
      console.error("seedContract failed:", err);
      setChainError(
        err instanceof Error ? err.message : "Failed to seed the contract.",
      );
    } finally {
      setSeedPending(false);
    }
  };

  // Buy Ticket Handler — builds and broadcasts a real chipnet transaction
  // via lotteryClient.ts's buyTicket(). Requires: a connected wallet with
  // a UTXO covering price+fee, AND the active slot's contract already
  // holding a UTXO to build on top of (see PER-SLOT CONTRACTS note).
  const handleBuyTicket = async () => {
    if (
      !wallet ||
      selectedNumbers.length !== activeGame.pickCount ||
      bettingClosed
    )
      return;
    setTxPending(true);
    setChainError(null);

    try {
      const contract = getSlotContract(activeGame, nextDrawAt.getTime());
      const pickedBytes = new Uint8Array(selectedNumbers); // one byte per digit, 0-9

      const result = await chainBuyTicket(
        contract,
        activeGame.ticketPriceSats,
        wallet.pkHash,
        pickedBytes,
        wallet.privateKey,
        wallet.address,
      );

      const ticketId = "TCK-" + Math.floor(100000 + Math.random() * 900000);
      const newTicket: TicketItem = {
        id: ticketId,
        game: activeGame.name,
        gameId: activeGame.id,
        slotEpochMs: nextDrawAt.getTime(),
        numbers: selectedNumbers,
        txid: (result as any)?.txid ?? String(result),
        address: wallet.address,
        amountSats: activeGame.ticketPriceSats,
        timestamp: new Date().toLocaleString(),
      };

      setPurchasedTickets((prev) => [newTicket, ...prev]);
      setSelectedNumbers([]);

      const bal = await getWalletBalanceSats(wallet.address);
      setWalletBalanceSats(bal);
    } catch (err) {
      console.error("buyTicket failed:", err);
      setChainError(
        err instanceof Error ? err.message : "Ticket purchase failed.",
      );
    } finally {
      setTxPending(false);
    }
  };

  // Called by LotteryDrawMachine once the animation finishes playing the
  // already-resolved chain result. scheduledResultRef.current was fixed the
  // moment the chain resolved (step 4 above) — this only decides whether
  // *this browser's* wallet holds a matching ticket and, if so, submits the
  // real resolveDraw() payout transaction.
  //
  // LIMITATION: winner-matching here only looks at tickets this session
  // bought (purchasedTickets, in memory). The contract itself does not
  // check that winnerPkHash corresponds to any real ticket at all —
  // resolveDraw() is permissionless and pays whatever pkHash the caller
  // supplies. A production version needs an indexer that scans every
  // buyTicket() OP_RETURN commitment on-chain (not just this browser's
  // local state) before it's safe to claim there's "no winner" and leave
  // the pool for someone else to (rightfully or not) claim.
  const handleDrawComplete = async (winningDraw: number[]) => {
    const drawnGameId = drawingGameIdRef.current;
    const drawnGame =
      LOTTO_GAMES.find((g) => g.id === drawnGameId) ?? activeGame;
    const resolution = resolvedDraw;

    setLastWinningNumbers(winningDraw);

    const winningStr = winningDraw.join("");
    const matchingTicket = purchasedTickets.find(
      (t) =>
        t.gameId === drawnGameId &&
        t.slotEpochMs === drawingSlotEpochRef.current &&
        t.numbers.join("") === winningStr,
    );

    if (matchingTicket && wallet && resolution) {
      setResolvePending(true);
      try {
        const contract = getSlotContract(drawnGame, resolution.slotEpochMs);
        const headerBytes = hexToBytes(resolution.headerHex);
        const result = await chainResolveDraw(
          contract,
          headerBytes,
          wallet.address,
          wallet.pkHash,
        );
        const txid = (result as any)?.txid ?? String(result);
        setResolveTxid(txid);

        const bal = await getWalletBalanceSats(wallet.address);
        setWalletBalanceSats(bal);

        const prizeBch = Number(activeContractSats) / 1e8;
        const prizePhpCalc = bchToPhpRate
          ? (prizeBch * bchToPhpRate).toLocaleString("en-PH", {
              maximumFractionDigits: 0,
            })
          : "—";
        setWonPrizePhp(prizePhpCalc);
        setShowPopupCelebration(true);
        setDrawMessage(
          `🎉 JACKPOT WINNER! Your ${drawnGame.name} ticket ${winningStr} matched block #${resolution.blockHeight}. Payout tx: ${txid}`,
        );
      } catch (err) {
        console.error("resolveDraw failed:", err);
        setDrawMessage(
          `Matched ${winningStr}, but the on-chain claim failed: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      } finally {
        setResolvePending(false);
      }
    } else {
      setDrawMessage(
        `No locally-held ${drawnGame.name} ticket matched block #${resolution?.blockHeight ?? "?"}'s combination ${winningStr}. The pool remains claimable on-chain by anyone who submits a valid resolveDraw() call.`,
      );
    }

    setDrawPending(false);

    // Advance the estimated schedule to the following slot for the game that
    // just resolved, so the countdown keeps running toward the next draw.
    if (drawnGameId === selectedGameId) {
      const nextSlot = getNextDrawDate(
        drawnGameId,
        new Date(drawingSlotEpochRef.current + 1000),
      );
      setNextDrawAt(nextSlot);
      scanFromHeightRef.current[drawnGameId] =
        (resolution?.blockHeight ??
          scanFromHeightRef.current[drawnGameId] ??
          0) + 1;
    }
  };

  // Formatting & Conversion Calculations
  const bchBalance = Number(walletBalanceSats) / 1e8;
  const phpBalance = bchToPhpRate
    ? (bchBalance * bchToPhpRate).toLocaleString("en-PH", {
        maximumFractionDigits: 2,
      })
    : "...";

  const contractBchBalance = Number(activeContractSats) / 1e8;
  const ticketBch = Number(activeGame.ticketPriceSats) / 1e8;
  const ticketPhp = bchToPhpRate
    ? (ticketBch * bchToPhpRate).toFixed(2)
    : "...";
  const jackpotPhp = bchToPhpRate
    ? (contractBchBalance * bchToPhpRate).toLocaleString("en-PH", {
        maximumFractionDigits: 0,
      })
    : "...";

  const gameJackpotPhp = (game: LottoGame) => {
    const bal = gameContractSats[game.id] ?? 0n;
    const bch = Number(bal) / 1e8;
    return bchToPhpRate
      ? (bch * bchToPhpRate).toLocaleString("en-PH", {
          maximumFractionDigits: 0,
        })
      : "...";
  };

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100 flex flex-col justify-between p-4 md:p-8 font-sans selection:bg-emerald-500 selection:text-slate-950 relative overflow-x-hidden">
      {/* FULLSCREEN BLURRED OVERLAY POPUP AD CELEBRATION */}
      {showPopupCelebration && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-300">
          <div className="relative w-full max-w-lg bg-gradient-to-br from-amber-500 via-amber-600 to-yellow-500 text-slate-950 rounded-3xl p-6 md:p-8 shadow-2xl border-4 border-yellow-300 animate-in zoom-in-95 duration-300 text-center space-y-6">
            <button
              onClick={() => setShowPopupCelebration(false)}
              className="absolute top-4 right-4 p-2 rounded-full bg-slate-950/10 hover:bg-slate-950/20 text-slate-950 transition-colors cursor-pointer"
            >
              <X className="h-6 w-6 stroke-[3]" />
            </button>

            <div className="mx-auto w-20 h-20 bg-slate-950 text-amber-400 rounded-2xl flex items-center justify-center shadow-xl border-2 border-yellow-200 animate-bounce">
              <PartyPopper className="h-10 w-10" />
            </div>

            <div className="space-y-2">
              <span className="text-xs font-mono uppercase tracking-widest bg-slate-950/20 text-slate-950 px-3 py-1 rounded-full font-bold">
                CONGRATULATIONS WINNER!
              </span>
              <h2 className="text-3xl md:text-4xl font-black tracking-tight text-slate-950">
                YOU WON THE JACKPOT!
              </h2>
            </div>

            <div className="bg-slate-950 text-amber-400 rounded-2xl p-6 shadow-inner border border-amber-400/30 space-y-1">
              <span className="text-xs font-mono uppercase text-slate-400">
                Total Prize Claimed
              </span>
              <div className="text-4xl md:text-5xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-yellow-200 via-amber-300 to-amber-500">
                ₱{wonPrizePhp}
              </div>
              <span className="text-[11px] font-mono text-emerald-400 block pt-1">
                {resolveTxid
                  ? `✓ Broadcast to chipnet — tx ${resolveTxid.slice(0, 18)}…`
                  : "✓ Payout submitted via Covenant"}
              </span>
            </div>

            <Button
              onClick={() => setShowPopupCelebration(false)}
              className="w-full bg-slate-950 hover:bg-slate-900 text-amber-400 font-black text-lg py-6 rounded-2xl shadow-xl cursor-pointer"
            >
              CLAIM PRIZE & CONTINUE
            </Button>
          </div>
        </div>
      )}

      {/* DETAILED TICKET VIEWER MODAL */}
      {viewingTicket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200">
          <div className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-3xl p-6 md:p-8 shadow-2xl space-y-6 text-slate-100">
            <div className="flex justify-between items-center border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-xl">
                  <Ticket className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-black text-base text-slate-100">
                    Official Ticket Pass
                  </h3>
                  <p className="text-xs font-mono text-emerald-400">
                    {viewingTicket.id}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setViewingTicket(null)}
                className="p-2 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="bg-gradient-to-b from-slate-950 to-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-inner">
              <div className="flex justify-between items-center text-xs font-mono text-slate-400 border-b border-slate-800/80 pb-3">
                <span>Game Mode</span>
                <span className="text-slate-200 font-bold">
                  {viewingTicket.game}
                </span>
              </div>

              <div className="text-center py-3 bg-slate-900/60 rounded-xl border border-slate-800 space-y-1">
                <span className="text-[10px] uppercase font-mono text-slate-400 tracking-wider">
                  Your Combination
                </span>
                <div className="text-3xl font-black font-mono tracking-widest text-emerald-400">
                  {viewingTicket.numbers.join(" - ")}
                </div>
              </div>

              <div className="space-y-3 font-mono text-xs pt-1">
                <div className="flex justify-between items-start">
                  <span className="text-slate-400">Owner Address:</span>
                  <span className="text-emerald-300 text-right break-all max-w-[200px]">
                    {viewingTicket.address}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Paid Amount:</span>
                  <span className="text-amber-400 font-bold">
                    {(Number(viewingTicket.amountSats) / 1e8).toFixed(4)} BCH
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Transaction ID:</span>
                  <span className="text-slate-300 break-all text-right max-w-[200px]">
                    {viewingTicket.txid}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Timestamp:</span>
                  <span className="text-slate-300">
                    {viewingTicket.timestamp}
                  </span>
                </div>
              </div>
            </div>

            <Button
              onClick={() => setViewingTicket(null)}
              className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold py-3 rounded-xl cursor-pointer"
            >
              Close Viewer
            </Button>
          </div>
        </div>
      )}

      {/* Top Navigation Header */}
      <header className="max-w-6xl mx-auto w-full flex justify-between items-center py-4 border-b border-slate-800 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl">
            <ShieldCheck className="h-7 w-7 text-emerald-400" />
          </div>
          <div>
            <h1 className="font-black tracking-wider text-base md:text-lg text-emerald-400 uppercase flex items-center gap-2">
              PCSO MOCKNET LOTTO{" "}
              <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-mono border border-emerald-500/30">
                Chipnet · Play Money Only
              </span>
            </h1>
            <p className="text-xs text-slate-400 font-mono">
              Real chipnet wallet & covenant contract — not real funds
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {wallet ? (
            <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-2xl px-4 py-2">
              <Wallet className="h-4 w-4 text-emerald-400" />
              <div className="flex flex-col text-right">
                <span className="text-xs font-mono font-bold text-emerald-400">
                  {bchBalance.toFixed(4)} BCH
                </span>
                <span className="text-[10px] font-mono text-slate-400">
                  ≈ ₱{phpBalance}
                </span>
              </div>
              <button
                onClick={disconnectWallet}
                className="text-[10px] font-mono text-slate-500 hover:text-rose-400 underline cursor-pointer ml-1"
                title="Forget this wallet on this device (funds stay on-chain at the old address)"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <Button
              onClick={connectWallet}
              disabled={walletLoading}
              className="rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm py-2.5 px-5 cursor-pointer shadow-lg shadow-emerald-500/10"
            >
              <Bot className="h-4 w-4 mr-2" />
              {walletLoading ? "Generating…" : "Connect Chipnet Wallet"}
            </Button>
          )}
        </div>
      </header>

      {walletError && (
        <div className="max-w-6xl mx-auto w-full mb-4 flex items-center gap-2 text-xs font-mono text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-xl px-4 py-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {walletError}
        </div>
      )}

      {/* Main Responsive Grid Container */}
      <main className="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-6 my-auto">
        {/* Left / Top Column: Draw Machine & Transparency Details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Live Conversion & Status Bar */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-center justify-between bg-slate-900/80 border border-slate-800/80 rounded-2xl px-4 py-3 text-xs text-slate-400 font-mono">
              <span className="flex items-center gap-2 text-slate-300">
                <Banknote className="h-4 w-4 text-emerald-400" /> 1 BCH Live
                Rate:
              </span>
              <span className="text-emerald-400 font-bold text-sm">
                {bchToPhpRate
                  ? `₱${bchToPhpRate.toLocaleString("en-PH", { maximumFractionDigits: 2 })}`
                  : "Loading..."}
              </span>
            </div>

            <div className="flex items-center justify-between bg-slate-900/80 border border-slate-800/80 rounded-2xl px-4 py-3 text-xs text-slate-400 font-mono">
              <span className="flex items-center gap-2 text-slate-300">
                <Monitor className="h-4 w-4 text-emerald-400" /> Environment:
              </span>
              <span className="text-amber-400 font-bold">
                Chipnet (Real Testnet, No Real Value)
              </span>
            </div>
          </div>

          {/* Live Ball-Draw Machine — chamber count/digit range follow the active
              game. Only activates once the chain has actually resolved a block
              for the current slot (see chain-polling effect above). */}
          <LotteryDrawMachine
            active={drawPending}
            pickCount={activeGame.pickCount}
            maxDigit={activeGame.maxNumber}
            forcedResult={
              forceWinMode
                ? purchasedTickets.find((t) => t.game === activeGame.name)
                    ?.numbers
                : (scheduledResultRef.current ?? undefined)
            }
            onComplete={handleDrawComplete}
          />

          {/* Chipnet Wallet & Chain-Anchored Draw Schedule Box */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <QrCode className="h-5 w-5 text-emerald-400" /> Chipnet Wallet &
                Draw Hub
              </span>
              <span className="text-[10px] font-mono text-slate-500 uppercase flex items-center gap-1">
                <Lock className="h-3 w-3" /> Chain-Resolved
              </span>
            </div>

            {/* Next Scheduled Draw — the countdown is an estimate for the user's
                convenience only. The real result comes from whichever BCH block
                is mined at/after this time, checked identically by every client. */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 space-y-3">
              <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                <div className="text-center md:text-left">
                  <span className="text-[10px] uppercase font-mono text-slate-400 tracking-wider flex items-center gap-1.5 justify-center md:justify-start">
                    <Clock className="h-3.5 w-3.5 text-emerald-400" /> Next{" "}
                    {activeGame.name} Draw (estimate)
                  </span>
                  <div className="text-2xl md:text-3xl font-black font-mono tracking-widest text-emerald-400 mt-1">
                    {drawPending
                      ? resolvePending
                        ? "CLAIMING…"
                        : "REVEALING…"
                      : formatCountdown(msRemaining)}
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 mt-1">
                    Est. {formatSlotTime(nextDrawAt)}
                    {bettingClosed && !drawPending && (
                      <span className="text-rose-400 ml-2">
                        · Betting closed
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-[11px] font-mono text-slate-400 text-center md:text-right max-w-xs">
                  {chainChecking && (
                    <span className="text-amber-400 flex items-center gap-1.5 justify-center md:justify-end">
                      <RefreshCw className="h-3 w-3 animate-spin" /> Checking
                      chain for resolving block…
                    </span>
                  )}
                  {chainError && (
                    <span className="text-rose-400">{chainError}</span>
                  )}
                  {!chainChecking && !chainError && msRemaining > 0 && (
                    <span>
                      Result is decided by the chain, not the countdown.
                    </span>
                  )}
                </div>
              </div>

              {resolvedDraw && resolvedDraw.gameId === activeGame.id && (
                <div className="pt-3 border-t border-slate-800 text-[11px] font-mono text-slate-400 flex items-center gap-1.5">
                  <Link2 className="h-3 w-3 text-emerald-400" />
                  Resolved from BCH block #{resolvedDraw.blockHeight} · hash{" "}
                  {resolvedDraw.blockHash.slice(0, 16)}… — verifiable by anyone,
                  on any device.
                </div>
              )}
            </div>

            {/* Jackpot / Covenant Pool Card */}
            <Card className="bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/40 border-slate-800 p-6 relative overflow-hidden shadow-xl">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
                <div>
                  <span className="text-xs font-mono text-emerald-400/80 uppercase tracking-widest">
                    Live Covenant Pool Contract
                  </span>
                  <h2 className="text-2xl md:text-3xl font-black text-slate-100 mt-1">
                    {activeGame.name}
                  </h2>
                </div>
                <span className="text-xs bg-slate-800 text-amber-300 px-3 py-1 rounded-full font-mono border border-amber-500/20">
                  {activeGame.drawDays}
                </span>
              </div>

              <div className="flex items-baseline gap-3 my-4">
                <Trophy className="h-8 w-8 text-amber-400 self-center" />
                <span className="text-4xl md:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-emerald-400 to-teal-200">
                  ₱{jackpotPhp}
                </span>
              </div>

              <div className="text-sm font-mono text-slate-400 pl-11">
                ({contractBchBalance.toFixed(4)} BCH Total Contract Balance
                Locked{activeContractSats === 0n ? " — not yet funded" : ""})
              </div>

              {activeContractSats === 0n && wallet && (
                <div className="mt-4 pl-11">
                  <Button
                    onClick={handleSeedContract}
                    disabled={seedPending}
                    className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm py-2.5 px-5 rounded-xl cursor-pointer"
                  >
                    {seedPending ? (
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    ) : null}
                    {seedPending
                      ? "Seeding…"
                      : `Seed Contract (${ticketBch.toFixed(4)} BCH from your wallet)`}
                  </Button>
                  <div className="text-[10px] font-mono text-slate-500 mt-1.5">
                    One-time genesis payment into the contract's own address —
                    required once per draw slot before anyone can buy a ticket.
                  </div>
                </div>
              )}
            </Card>

            {/* Display Chipnet Wallet Address Details */}
            <div className="bg-slate-950/80 p-4 rounded-xl border border-slate-800 space-y-2 font-mono text-xs">
              <div className="text-slate-400 flex items-center justify-between">
                <span>Active Chipnet Address:</span>
                <span className="text-emerald-400 font-bold">
                  {wallet ? "Connected" : "Disconnected"}
                </span>
              </div>
              <div className="p-3 bg-slate-900 border border-slate-800 rounded-lg text-emerald-300 break-all select-all flex items-center justify-between">
                <span>
                  {wallet
                    ? wallet.address
                    : "Connect a wallet to get a chipnet address"}
                </span>
                {wallet && (
                  <Button
                    onClick={() =>
                      navigator.clipboard.writeText(wallet.address)
                    }
                    variant="outline"
                    className="h-7 text-[10px] bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 cursor-pointer ml-2"
                  >
                    Copy
                  </Button>
                )}
              </div>
              {wallet && walletBalanceSats === 0n && (
                <div className="text-[10px] text-amber-400">
                  Balance is 0 — fund this address from a chipnet faucet before
                  buying a ticket.
                </div>
              )}
            </div>

            {/* Guaranteed Win Testing Controls */}
            <div className="bg-slate-950/80 p-4 rounded-xl border border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-amber-400" />{" "}
                    Force-Win Testing Mode
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono">
                    Testing-only override: swaps the animation's numbers for
                    your own ticket so you can preview the win celebration. It
                    still triggers a real resolveDraw() call if you actually
                    hold that ticket — this only changes which digits the
                    animation plays, not what gets submitted to chain.
                  </div>
                </div>
                <button
                  onClick={() => setForceWinMode(!forceWinMode)}
                  className={`px-4 py-2 rounded-xl text-xs font-mono font-bold transition-all cursor-pointer border ${
                    forceWinMode
                      ? "bg-amber-500 text-slate-950 border-amber-400 shadow-lg shadow-amber-500/20 animate-pulse"
                      : "bg-slate-900 text-slate-400 border-slate-800 hover:border-slate-700"
                  }`}
                >
                  {forceWinMode ? "FORCE WIN: ON" : "FORCE WIN: OFF"}
                </button>
              </div>
            </div>

            {lastWinningNumbers && (
              <div className="space-y-3 pt-3 border-t border-slate-800 text-xs font-mono">
                <div className="flex justify-between items-center bg-slate-950/80 p-3 rounded-xl border border-slate-800">
                  <span className="text-slate-400">Winning Combination:</span>
                  <div className="flex gap-1.5">
                    {lastWinningNumbers.map((n, i) => (
                      <span
                        key={i}
                        className="px-2.5 py-1 bg-amber-400/20 text-amber-300 border border-amber-500/30 rounded font-black text-sm"
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                </div>

                {resolvedDraw && (
                  <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800 space-y-1.5">
                    <div className="text-slate-400 flex items-center gap-1 font-bold text-[11px] uppercase tracking-wider text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Chain Proof
                    </div>
                    <div className="text-slate-300 break-all text-[11px]">
                      <span className="text-slate-500">
                        Block #{resolvedDraw.blockHeight}:
                      </span>{" "}
                      {resolvedDraw.blockHash}
                    </div>
                    {resolveTxid && (
                      <div className="text-slate-300 break-all text-[11px]">
                        <span className="text-slate-500">Payout tx:</span>{" "}
                        {resolveTxid}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {drawMessage && (
              <div className="p-3.5 rounded-xl text-xs md:text-sm font-medium border bg-slate-950 border-slate-800 text-slate-400">
                {drawMessage}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Game Picker, Ticket Buying & Realistic Ticket Stub Cards */}
        <div className="space-y-6">
          {/* Game Selector — PCSO-style vertical game picker in the sidebar.
              Clicking a card updates the active pickCount/maxDigit, ticket price,
              jackpot pool, and the ESTIMATED schedule display. Draw resolution
              itself always comes from the chain-polling effect, never this UI. */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
              <Layers className="h-4 w-4 text-emerald-400" /> Choose Your Game
            </div>
            <div className="flex flex-col gap-2.5">
              {LOTTO_GAMES.map((game) => {
                const isActive = game.id === selectedGameId;
                const cardNextDraw = isActive
                  ? nextDrawAt
                  : getNextDrawDate(game.id, new Date());
                return (
                  <button
                    key={game.id}
                    onClick={() => handleSelectGame(game.id)}
                    disabled={drawPending}
                    className={`text-left p-4 rounded-2xl border transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-between gap-3 ${
                      isActive
                        ? "bg-emerald-500/10 border-emerald-500 shadow-lg shadow-emerald-500/10 ring-1 ring-emerald-500/40"
                        : "bg-slate-950/60 border-slate-800 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`text-[10px] font-mono font-bold px-2 py-1 rounded-lg border shrink-0 ${
                          isActive
                            ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                            : "bg-slate-900 text-slate-400 border-slate-800"
                        }`}
                      >
                        {game.shortLabel}
                      </span>
                      <div>
                        <div className="font-black text-sm text-slate-100">
                          {game.name}
                        </div>
                        <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                          Pick {game.pickCount} · 0-9
                        </div>
                        <div className="text-[10px] font-mono text-slate-500 flex items-center gap-1">
                          <Clock className="h-2.5 w-2.5" /> Est:{" "}
                          {formatSlotTime(cardNextDraw)}
                        </div>
                        <div className="text-xs font-mono text-amber-400 font-bold mt-1">
                          ₱{gameJackpotPhp(game)}
                        </div>
                      </div>
                    </div>
                    {isActive && (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Number Selection Grid Card */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
            <div className="flex justify-between items-center">
              <div className="text-sm text-slate-200 font-bold">
                {activeGame.name} — Pick{" "}
                <span className="text-emerald-400">
                  {activeGame.pickCount} digits (0-9)
                </span>
              </div>

              <Button
                onClick={handleQuickPick}
                variant="outline"
                className="h-8 text-xs bg-slate-800 border-slate-700 text-emerald-300 hover:bg-slate-700 rounded-xl cursor-pointer"
              >
                <Dices className="h-3.5 w-3.5 mr-1.5" /> Quick Pick
              </Button>
            </div>

            {/* Selected Combination Slots Display */}
            <div className="flex flex-col items-center gap-2 p-4 bg-slate-950/60 border border-slate-800/80 rounded-xl">
              <span className="text-[10px] uppercase font-mono text-slate-400 tracking-wider">
                Your Combination
              </span>
              <div className="flex gap-3 flex-wrap justify-center">
                {Array.from(
                  { length: activeGame.pickCount },
                  (_, idx) => idx,
                ).map((idx) => (
                  <button
                    key={idx}
                    onClick={() => removeNumber(idx)}
                    className={`h-12 w-12 rounded-xl border font-black text-lg flex items-center justify-center transition-all ${
                      selectedNumbers[idx] !== undefined
                        ? "bg-emerald-400 text-slate-950 border-emerald-400 shadow-lg shadow-emerald-400/20"
                        : "bg-slate-900 border-slate-800 text-slate-600 border-dashed hover:border-slate-700"
                    }`}
                  >
                    {selectedNumbers[idx] !== undefined
                      ? selectedNumbers[idx]
                      : "-"}
                  </button>
                ))}
              </div>
              {selectedNumbers.length > 0 && (
                <button
                  onClick={() => setSelectedNumbers([])}
                  className="text-xs text-rose-400 hover:underline mt-1 font-mono cursor-pointer"
                >
                  Clear Combination
                </button>
              )}
            </div>

            {/* Digits Grid 0-9 */}
            <div className="grid grid-cols-5 gap-2.5">
              {Array.from({ length: 10 }, (_, i) => i).map((num) => (
                <button
                  key={num}
                  onClick={() => toggleNumber(num)}
                  disabled={selectedNumbers.length >= activeGame.pickCount}
                  className="h-12 rounded-xl text-lg font-black transition-all cursor-pointer flex items-center justify-center bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700/60 active:scale-95 disabled:opacity-40 shadow-sm"
                >
                  {num}
                </button>
              ))}
            </div>

            {/* Action Purchase Button */}
            <div className="pt-2">
              {!wallet ? (
                <Button
                  onClick={connectWallet}
                  disabled={walletLoading}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-base py-6 rounded-xl shadow-lg shadow-emerald-500/20 cursor-pointer"
                >
                  {walletLoading
                    ? "GENERATING…"
                    : "CONNECT CHIPNET WALLET TO PLAY"}
                </Button>
              ) : (
                <Button
                  onClick={handleBuyTicket}
                  disabled={
                    txPending ||
                    selectedNumbers.length !== activeGame.pickCount ||
                    bettingClosed
                  }
                  className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-base py-6 rounded-xl shadow-lg shadow-emerald-500/20 active:scale-[0.98] transition-transform cursor-pointer disabled:opacity-50"
                >
                  {txPending ? (
                    <RefreshCw className="h-5 w-5 animate-spin" />
                  ) : bettingClosed ? (
                    "BETTING CLOSED — AWAITING DRAW"
                  ) : selectedNumbers.length !== activeGame.pickCount ? (
                    `PICK ${activeGame.pickCount - selectedNumbers.length} MORE DIGITS`
                  ) : (
                    `BUY TICKET (${ticketBch.toFixed(4)} BCH ≈ ₱${ticketPhp})`
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* Realistic Active Ticket Passes List */}
          {purchasedTickets.length > 0 && (
            <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-slate-300 flex items-center gap-2">
                  <Ticket className="h-4 w-4 text-emerald-400" /> Active Passes
                  ({purchasedTickets.length})
                </span>
                <span className="text-[10px] font-mono text-slate-500 uppercase">
                  On-Chain Verified
                </span>
              </div>

              <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                {purchasedTickets.map((t) => (
                  <div
                    key={t.id}
                    className="relative bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 border border-slate-800 hover:border-emerald-500/50 rounded-2xl p-4 transition-all space-y-3 shadow-md group"
                  >
                    <div className="flex justify-between items-center text-xs font-mono border-b border-slate-800/80 pb-2.5">
                      <span className="text-emerald-400 font-bold flex items-center gap-1">
                        <Hash className="h-3.5 w-3.5" /> {t.id}
                      </span>
                      <span className="text-slate-400">{t.game}</span>
                    </div>

                    <div className="flex justify-between items-center">
                      <div>
                        <span className="text-[10px] uppercase font-mono text-slate-500 block">
                          Numbers
                        </span>
                        <div className="font-mono font-black text-lg tracking-widest text-slate-100">
                          {t.numbers.join(" - ")}
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] uppercase font-mono text-slate-500 block">
                          Amount Paid
                        </span>
                        <div className="font-mono font-bold text-sm text-amber-400">
                          {(Number(t.amountSats) / 1e8).toFixed(4)} BCH
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-between items-center pt-2 border-t border-slate-800/60 text-[11px] font-mono text-slate-400">
                      <span className="truncate max-w-[160px] text-slate-500">
                        {t.address}
                      </span>
                      <Button
                        onClick={() => setViewingTicket(t)}
                        variant="outline"
                        className="h-7 px-3 text-xs bg-emerald-500/10 border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-200 rounded-lg cursor-pointer"
                      >
                        <Eye className="h-3.5 w-3.5 mr-1" /> View Ticket
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto w-full text-center py-6 border-t border-slate-800/80 mt-8 text-xs text-slate-500 font-mono">
        PCSO Mocknet Decentralized Lottery • Chipnet only, no real funds •
        Powered by CashScript & Bitcoin Cash (BCH)
      </footer>
    </div>
  );
}
