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
  pkHashFromAddress,
} from "./contracts/wallet";
import type { WalletKeypair } from "./contracts/wallet";
import {
  getLotteryContract,
  buyTicket as chainBuyTicket,
  buyTicketViaPaytaca,
  resolveDraw as chainResolveDraw,
  resolveDrawViaPaytaca,
  seedContract as chainSeedContract,
  seedContractViaPaytaca,
  signOracleWinningNumber,
} from "./contracts/lotteryClient";
import {
  connectPaytaca,
  disconnectPaytaca,
  restorePaytacaSession,
  type PaytacaConnection,
} from "./contracts/paytacaConnect";
import {
  emptySimSlot,
  fakeTxid,
  simBuyTicket,
  simResolve,
  simSeed,
  simulateDraw,
  SIMULATED_ADDRESS,
  SIMULATED_BALANCE_SATS,
  type SimSlotState,
} from "./contracts/simulationChain";
import {
  ShieldCheck,
  Trophy,
  Ticket,
  Dices,
  Bot,
  Banknote,
  Wallet,
  QrCode,
  PartyPopper,
  X,
  Layers,
  AlertTriangle,
  Zap,
  Copy,
  Check,
  ExternalLink,
  Droplets,
  FlaskConical,
  RotateCcw,
} from "lucide-react";

const provider = new ElectrumNetworkProvider("chipnet");

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
    id: "swertres",
    name: "Swertres Lotto",
    shortLabel: "3D",
    maxNumber: 9,
    pickCount: 3,
    drawDays: "Play & draw anytime",
    ticketPriceSats: 100000n, // 0.001 BCH
  },
];

function maxTicketRangeFor(game: LottoGame): number {
  return 10 ** game.pickCount;
}

// Combine individual displayed digits (e.g. [3, 3, 4]) into the single
// on-chain `pickedNumber` in [1, maxTicketRange] that the contract expects.
// This is the exact inverse of winningNumberToDigits() below, so a ticket's
// pickedNumber and a draw's winningNumber use the same representation and
// can be compared directly by resolveDraw()'s nftCommitment check.
function digitsToPickedNumber(digits: number[]): bigint {
  // Turn [6, 0, 2] -> 602 + 1 = 603n
  const rawDecimal = digits.reduce((acc, digit) => acc * 10 + digit, 0);
  return BigInt(rawDecimal + 1);
}

/** Parses a user-entered BCH amount (e.g. "1.0", "0.05") into satoshis. Returns null if invalid. */
function bchStringToSats(bchAmount: string): bigint | null {
  const trimmed = bchAmount.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return BigInt(Math.round(value * 1e8));
}

interface TicketItem {
  id: string;
  game: string;
  gameId: string;
  slotEpochMs: number;
  numbers: number[];
  txid: string;
  address: string;
  amountSats: bigint;
  timestamp: string;
  simulated: boolean;
}

const WALLET_STORAGE_KEY = "pcso-mocknet-lotto:chipnet-privkey-hex";
const SIMULATION_MODE_STORAGE_KEY = "pcso-mocknet-lotto:simulation-mode";
const PAYTACA_FAUCET_URL = "https://faucet.paytaca.com";

// Simulation mode ships ON by default: no chipnet faucet, Electrum uptime,
// or Paytaca install required to demo the full seed -> buy -> draw -> resolve
// flow. Flip it off to run the real thing against live chipnet.
function loadInitialSimulationMode(): boolean {
  if (typeof window === "undefined") return true;
  const saved = localStorage.getItem(SIMULATION_MODE_STORAGE_KEY);
  if (saved === null) return true;
  return saved === "true";
}

function simSlotKey(gameId: string, slotEpochMs: number): string {
  return `${gameId}:${Math.floor(slotEpochMs / 1000)}`;
}

interface ResolvedDraw {
  gameId: string;
  slotEpochMs: number;
  blockHeight: number;
  blockHash: string;
  headerHex: string;
  winningNumber: number;
  numbers: number[];
  simulated: boolean;
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

async function doubleSha256(bytes: Uint8Array): Promise<Uint8Array> {
  const first = await crypto.subtle.digest("SHA-256", bytes);
  const second = await crypto.subtle.digest("SHA-256", first);
  return new Uint8Array(second);
}

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
    return null;
  }
}

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

function hasMinimalProofOfWork(rawDigest: Uint8Array): boolean {
  return rawDigest[29] === 0 && rawDigest[30] === 0 && rawDigest[31] === 0;
}

export default function App() {
  const [bchToPhpRate, setBchToPhpRate] = useState<number | null>(null);

  // --- Simulation Mode: fully offline demo path, no chipnet dependency ---
  const [simulationMode, setSimulationMode] = useState<boolean>(
    loadInitialSimulationMode,
  );
  const [simSlots, setSimSlots] = useState<Record<string, SimSlotState>>({});
  // Editable jackpot seed amount for Simulation Mode (in BCH). No real funds
  // involved, so this can be set arbitrarily high to demo big-jackpot UI states.
  const [simSeedAmountBch, setSimSeedAmountBch] = useState<string>("1.0");

  useEffect(() => {
    localStorage.setItem(
      SIMULATION_MODE_STORAGE_KEY,
      simulationMode ? "true" : "false",
    );
  }, [simulationMode]);

  // --- Paytaca WalletConnect (primary live wallet path) ---
  const [paytaca, setPaytaca] = useState<PaytacaConnection | null>(null);
  const [paytacaConnecting, setPaytacaConnecting] = useState(false);
  const [paytacaBalanceSats, setPaytacaBalanceSats] = useState<bigint>(0n);
  const [paytacaSessionExpired, setPaytacaSessionExpired] = useState(false);

  // --- Local generated demo wallet (live fallback path, no Paytaca install needed) ---
  const [wallet, setWallet] = useState<WalletKeypair | null>(null);
  const [walletBalanceSats, setWalletBalanceSats] = useState<bigint>(0n);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);
  const [useLocalDemoWallet, setUseLocalDemoWallet] = useState(false);

  // Effective active address/mode driving the game.
  // Simulation Mode always wins when enabled — it never touches a real
  // wallet or the network, regardless of what's connected underneath.
  const activeAddress = simulationMode
    ? SIMULATED_ADDRESS
    : (paytaca?.address ?? (useLocalDemoWallet ? wallet?.address : undefined));
  const activeBalanceSats = simulationMode
    ? SIMULATED_BALANCE_SATS
    : paytaca
      ? paytacaBalanceSats
      : walletBalanceSats;
  const usingPaytaca = !simulationMode && !!paytaca;

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 2000);
    } catch (err) {
      console.warn("Clipboard copy failed:", err);
    }
  };

  const [selectedGameId, setSelectedGameId] = useState<string>("swertres");
  const activeGame = LOTTO_GAMES[0];

  const [oracleKeypair] = useState<WalletKeypair>(() => generateWallet());

  const contractCacheRef = useRef<Map<string, Contract>>(new Map());
  function getSlotContract(game: LottoGame, slotEpochMs: number): Contract {
    const drawDeadline = Math.floor(slotEpochMs / 1000);
    const key = `${game.id}:${drawDeadline}`;
    const cached = contractCacheRef.current.get(key);
    if (cached) return cached;
    const contract = getLotteryContract({
      oraclePk: oracleKeypair.publicKey,
      drawTimestamp: drawDeadline,
      ticketPriceSats: game.ticketPriceSats,
      maxTicketRange: maxTicketRangeFor(game),
    });
    contractCacheRef.current.set(key, contract);
    return contract;
  }

  const [activeContractSats, setActiveContractSats] = useState<bigint>(0n);
  const [gameContractSats, setGameContractSats] = useState<
    Record<string, bigint>
  >({});

  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([]);
  const [purchasedTickets, setPurchasedTickets] = useState<TicketItem[]>([]);

  const [lastWinningNumbers, setLastWinningNumbers] = useState<number[] | null>(
    null,
  );
  const [drawMessage, setDrawMessage] = useState<string | null>(null);
  const [resolvedDraw, setResolvedDraw] = useState<ResolvedDraw | null>(null);
  const [resolveTxid, setResolveTxid] = useState<string | null>(null);

  const [forceWinMode, setForceWinMode] = useState(false);
  const [showPopupCelebration, setShowPopupCelebration] = useState(false);
  const [wonPrizePhp, setWonPrizePhp] = useState("");
  const [forceDrawPending, setForceDrawPending] = useState(false);

  const [txPending, setTxPending] = useState(false);
  const [seedPending, setSeedPending] = useState(false);
  const [resolvePending, setResolvePending] = useState(false);
  const [drawPending, setDrawPending] = useState(false);
  const [chainChecking, setChainChecking] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);

  // "Round" replaces the old fixed-schedule slot: it's just an id (a
  // timestamp) that groups tickets + the contract UTXO together. It only
  // advances when a draw actually completes (or on reset/mode switch) —
  // there's no countdown and no waiting for a scheduled time. Betting stays
  // open indefinitely until you press "Draw Now".
  const [roundEpochMs, setRoundEpochMs] = useState<number>(() => Date.now());

  const drawingGameIdRef = useRef(selectedGameId);
  const drawingSlotEpochRef = useRef<number>(roundEpochMs);

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

  // --- Paytaca connect / disconnect / session restore ---

  useEffect(() => {
    restorePaytacaSession()
      .then(({ connection, expiredStaleSession }) => {
        if (connection) setPaytaca(connection);
        if (expiredStaleSession) setPaytacaSessionExpired(true);
      })
      .catch((err) => {
        console.warn("Could not restore Paytaca session:", err);
      });
  }, []);

  const handleConnectPaytaca = async () => {
    setPaytacaConnecting(true);
    setWalletError(null);
    setPaytacaSessionExpired(false);
    try {
      const conn = await connectPaytaca();
      setPaytaca(conn);
    } catch (err) {
      console.error("Paytaca connect failed:", err);
      setWalletError(
        err instanceof Error
          ? err.message
          : "Could not connect to Paytaca wallet.",
      );
    } finally {
      setPaytacaConnecting(false);
    }
  };

  const handleDisconnectPaytaca = async () => {
    try {
      await disconnectPaytaca();
    } finally {
      setPaytaca(null);
      setPaytacaBalanceSats(0n);
    }
  };

  useEffect(() => {
    if (!paytaca || simulationMode) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const bal = await getWalletBalanceSats(paytaca.address);
        if (!cancelled) setPaytacaBalanceSats(bal);
      } catch (err) {
        console.warn("Paytaca balance poll failed:", err);
      }
    };
    poll();
    const id = setInterval(poll, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [paytaca, simulationMode]);

  // --- Local demo wallet (live fallback) ---

  const connectDemoWallet = async () => {
    setWalletLoading(true);
    setWalletError(null);
    try {
      const kp = generateWallet();
      localStorage.setItem(WALLET_STORAGE_KEY, privateKeyToHex(kp.privateKey));
      setWallet(kp);
      setUseLocalDemoWallet(true);
      const bal = await getWalletBalanceSats(kp.address);
      setWalletBalanceSats(bal);
    } catch (err) {
      console.error("Wallet generation/balance fetch failed:", err);
      setWalletError(
        err instanceof Error
          ? err.message
          : "Could not create a chipnet demo wallet.",
      );
    } finally {
      setWalletLoading(false);
    }
  };

  useEffect(() => {
    const savedHex = localStorage.getItem(WALLET_STORAGE_KEY);
    if (!savedHex) return;
    try {
      const kp = walletFromPrivateKey(privateKeyFromHex(savedHex));
      setWallet(kp);
    } catch (err) {
      console.error("Failed to restore saved demo wallet:", err);
    }
  }, []);

  useEffect(() => {
    if (!wallet || !useLocalDemoWallet || simulationMode) return;
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
  }, [wallet, useLocalDemoWallet, simulationMode]);

  const disconnectDemoWallet = () => {
    localStorage.removeItem(WALLET_STORAGE_KEY);
    setWallet(null);
    setUseLocalDemoWallet(false);
    setWalletBalanceSats(0n);
    setWalletError(null);
  };

  // --- Contract / jackpot pool balance polling (real chain, or local sim state) ---

  useEffect(() => {
    if (simulationMode) {
      // No network involved — read straight from local sim state.
      const entries = LOTTO_GAMES.map((game) => {
        const key = simSlotKey(game.id, roundEpochMs);
        const state = simSlots[key] ?? emptySimSlot();
        return [game.id, state.contractSats] as const;
      });
      const next = Object.fromEntries(entries);
      setGameContractSats(next);
      setActiveContractSats(next[selectedGameId] ?? 0n);
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        LOTTO_GAMES.map(async (game) => {
          try {
            const contract = getSlotContract(game, roundEpochMs);
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
  }, [selectedGameId, roundEpochMs, simulationMode, simSlots]);

  const handleSelectGame = (gameId: string) => {
    if (drawPending || forceDrawPending || gameId === selectedGameId) return;
    setSelectedGameId(gameId);
    setSelectedNumbers([]);
    setLastWinningNumbers(null);
    setDrawMessage(null);
    setResolvedDraw(null);
    setResolveTxid(null);
    setChainError(null);
    setRoundEpochMs(Date.now());
  };

  // --- Draw resolution: only ever runs when forceDrawPending is set, i.e.
  // when the user presses "Draw Now". No schedule, no polling for a future
  // timestamp — betting stays open until this fires. ---

  useEffect(() => {
    if (!forceDrawPending || drawPending) return;
    let cancelled = false;
    const gameId = selectedGameId;
    const slotEpochMs = roundEpochMs;
    const game = LOTTO_GAMES[0];

    const runSimulatedDraw = () => {
      const range = maxTicketRangeFor(game);
      const sim = simulateDraw(gameId, slotEpochMs, range, game.pickCount);

      drawingGameIdRef.current = gameId;
      drawingSlotEpochRef.current = slotEpochMs;

      setResolvedDraw({
        gameId: sim.gameId,
        slotEpochMs: sim.slotEpochMs,
        blockHeight: sim.blockHeight,
        blockHash: sim.blockHash,
        headerHex: "",
        winningNumber: sim.winningNumber,
        numbers: sim.numbers,
        simulated: true,
      });
      setDrawMessage(null);
      setLastWinningNumbers(null);
      setResolveTxid(null);
      setForceDrawPending(false);
      setDrawPending(true);
    };

    const runLiveDraw = async () => {
      try {
        setChainChecking(true);
        setChainError(null);

        // "Draw anytime" = derive randomness from the current chain tip
        // (walking back to the most recent block with minimal proof-of-work)
        // instead of waiting for a future block at a scheduled timestamp.
        const tipHeight = await fetchChainHeight();
        let height = tipHeight;
        let found: {
          header: string;
          height: number;
          rawDigest: Uint8Array;
        } | null = null;

        for (let i = 0; i < 20 && !cancelled && height >= 0; i++) {
          const header = await fetchBlockHeader(height);
          if (!header) break;
          const rawDigest = await doubleSha256(hexToBytes(header));
          if (hasMinimalProofOfWork(rawDigest)) {
            found = { header, height, rawDigest };
            break;
          }
          height--;
        }

        if (cancelled) return;

        if (!found) {
          setChainError("No qualifying block found right now — try again.");
          setForceDrawPending(false);
          return;
        }

        const blockHash = bytesToHexReversed(found.rawDigest);
        const range = maxTicketRangeFor(game);

        // Winning number is derived purely from the block hash — this is
        // the whole point of the design: anyone can independently
        // recompute this from public chain data and verify the draw wasn't
        // rigged. It must never be overridden to favor a particular ticket.
        const winningNumber = deriveWinningNumber(found.rawDigest, range);
        const numbers = winningNumberToDigits(winningNumber, game.pickCount);

        drawingGameIdRef.current = gameId;
        drawingSlotEpochRef.current = slotEpochMs;

        setResolvedDraw({
          gameId,
          slotEpochMs,
          blockHeight: found.height,
          blockHash,
          headerHex: found.header,
          winningNumber,
          numbers,
          simulated: false,
        });
        setDrawMessage(null);
        setLastWinningNumbers(null);
        setResolveTxid(null);
        setForceDrawPending(false);
        setDrawPending(true);
      } catch (err) {
        console.warn("Live draw failed:", err);
        if (!cancelled) {
          setChainError("Could not reach the chain — try again.");
          setForceDrawPending(false);
        }
      } finally {
        if (!cancelled) setChainChecking(false);
      }
    };

    if (simulationMode) runSimulatedDraw();
    else runLiveDraw();

    return () => {
      cancelled = true;
    };
  }, [
    forceDrawPending,
    drawPending,
    roundEpochMs,
    selectedGameId,
    simulationMode,
  ]);

  const toggleNumber = (num: number) => {
    if (selectedNumbers.length < activeGame.pickCount) {
      setSelectedNumbers([...selectedNumbers, num]);
    }
  };

  const handleQuickPick = () => {
    const numbers: number[] = [];
    for (let i = 0; i < activeGame.pickCount; i++) {
      const randomNum = Math.floor(Math.random() * (activeGame.maxNumber + 1));
      numbers.push(randomNum);
    }
    setSelectedNumbers(numbers);
  };

  // Betting only closes for the moment a draw is actually in flight —
  // otherwise you can buy tickets whenever you like.
  const bettingClosed = drawPending || forceDrawPending;

  const handleForceDrawNow = () => {
    if (drawPending || forceDrawPending) return;
    setChainError(null);
    setDrawMessage(null);
    setForceDrawPending(true);
  };

  const handleToggleSimulationMode = () => {
    setSimulationMode((prev) => !prev);
    // Switching modes mid-round would mix real and fake state — reset the
    // in-progress draw/tickets UI so the next actions start clean.
    setChainError(null);
    setDrawMessage(null);
    setResolvedDraw(null);
    setResolveTxid(null);
    setLastWinningNumbers(null);
    setDrawPending(false);
    setForceDrawPending(false);
    setRoundEpochMs(Date.now());
  };

  const handleResetSimulation = () => {
    setSimSlots({});
    setPurchasedTickets((prev) => prev.filter((t) => !t.simulated));
    setChainError(null);
    setDrawMessage(null);
    setResolvedDraw(null);
    setResolveTxid(null);
    setLastWinningNumbers(null);
    setDrawPending(false);
    setForceDrawPending(false);
    setRoundEpochMs(Date.now());
  };

  const handleSeedContract = async () => {
    setSeedPending(true);
    setChainError(null);
    try {
      if (simulationMode) {
        const seedSats = bchStringToSats(simSeedAmountBch);
        if (seedSats === null) {
          throw new Error("Enter a valid seed amount in BCH (e.g. 1.0).");
        }
        const key = simSlotKey(activeGame.id, roundEpochMs);
        setSimSlots((prev) => ({
          ...prev,
          [key]: simSeed(prev[key] ?? emptySimSlot(), seedSats),
        }));
        return;
      }

      const contract = getSlotContract(activeGame, roundEpochMs);

      if (paytaca) {
        await seedContractViaPaytaca(
          contract,
          activeGame.ticketPriceSats,
          paytaca.address,
        );
        const bal = await getWalletBalanceSats(paytaca.address);
        setPaytacaBalanceSats(bal);
      } else if (wallet) {
        await chainSeedContract(
          contract,
          activeGame.ticketPriceSats,
          wallet.privateKey,
          wallet.address,
        );
        const bal = await getWalletBalanceSats(wallet.address);
        setWalletBalanceSats(bal);
      } else {
        throw new Error("Connect a wallet first.");
      }
    } catch (err) {
      console.error("Seed failed:", err);
      setChainError(
        err instanceof Error ? err.message : "Could not seed contract.",
      );
    } finally {
      setSeedPending(false);
    }
  };

  const handleBuyTicket = async () => {
    if (!activeAddress || selectedNumbers.length !== activeGame.pickCount)
      return;
    setTxPending(true);
    setChainError(null);
    try {
      // Combine the picked digits into the single number the contract's
      // pickedNumber/winningNumber commitment scheme expects.
      const pickedNumber = digitsToPickedNumber(selectedNumbers);

      let txid: string;
      let ticketAddress: string;

      if (simulationMode) {
        const key = simSlotKey(activeGame.id, roundEpochMs);
        setSimSlots((prev) => ({
          ...prev,
          [key]: simBuyTicket(
            prev[key] ?? emptySimSlot(),
            activeGame.ticketPriceSats,
            selectedNumbers,
            pickedNumber,
          ),
        }));
        txid = fakeTxid();
        ticketAddress = "simulated (no real contract)";
      } else {
        const contract = getSlotContract(activeGame, roundEpochMs);

        if (paytaca) {
          const buyerPkHash = pkHashFromAddress(paytaca.address);
          const result = await buyTicketViaPaytaca(
            contract,
            activeGame.ticketPriceSats,
            paytaca.address,
            buyerPkHash,
            pickedNumber,
          );
          txid = result.signedTransactionHash;
        } else if (wallet) {
          const result = await chainBuyTicket(
            contract,
            activeGame.ticketPriceSats,
            wallet.pkHash,
            pickedNumber,
            wallet.privateKey,
            wallet.address,
          );
          txid = result.txid;
        } else {
          throw new Error("Connect a wallet first.");
        }
        ticketAddress = contract.address;
      }

      const newTicket: TicketItem = {
        id: Math.random().toString(36).substring(2, 9),
        game: activeGame.name,
        gameId: activeGame.id,
        slotEpochMs: roundEpochMs,
        numbers: [...selectedNumbers],
        txid,
        address: ticketAddress,
        amountSats: activeGame.ticketPriceSats,
        timestamp: new Date().toLocaleTimeString(),
        simulated: simulationMode,
      };

      setPurchasedTickets([newTicket, ...purchasedTickets]);
      setSelectedNumbers([]);

      if (!simulationMode) {
        if (paytaca) {
          const bal = await getWalletBalanceSats(paytaca.address);
          setPaytacaBalanceSats(bal);
        } else if (wallet) {
          const bal = await getWalletBalanceSats(wallet.address);
          setWalletBalanceSats(bal);
        }

        const contract = getSlotContract(activeGame, roundEpochMs);
        const utxos = await contract.getUtxos();
        const total = utxos.reduce((sum, u) => sum + BigInt(u.satoshis), 0n);
        setActiveContractSats(total);
      }
    } catch (err) {
      console.error("Buy ticket failed:", err);
      setChainError(
        err instanceof Error ? err.message : "Could not buy ticket on-chain.",
      );
    } finally {
      setTxPending(false);
    }
  };

  const handleResolveOnChain = async () => {
    if (!resolvedDraw || !activeAddress) return;
    setResolvePending(true);
    setChainError(null);
    try {
      if (simulationMode) {
        const key = simSlotKey(resolvedDraw.gameId, resolvedDraw.slotEpochMs);
        setSimSlots((prev) => ({
          ...prev,
          [key]: simResolve(prev[key] ?? emptySimSlot()),
        }));
        setResolveTxid(fakeTxid());
        return;
      }

      const contract = getSlotContract(activeGame, resolvedDraw.slotEpochMs);

      const { oracleSig, oracleMessage } = await signOracleWinningNumber(
        oracleKeypair.privateKey,
        resolvedDraw.winningNumber,
      );

      let txid: string;

      if (paytaca) {
        const winnerPkHash = pkHashFromAddress(paytaca.address);
        const result = await resolveDrawViaPaytaca(
          contract,
          oracleSig,
          oracleMessage,
          paytaca.address,
          winnerPkHash,
          resolvedDraw.winningNumber,
        );
        txid = result.signedTransactionHash;
      } else if (wallet) {
        txid = await chainResolveDraw(
          contract,
          oracleSig,
          oracleMessage,
          wallet.address,
          wallet.pkHash,
          resolvedDraw.winningNumber,
          wallet.privateKey,
        );
      } else {
        throw new Error("Connect a wallet first.");
      }

      setResolveTxid(txid);
    } catch (err) {
      console.error("Resolve draw on-chain failed:", err);
      setChainError(
        err instanceof Error
          ? err.message
          : "Could not execute resolveDraw() on-chain.",
      );
    } finally {
      setResolvePending(false);
    }
  };

  // The draw machine passes the exact digits it animated to/revealed
  // (see LotteryDrawMachine's onComplete callback) — those are guaranteed
  // to match resolvedDraw.numbers because we feed them in as forcedResult,
  // so we use what's handed back here directly instead of a separate ref.
  const handleDrawComplete = (winning: number[]) => {
    setLastWinningNumbers(winning);
    setDrawPending(false);

    const gameId = drawingGameIdRef.current;
    const slotEpoch = drawingSlotEpochRef.current;

    const slotTickets = purchasedTickets.filter(
      (t) => t.gameId === gameId && t.slotEpochMs === slotEpoch,
    );

    let anyMatch = false;
    for (const t of slotTickets) {
      const match =
        t.numbers.length === winning.length &&
        t.numbers.every((n, i) => n === winning[i]);
      if (match) {
        anyMatch = true;
        break;
      }
    }

    if (forceWinMode || anyMatch) {
      const calcPhp = bchToPhpRate
        ? ((Number(activeContractSats) / 1e8) * bchToPhpRate).toLocaleString(
            undefined,
            { maximumFractionDigits: 2 },
          )
        : "12,500.00";
      setWonPrizePhp(calcPhp);
      setShowPopupCelebration(true);
      setDrawMessage(
        `🎉 JACKPOT! Your ticket matched the winning combination!`,
      );
    } else {
      setDrawMessage(
        `Draw complete. Winning numbers: ${winning.join(" - ")}. Better luck next time!`,
      );
    }

    // Start a fresh round so the next batch of tickets is grouped
    // separately from the one that just resolved.
    setRoundEpochMs(Date.now());
  };

  const bchPriceFormatted = (sats: bigint) => {
    const bch = Number(sats) / 1e8;
    return `${bch.toFixed(4)} BCH`;
  };

  const phpPriceFormatted = (sats: bigint) => {
    if (!bchToPhpRate) return "₱...";
    const php = (Number(sats) / 1e8) * bchToPhpRate;
    return `₱${php.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-40 px-4 py-3 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center space-x-3">
          <div className="bg-emerald-600 p-2 rounded-xl text-white shadow-lg shadow-emerald-900/40">
            <Trophy className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-emerald-400 to-teal-200 bg-clip-text text-transparent">
                PCSO Swertres Lotto on Bitcoin Cash
              </h1>
              {simulationMode && (
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-300 bg-amber-950/50 border border-amber-800/60 px-2 py-0.5 rounded-full">
                  <FlaskConical className="w-3 h-3" />
                  Simulation
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              {simulationMode
                ? "Running fully offline — no chipnet, faucet, or wallet required"
                : "Decentralized Digit Games on Chipnet"}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={handleToggleSimulationMode}
            className={`flex items-center gap-2 text-xs font-bold h-9 px-3 rounded-xl border transition-colors ${
              simulationMode
                ? "bg-amber-600/20 border-amber-700/60 text-amber-300 hover:bg-amber-600/30"
                : "bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800"
            }`}
            title="Toggle between offline Simulation Mode and live chipnet"
          >
            <FlaskConical className="w-4 h-4" />
            {simulationMode ? "Simulation ON" : "Simulation OFF"}
          </button>

          {simulationMode ? null : paytaca ? (
            <div className="flex items-center bg-slate-800/80 border border-teal-800/60 rounded-xl px-3 py-1.5 text-xs space-x-3">
              <div>
                <button
                  onClick={() => copyAddress(paytaca.address)}
                  title={paytaca.address}
                  className="flex items-center gap-1.5 text-teal-300 font-mono text-[10px] hover:text-teal-200 transition-colors"
                >
                  <span>
                    Paytaca: {paytaca.address.slice(0, 10)}...
                    {paytaca.address.slice(-6)}
                  </span>
                  {addressCopied ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
                <div className="text-emerald-400 font-semibold">
                  {bchPriceFormatted(paytacaBalanceSats)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDisconnectPaytaca}
                className="h-7 px-2 text-slate-400 hover:text-red-400 hover:bg-slate-700/50"
              >
                Disconnect
              </Button>
            </div>
          ) : wallet && useLocalDemoWallet ? (
            <div className="flex items-center bg-slate-800/80 border border-slate-700 rounded-xl px-3 py-1.5 text-xs space-x-3">
              <div>
                <button
                  onClick={() => copyAddress(wallet.address)}
                  title={wallet.address}
                  className="flex items-center gap-1.5 text-slate-400 font-mono text-[10px] hover:text-emerald-400 transition-colors"
                >
                  <span>
                    Demo: {wallet.address.slice(0, 8)}...
                    {wallet.address.slice(-6)}
                  </span>
                  {addressCopied ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
                <div className="text-emerald-400 font-semibold">
                  {bchPriceFormatted(walletBalanceSats)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={disconnectDemoWallet}
                className="h-7 px-2 text-slate-400 hover:text-red-400 hover:bg-slate-700/50"
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-end gap-1">
              <Button
                onClick={handleConnectPaytaca}
                disabled={paytacaConnecting}
                className="bg-teal-600 hover:bg-teal-500 text-white font-medium text-xs h-9 px-4 rounded-xl shadow-lg shadow-teal-900/30"
              >
                <QrCode className="w-4 h-4 mr-2" />
                {paytacaConnecting ? "Waiting for scan..." : "Connect Paytaca"}
              </Button>
              {paytacaSessionExpired && (
                <span className="text-[10px] text-amber-400">
                  Previous session expired — reconnect above
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="bg-slate-900/40 border-slate-800 p-6 rounded-2xl relative overflow-hidden shadow-xl">
            <div className="absolute top-0 right-0 p-8 opacity-5 pointer-events-none">
              <Dices className="w-64 h-64 text-white" />
            </div>

            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
              <div>
                <span className="text-xs uppercase tracking-wider font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-2.5 py-1 rounded-full">
                  {activeGame.shortLabel} Game
                </span>
                <h2 className="text-2xl font-black mt-2 text-white">
                  {activeGame.name}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  {activeGame.drawDays}
                </p>
              </div>

              <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl flex items-center space-x-6">
                <div>
                  <div className="text-[10px] uppercase font-bold text-slate-400 flex items-center">
                    <Banknote className="w-3 h-3 mr-1 text-emerald-400" />
                    Slot Jackpot Pool
                  </div>
                  <div className="text-lg font-bold text-emerald-400 mt-0.5">
                    {bchPriceFormatted(activeContractSats)}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {phpPriceFormatted(activeContractSats)}
                  </div>
                </div>

                <div className="border-l border-slate-800 pl-6">
                  <div className="text-[10px] uppercase font-bold text-slate-400">
                    Betting Status
                  </div>
                  <div
                    className={`text-sm font-bold mt-0.5 ${bettingClosed ? "text-amber-400" : "text-emerald-400"}`}
                  >
                    {bettingClosed ? "Drawing…" : "Open — buy anytime"}
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 rounded-2xl p-6 mb-6 flex flex-col items-center justify-center min-h-[220px]">
              <LotteryDrawMachine
                active={drawPending}
                pickCount={activeGame.pickCount}
                maxDigit={activeGame.maxNumber}
                // Feed the machine the already-resolved numbers so the
                // animation reveals exactly what resolveDraw() will pay
                // out against, instead of picking its own random result.
                forcedResult={resolvedDraw ? resolvedDraw.numbers : undefined}
                onComplete={handleDrawComplete}
              />

              {drawMessage && (
                <div className="mt-4 text-sm font-medium text-center text-emerald-300 bg-emerald-950/40 border border-emerald-800/60 px-4 py-2 rounded-xl animate-fade-in">
                  {drawMessage}
                </div>
              )}
            </div>

            {resolvedDraw && !drawPending && (
              <div className="bg-emerald-950/30 border border-emerald-800/60 rounded-xl p-4 mb-6 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <ShieldCheck className="w-5 h-5 text-emerald-400" />
                    <span className="text-sm font-bold text-white">
                      {resolvedDraw.simulated
                        ? "Simulated Draw Ready to Resolve"
                        : "Chain Draw Ready to Resolve"}
                    </span>
                  </div>
                  <span className="text-xs font-mono text-emerald-400 bg-emerald-900/40 px-2 py-0.5 rounded">
                    {resolvedDraw.simulated
                      ? "Simulated"
                      : `Block #${resolvedDraw.blockHeight}`}
                  </span>
                </div>
                <p className="text-xs text-slate-300">
                  Winning numbers{" "}
                  {resolvedDraw.simulated
                    ? "generated locally"
                    : "derived from block hash"}
                  :{" "}
                  <strong className="text-white">
                    {resolvedDraw.numbers.join(" - ")}
                  </strong>
                </p>
                <div className="flex items-center space-x-3 pt-1">
                  <Button
                    onClick={handleResolveOnChain}
                    disabled={resolvePending || !activeAddress}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-8 px-4 rounded-lg"
                  >
                    {resolvePending
                      ? usingPaytaca
                        ? "Confirm in Paytaca..."
                        : "Executing..."
                      : simulationMode
                        ? "Resolve (Simulated)"
                        : "Execute resolveDraw()"}
                  </Button>
                  {resolveTxid && (
                    <span className="text-xs text-emerald-400 font-mono">
                      Txid: {resolveTxid.slice(0, 10)}...
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 flex items-center">
                  <Ticket className="w-4 h-4 mr-2 text-emerald-400" />
                  Select Your Numbers ({selectedNumbers.length}/
                  {activeGame.pickCount})
                </h3>
                <div className="flex items-center space-x-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleQuickPick}
                    disabled={bettingClosed}
                    className="border-slate-700 bg-slate-800/40 text-xs h-8 text-slate-300 hover:bg-slate-800"
                  >
                    <Zap className="w-3 h-3 mr-1 text-amber-400" />
                    Quick Pick
                  </Button>
                  {selectedNumbers.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelectedNumbers([])}
                      disabled={bettingClosed}
                      className="text-xs h-8 text-slate-400 hover:text-red-400"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
                {Array.from({ length: activeGame.maxNumber + 1 }, (_, i) => {
                  const isSelected = selectedNumbers.includes(i);
                  return (
                    <button
                      key={i}
                      onClick={() => toggleNumber(i)}
                      disabled={bettingClosed}
                      className={`h-12 rounded-xl font-mono font-bold text-base transition-all flex items-center justify-center border ${
                        isSelected
                          ? "bg-emerald-600 border-emerald-500 text-white shadow-lg shadow-emerald-900/40 scale-105"
                          : "bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700 hover:bg-slate-800/40"
                      } ${bettingClosed ? "opacity-50 cursor-not-allowed" : ""}`}
                    >
                      {i}
                    </button>
                  );
                })}
              </div>

              <div className="pt-4 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-slate-800">
                <div>
                  <div className="text-xs text-slate-400">Ticket Price</div>
                  <div className="text-base font-bold text-white">
                    {bchPriceFormatted(activeGame.ticketPriceSats)}{" "}
                    <span className="text-xs font-normal text-slate-400">
                      ({phpPriceFormatted(activeGame.ticketPriceSats)})
                    </span>
                  </div>
                </div>

                <div className="flex items-center space-x-3 w-full sm:w-auto">
                  {activeContractSats === 0n && (
                    <Button
                      onClick={handleSeedContract}
                      disabled={seedPending || !activeAddress}
                      variant="outline"
                      className="border-slate-700 bg-slate-800/40 text-xs h-11 px-4 rounded-xl text-slate-300 hover:bg-slate-800"
                    >
                      {seedPending
                        ? usingPaytaca
                          ? "Confirm in Paytaca..."
                          : "Seeding..."
                        : "Seed Contract"}
                    </Button>
                  )}

                  <Button
                    onClick={handleBuyTicket}
                    disabled={
                      txPending ||
                      bettingClosed ||
                      !activeAddress ||
                      selectedNumbers.length !== activeGame.pickCount
                    }
                    className="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm h-11 px-8 rounded-xl shadow-lg shadow-emerald-900/40 disabled:opacity-50"
                  >
                    {txPending
                      ? usingPaytaca
                        ? "Confirm in Paytaca..."
                        : "Purchasing..."
                      : bettingClosed
                        ? "Betting Closed"
                        : !activeAddress
                          ? "Connect a Wallet First"
                          : "Buy Ticket On-Chain"}
                  </Button>
                </div>
              </div>

              {chainError && (
                <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 p-3 rounded-xl flex items-center space-x-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{chainError}</span>
                </div>
              )}
              {walletError && (
                <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 p-3 rounded-xl flex items-center space-x-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{walletError}</span>
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          {simulationMode ? (
            <Card className="bg-amber-950/20 border-amber-800/50 p-6 rounded-2xl shadow-xl space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-amber-300 flex items-center">
                <FlaskConical className="w-4 h-4 mr-2" />
                Simulation Mode Active
              </h3>
              <p className="text-[11px] text-amber-100/80">
                Seeding, buying tickets, drawing, and resolving all run against
                local in-memory state — nothing touches chipnet, the faucet, or
                a wallet. Safe to demo repeatedly, no funding needed.
              </p>

              <div>
                <label
                  htmlFor="sim-seed-amount"
                  className="text-[10px] uppercase font-bold text-amber-200/80 mb-1 block"
                >
                  Jackpot Seed Amount (BCH)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="sim-seed-amount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={simSeedAmountBch}
                    onChange={(e) => setSimSeedAmountBch(e.target.value)}
                    disabled={activeContractSats !== 0n}
                    className="flex-1 bg-slate-950/70 border border-amber-800/50 rounded-lg px-3 py-2 text-xs font-mono text-amber-100 focus:outline-none focus:border-amber-500 disabled:opacity-50"
                    placeholder="e.g. 1.0"
                  />
                  <span className="text-[10px] text-amber-200/60 shrink-0">
                    {bchStringToSats(simSeedAmountBch)
                      ? phpPriceFormatted(bchStringToSats(simSeedAmountBch)!)
                      : "invalid"}
                  </span>
                </div>
                {activeContractSats !== 0n && (
                  <p className="text-[10px] text-amber-200/60 mt-1">
                    Pool already seeded for this round — reset simulation to
                    seed a different amount.
                  </p>
                )}
              </div>

              <Button
                onClick={handleResetSimulation}
                variant="outline"
                className="w-full border-amber-800/60 bg-amber-950/30 text-xs h-9 text-amber-200 hover:bg-amber-900/40"
              >
                <RotateCcw className="w-3 h-3 mr-2" />
                Reset Simulation
              </Button>
            </Card>
          ) : (
            activeAddress && (
              <Card className="bg-slate-900/40 border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 flex items-center">
                  <Droplets className="w-4 h-4 mr-2 text-emerald-400" />
                  Fund Your Chipnet Wallet
                </h3>

                <div>
                  <div className="text-[10px] uppercase font-bold text-slate-400 mb-1.5">
                    Your Address {usingPaytaca ? "(Paytaca)" : "(Demo)"}
                  </div>
                  <div className="flex items-stretch bg-slate-950/70 border border-slate-800 rounded-xl overflow-hidden">
                    <div className="flex-1 px-3 py-2.5 text-[11px] font-mono text-slate-300 break-all select-all">
                      {activeAddress}
                    </div>
                    <button
                      onClick={() => copyAddress(activeAddress)}
                      className={`shrink-0 flex items-center justify-center px-3 border-l transition-colors ${
                        addressCopied
                          ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-400"
                          : "border-slate-800 bg-slate-900/60 text-slate-400 hover:text-emerald-400 hover:bg-slate-800/60"
                      }`}
                      title="Copy address"
                    >
                      {addressCopied ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  {addressCopied && (
                    <div className="text-[10px] text-emerald-400 mt-1">
                      Copied to clipboard!
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
                  <div>
                    <div className="text-xs font-bold text-white">
                      Need test coins?
                    </div>
                    <div className="text-[10px] text-slate-400">
                      Get free tBCH from the Paytaca chipnet faucet
                    </div>
                  </div>
                  <a
                    href={PAYTACA_FAUCET_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold h-8 px-3 rounded-lg transition-colors"
                  >
                    Faucet
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>

                <p className="text-[10px] text-slate-500">
                  A single ticket purchase needs one UTXO of at least{" "}
                  {bchPriceFormatted(activeGame.ticketPriceSats + 1500n)} in
                  your wallet. Fund with a bit extra to cover several purchases.
                  If the faucet is unreliable, flip on Simulation Mode above
                  instead.
                </p>
              </Card>
            )
          )}

          {!simulationMode && !paytaca && (
            <Card className="bg-slate-900/40 border-slate-800 p-6 rounded-2xl shadow-xl space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 flex items-center">
                <Wallet className="w-4 h-4 mr-2 text-emerald-400" />
                No Paytaca Installed?
              </h3>
              <p className="text-[11px] text-slate-400">
                You can play with a locally generated demo keypair instead (kept
                in this browser only — not recommended for real funds, chipnet
                only).
              </p>
              {wallet && useLocalDemoWallet ? (
                <Button
                  onClick={disconnectDemoWallet}
                  variant="outline"
                  className="w-full border-slate-700 bg-slate-800/40 text-xs h-9 text-slate-300 hover:bg-slate-800"
                >
                  Disconnect Demo Wallet
                </Button>
              ) : (
                <Button
                  onClick={connectDemoWallet}
                  disabled={walletLoading}
                  variant="outline"
                  className="w-full border-slate-700 bg-slate-800/40 text-xs h-9 text-slate-300 hover:bg-slate-800"
                >
                  {walletLoading ? "Creating..." : "Use Local Demo Wallet"}
                </Button>
              )}
            </Card>
          )}

          <Card className="bg-slate-900/40 border-slate-800 p-6 rounded-2xl shadow-xl">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 mb-4 flex items-center">
              <Layers className="w-4 h-4 mr-2 text-emerald-400" />
              Active Game
            </h3>
            <div className="space-y-3">
              <div className="w-full text-left p-4 rounded-xl border bg-emerald-950/30 border-emerald-700/60 shadow-lg shadow-emerald-950/20 transition-all flex items-center justify-between">
                <div>
                  <div className="font-bold text-white text-base">
                    {activeGame.name}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {activeGame.drawDays}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs font-mono font-bold text-emerald-400">
                    {bchPriceFormatted(gameContractSats[activeGame.id] ?? 0n)}
                  </div>
                  <div className="text-[10px] text-slate-400">Pool Balance</div>
                </div>
              </div>
            </div>
          </Card>

          <Card className="bg-slate-900/40 border-slate-800 p-6 rounded-2xl shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 flex items-center">
                <Ticket className="w-4 h-4 mr-2 text-emerald-400" />
                Your Purchased Tickets ({purchasedTickets.length})
              </h3>
            </div>

            {purchasedTickets.length === 0 ? (
              <div className="text-center py-8 text-xs text-slate-500">
                No tickets purchased yet this session.
              </div>
            ) : (
              <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
                {purchasedTickets.map((t) => (
                  <div
                    key={t.id}
                    className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-emerald-400 flex items-center gap-1.5">
                        {t.game}
                        {t.simulated && (
                          <span className="text-[9px] uppercase font-bold text-amber-300 bg-amber-950/50 border border-amber-800/60 px-1.5 py-0.5 rounded">
                            Sim
                          </span>
                        )}
                      </span>
                      <span className="text-slate-500 font-mono">
                        {t.timestamp}
                      </span>
                    </div>
                    <div className="flex items-center space-x-1.5">
                      {t.numbers.map((n, idx) => (
                        <span
                          key={idx}
                          className="w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 font-mono font-bold text-white flex items-center justify-center text-xs"
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                    <div className="text-[10px] font-mono text-slate-500 truncate">
                      Txid: {t.txid}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="bg-slate-900/40 border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 flex items-center">
              <Bot className="w-4 h-4 mr-2 text-emerald-400" />
              Demo Controls
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
                <div>
                  <div className="text-xs font-bold text-white">
                    Force Win Mode
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Shows the celebration popup regardless of the draw result
                    (UI demo only — the actual draw stays genuinely random and
                    on-chain payout still requires a real matching ticket)
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={forceWinMode}
                  onChange={(e) => setForceWinMode(e.target.checked)}
                  className="w-4 h-4 accent-emerald-600 rounded cursor-pointer"
                />
              </div>

              <Button
                onClick={handleForceDrawNow}
                disabled={drawPending || forceDrawPending}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm h-11 rounded-xl shadow-lg shadow-emerald-900/40 disabled:opacity-50"
              >
                {forceDrawPending
                  ? chainChecking
                    ? "Checking chain..."
                    : "Starting draw..."
                  : drawPending
                    ? "Drawing..."
                    : "Draw Now"}
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {showPopupCelebration && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <Card className="bg-slate-900 border-slate-800 p-6 rounded-2xl max-w-md w-full text-center space-y-4 relative shadow-2xl">
            <div className="absolute top-4 right-4">
              <button
                onClick={() => setShowPopupCelebration(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="w-16 h-16 bg-emerald-600/20 border border-emerald-500/40 text-emerald-400 rounded-full flex items-center justify-center mx-auto">
              <PartyPopper className="w-8 h-8" />
            </div>
            <h3 className="text-2xl font-black text-white">JACKPOT WINNER!</h3>
            <p className="text-sm text-slate-300">
              Congratulations! Your ticket matched the winning combination
              on-chain and won an estimated prize of{" "}
              <strong className="text-emerald-400">₱{wonPrizePhp}</strong>!
            </p>
            <Button
              onClick={() => setShowPopupCelebration(false)}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm h-10 rounded-xl"
            >
              Awesome!
            </Button>
          </Card>
        </div>
      )}
    </div>
  );
}
