import { useState, useEffect, useRef } from "react";
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
  normalizeChipnetAddress,
} from "./contracts/wallet";
import type { WalletKeypair } from "./contracts/wallet";
import {
  getLotteryContract,
  buyTicket as chainBuyTicket,
  buyTicketViaPaytaca,
  payWinnerViaPaytaca,
  resolveDraw as chainResolveDraw,
  resolveDrawViaPaytaca,
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
  FlaskConical,
  RotateCcw,
} from "lucide-react";

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
    id: "3d_lotto",
    name: "3D Lotto",
    shortLabel: "3D",
    maxNumber: 9,
    pickCount: 3,
    drawDays: "Winning digits generated securely in the frontend",
    ticketPriceSats: 100000n, // 0.001 BCH
  },
];

function generateFrontendDraw(
  count: number,
  maxNumber: number,
): number[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("Draw count must be a positive integer.");
  }

  if (!Number.isInteger(maxNumber) || maxNumber < 0) {
    throw new Error("Maximum draw number must be zero or greater.");
  }

  const range = maxNumber + 1;
  const rejectionLimit =
    Math.floor(0x1_0000_0000 / range) * range;

  const numbers: number[] = [];

  while (numbers.length < count) {
    const randomValue = new Uint32Array(1);
    crypto.getRandomValues(randomValue);

    if (randomValue[0] >= rejectionLimit) {
      continue;
    }

    numbers.push(randomValue[0] % range);
  }

  return numbers;
}

function maxTicketRangeFor(game: LottoGame): number {
  return (game.maxNumber + 1) ** game.pickCount;
}

// Encodes an ordered combination into a unique 1-based contract number.
// With maxNumber 20, [3, 11, 14] is encoded in base 21.
function digitsToPickedNumber(numbers: number[], maxNumber: number): bigint {
  const base = BigInt(maxNumber + 1);
  const encoded = numbers.reduce(
    (result, number) => result * base + BigInt(number),
    0n,
  );
  return encoded + 1n;
}

interface TicketItem {
  id: string;
  game: string;
  gameId: string;
  slotEpochMs: number;
  numbers: number[];
  txid: string;
  buyerAddress: string;
  paymentAddress: string;
  amountSats: bigint;
  timestamp: string;
  simulated: boolean;
}

const WALLET_STORAGE_KEY = "pcso-mocknet-lotto:chipnet-privkey-hex";
const SIMULATION_MODE_STORAGE_KEY = "pcso-mocknet-lotto:simulation-mode";
const ESTIMATED_TICKET_NETWORK_FEE_SATS = 5000n;

// Permanent Chipnet jackpot wallet. This is independent of the bettor wallet.
const JACKPOT_WALLET_ADDRESS =
  "bchtest:qqxsrhnzq8hlhnqq5jppgqnv4avpfzw0wqlkxw03rm";


function getPaytacaTransactionHash(result: unknown): string {
  if (!result || typeof result !== "object") {
    throw new Error(
      "Paytaca approved the request but returned no transaction result.",
    );
  }

  const value = result as Record<string, unknown>;

  const candidates = [
    value.signedTransactionHash,
    value.transactionHash,
    value.txid,
    value.hash,
  ];

  const transactionHash = candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      candidate.trim().length > 0,
  );

  if (!transactionHash) {
    console.error("Unexpected Paytaca response:", result);
    throw new Error(
      "Paytaca approved the payment, but the transaction ID was not returned.",
    );
  }

  return transactionHash;
}

function getReadableError(error: unknown): string {
  const visited = new WeakSet<object>();

  const read = (value: unknown, depth = 0): string | null => {
    if (depth > 5) return null;

    if (value instanceof Error) {
      return value.message || value.name;
    }

    if (typeof value === "string") {
      return value.trim() || null;
    }

    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      return String(value);
    }

    if (!value || typeof value !== "object") {
      return null;
    }

    if (visited.has(value)) {
      return null;
    }

    visited.add(value);

    const record = value as Record<string, unknown>;

    const directKeys = [
      "message",
      "msg",
      "reason",
      "details",
      "description",
    ];

    for (const key of directKeys) {
      const candidate = read(record[key], depth + 1);

      if (candidate) {
        const code =
          record.code ?? record.status ?? record.level;

        return code !== undefined
          ? `[${String(code)}] ${candidate}`
          : candidate;
      }
    }

    const nestedKeys = [
      "error",
      "data",
      "cause",
      "response",
      "context",
    ];

    for (const key of nestedKeys) {
      const candidate = read(record[key], depth + 1);
      if (candidate) return candidate;
    }

    try {
      return JSON.stringify(
        value,
        (_key, nestedValue) =>
          typeof nestedValue === "bigint"
            ? nestedValue.toString()
            : nestedValue,
      );
    } catch {
      return null;
    }
  };

  return (
    read(error) ??
    "Could not complete the BCH ticket payment."
  );
}

// Simulation mode ships ON by default: no chipnet faucet, Electrum uptime,
// or Paytaca install required to demo the buy -> draw flow.
// flow. Flip it off to run the real thing against live chipnet.
function addressesAreEqual(
  firstAddress: string,
  secondAddress: string,
): boolean {
  try {
    const firstPkHash =
      pkHashFromAddress(
        normalizeChipnetAddress(
          firstAddress,
        ),
      );

    const secondPkHash =
      pkHashFromAddress(
        normalizeChipnetAddress(
          secondAddress,
        ),
      );

    if (
      firstPkHash.length !==
      secondPkHash.length
    ) {
      return false;
    }

    return firstPkHash.every(
      (byte, index) =>
        byte === secondPkHash[index],
    );
  } catch (error) {
    console.warn(
      "Could not compare BCH addresses:",
      error,
    );

    return false;
  }
}

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

interface DrawHistoryItem {
  id: string;
  game: string;
  numbers: number[];
  jackpotSats: bigint;
  hadWinner: boolean;
  winnerCount: number;
  drawnAt: string;
  simulated: boolean;
}

export default function App() {
  const [bchToPhpRate, setBchToPhpRate] = useState<number | null>(null);

  // --- Simulation Mode: fully offline demo path, no chipnet dependency ---
  const [simulationMode, setSimulationMode] = useState<boolean>(
    loadInitialSimulationMode,
  );
  const [simSlots, setSimSlots] = useState<Record<string, SimSlotState>>({});
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

  // The bettor wallet is connected only when a user wants to buy a ticket.
  // It is never used as the jackpot wallet.
  const bettorAddress = simulationMode
    ? SIMULATED_ADDRESS
    : paytaca
      ? normalizeChipnetAddress(paytaca.address)
      : useLocalDemoWallet
        ? wallet?.address
        : undefined;
  const bettorBalanceSats = simulationMode
    ? SIMULATED_BALANCE_SATS
    : paytaca
      ? paytacaBalanceSats
      : walletBalanceSats;
  const usingPaytaca = !simulationMode && !!paytaca;

  const [jackpotBalanceSats, setJackpotBalanceSats] = useState<bigint>(0n);
  const [jackpotBalanceLoading, setJackpotBalanceLoading] = useState(true);
  const [jackpotBalanceError, setJackpotBalanceError] = useState<string | null>(
    null,
  );

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 2000);
    } catch (err) {
      console.warn("Clipboard copy failed:", err);
    }
  };

  const [selectedGameId, setSelectedGameId] = useState<string>("3d_lotto");
  const activeGame = LOTTO_GAMES[0];

  const estimatedTicketTotalSats =
    activeGame.ticketPriceSats +
    ESTIMATED_TICKET_NETWORK_FEE_SATS;

  const hasEstimatedTicketBalance =
    simulationMode ||
    bettorBalanceSats >= estimatedTicketTotalSats;

  const [oracleKeypair] = useState<WalletKeypair>(() => generateWallet());

  // One persistent CashScript address acts as the jackpot wallet.
  // It starts empty. Every ticket purchase adds BCH to this address.
  const jackpotWalletEpochRef = useRef<number>(Date.now());

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
  const [drawHistory, setDrawHistory] = useState<DrawHistoryItem[]>([]);

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
  const [resolvePending, setResolvePending] = useState(false);
  const [drawPending, setDrawPending] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);
  const [purchaseMessage, setPurchaseMessage] = useState<string | null>(null);
  const [purchaseStatus, setPurchaseStatus] = useState<string | null>(null);
  const [payoutPending, setPayoutPending] = useState(false);
  const [payoutTxid, setPayoutTxid] = useState<string | null>(null);
  const [pendingWinnerAddress, setPendingWinnerAddress] =
    useState<string | null>(null);

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
        if (connection) {
          const normalizedConnection: PaytacaConnection = {
            ...connection,
            address: normalizeChipnetAddress(connection.address),
          };

          setPaytaca(normalizedConnection);
        }

        if (expiredStaleSession) {
          setPaytacaSessionExpired(true);
        }
      })
      .catch((err) => {
        console.warn("Could not restore Paytaca session:", err);
      });
  }, []);

  const handleConnectPaytaca = async () => {
    setPaytacaConnecting(true);
    setWalletError(null);
    setChainError(null);
    setPaytacaSessionExpired(false);

    try {
      const connection = await connectPaytaca();

      const normalizedConnection: PaytacaConnection = {
        ...connection,
        address: normalizeChipnetAddress(connection.address),
      };

      setPaytaca(normalizedConnection);

      const balance = await getWalletBalanceSats(
        normalizedConnection.address,
      );

      setPaytacaBalanceSats(balance);
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
        const bal = await getWalletBalanceSats(
          normalizeChipnetAddress(paytaca.address),
        );
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

  // --- Jackpot wallet balance polling (CashScript address or local simulation) ---

  useEffect(() => {
    if (simulationMode) {
      // No network involved — read straight from local sim state.
      const entries = LOTTO_GAMES.map((game) => {
        const key = simSlotKey(
          game.id,
          jackpotWalletEpochRef.current,
        );
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
            const contract = getSlotContract(game, jackpotWalletEpochRef.current);
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

  // Poll the permanent jackpot wallet even when no bettor wallet is connected.
  useEffect(() => {
    if (simulationMode) {
      setJackpotBalanceSats(activeContractSats);
      setJackpotBalanceLoading(false);
      setJackpotBalanceError(null);
      return;
    }

    let cancelled = false;

    const pollJackpotBalance = async () => {
      try {
        const balance = await getWalletBalanceSats(JACKPOT_WALLET_ADDRESS);
        if (cancelled) return;

        setJackpotBalanceSats(balance);
        setJackpotBalanceError(null);
      } catch (error) {
        if (cancelled) return;

        console.warn("Jackpot wallet balance poll failed:", error);
        setJackpotBalanceError(
          error instanceof Error
            ? error.message
            : "Could not retrieve the jackpot wallet balance.",
        );
      } finally {
        if (!cancelled) setJackpotBalanceLoading(false);
      }
    };

    void pollJackpotBalance();
    const intervalId = window.setInterval(() => {
      void pollJackpotBalance();
    }, 20_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [simulationMode, activeContractSats]);

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

  // --- Frontend-only draw resolution ---
  useEffect(() => {
    if (!forceDrawPending || drawPending) {
      return;
    }

    try {
      const numbers = simulationMode
        ? simulateDraw(
            selectedGameId,
            roundEpochMs,
            maxTicketRangeFor(activeGame),
            activeGame.pickCount,
          ).numbers
        : generateFrontendDraw(
            activeGame.pickCount,
            activeGame.maxNumber,
          );

      const winningNumber = Number(
        digitsToPickedNumber(
          numbers,
          activeGame.maxNumber,
        ),
      );

      drawingGameIdRef.current =
        selectedGameId;

      drawingSlotEpochRef.current =
        roundEpochMs;

      setResolvedDraw({
        gameId: selectedGameId,
        slotEpochMs: roundEpochMs,
        blockHeight: 0,
        blockHash:
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : Array.from(
                crypto.getRandomValues(
                  new Uint8Array(16),
                ),
              )
                .map((value) =>
                  value
                    .toString(16)
                    .padStart(2, "0"),
                )
                .join(""),
        headerHex: "",
        winningNumber,
        numbers,
        simulated: simulationMode,
      });

      setDrawMessage(null);
      setLastWinningNumbers(null);
      setResolveTxid(null);
      setForceDrawPending(false);
      setDrawPending(true);
    } catch (error) {
      const message = getReadableError(error);

      console.error(
        "Frontend draw failed:",
        message,
        error,
      );

      setChainError(message);
      setForceDrawPending(false);
      setDrawPending(false);
    }
  }, [
    forceDrawPending,
    drawPending,
    roundEpochMs,
    selectedGameId,
    simulationMode,
    activeGame,
  ]);


const toggleNumber = (num: number) => {
  if (bettingClosed) return;

  setSelectedNumbers((previousNumbers) => {
    if (previousNumbers.length >= activeGame.pickCount) {
      return previousNumbers;
    }

    // Duplicate numbers are intentionally allowed.
    // Examples: 5-5-2 and 0-0-0.
    return [...previousNumbers, num];
  });
};

const removeSelectedNumber = (indexToRemove: number) => {
  if (bettingClosed) return;

  setSelectedNumbers((previousNumbers) =>
    previousNumbers.filter(
      (_, currentIndex) => currentIndex !== indexToRemove,
    ),
  );
};

const getOrdinalLabel = (index: number): string => {
  const position = index + 1;

  if (position % 100 >= 11 && position % 100 <= 13) {
    return `${position}th`;
  }

  switch (position % 10) {
    case 1:
      return `${position}st`;

    case 2:
      return `${position}nd`;

    case 3:
      return `${position}rd`;

    default:
      return `${position}th`;
  }
};

const handleQuickPick = () => {
  const numbers = Array.from(
    { length: activeGame.pickCount },
    () =>
      Math.floor(
        Math.random() *
          (activeGame.maxNumber + 1),
      ),
  );

  setSelectedNumbers(numbers);
};

  // Betting only closes for the moment a draw is actually in flight —
  // otherwise you can buy tickets whenever you like.
  const bettingClosed = drawPending || forceDrawPending || payoutPending;

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
    setDrawHistory((prev) => prev.filter((draw) => !draw.simulated));
    setChainError(null);
    setDrawMessage(null);
    setResolvedDraw(null);
    setResolveTxid(null);
    setLastWinningNumbers(null);
    setDrawPending(false);
    setForceDrawPending(false);
    setRoundEpochMs(Date.now());
  };

  const refreshBalancesAfterPurchase = (
    buyerAddress: string | undefined,
    paidWithPaytaca: boolean,
  ) => {
    // Do not block the successful purchase UI while Electrum indexes the tx.
    window.setTimeout(() => {
      if (buyerAddress) {
        void getWalletBalanceSats(buyerAddress)
          .then((balance) => {
            if (paidWithPaytaca) {
              setPaytacaBalanceSats(balance);
            } else {
              setWalletBalanceSats(balance);
            }
          })
          .catch((error) => {
            console.warn("Buyer balance refresh failed:", error);
          });
      }

      void getWalletBalanceSats(JACKPOT_WALLET_ADDRESS)
        .then((balance) => {
          setJackpotBalanceSats(balance);
          setJackpotBalanceError(null);
        })
        .catch((error) => {
          console.warn("Jackpot balance refresh failed:", error);
        });
    }, 1200);
  };

  const handleBuyTicket = async () => {
    if (!bettorAddress) {
      setChainError("Connect your bettor wallet first.");
      return;
    }

    if (selectedNumbers.length !== activeGame.pickCount) {
      setChainError(`Select exactly ${activeGame.pickCount} numbers.`);
      return;
    }

    if (!hasEstimatedTicketBalance) {
      setChainError(
        `Your wallet needs approximately ${bchPriceFormatted(
          estimatedTicketTotalSats,
        )} to cover the ticket and network fee.`,
      );
      return;
    }

    const purchasedNumbers = [...selectedNumbers];
    const pickedNumber = digitsToPickedNumber(
      purchasedNumbers,
      activeGame.maxNumber,
    );

    setTxPending(true);
    setChainError(null);
    setPurchaseMessage(null);
    setPurchaseStatus(
      simulationMode
        ? "Creating simulated ticket..."
        : usingPaytaca
          ? "Preparing Paytaca transaction..."
          : "Preparing ticket transaction...",
    );

    try {
      let txid: string;
      let paymentAddress: string;
      let normalizedBuyerAddress: string | undefined;
      let paidWithPaytaca = false;

      if (simulationMode) {
        const key = simSlotKey(
          activeGame.id,
          jackpotWalletEpochRef.current,
        );

        setSimSlots((previousSlots) => ({
          ...previousSlots,
          [key]: simBuyTicket(
            previousSlots[key] ?? emptySimSlot(),
            activeGame.ticketPriceSats,
            purchasedNumbers,
            pickedNumber,
          ),
        }));

        txid = fakeTxid();
        paymentAddress = "simulated jackpot wallet";

        // Immediate optimistic jackpot update in simulation mode.
        setJackpotBalanceSats(
          (previousBalance) =>
            previousBalance + activeGame.ticketPriceSats,
        );
      } else if (paytaca) {
        normalizedBuyerAddress =
          normalizeChipnetAddress(paytaca.address);
        paidWithPaytaca = true;

        const buyerPkHash = pkHashFromAddress(
          normalizedBuyerAddress,
        );

        setPurchaseStatus(
          "Check your Paytaca...",
        );

        const result = await buyTicketViaPaytaca(
          JACKPOT_WALLET_ADDRESS,
          activeGame.ticketPriceSats,
          normalizedBuyerAddress,
          buyerPkHash,
          pickedNumber,
        );

        txid = getPaytacaTransactionHash(result);
        paymentAddress = JACKPOT_WALLET_ADDRESS;

        // The transaction was broadcast successfully. Update the visible jackpot
        // immediately rather than waiting for Electrum to index the new output.
        setJackpotBalanceSats(
          (previousBalance) =>
            previousBalance + activeGame.ticketPriceSats,
        );
      } else if (wallet) {
        normalizedBuyerAddress = wallet.address;

        setPurchaseStatus(
          "Signing and broadcasting ticket transaction...",
        );

        const result = await chainBuyTicket(
          JACKPOT_WALLET_ADDRESS,
          activeGame.ticketPriceSats,
          wallet.pkHash,
          pickedNumber,
          wallet.privateKey,
          wallet.address,
        );

        txid = result.txid;
        paymentAddress = JACKPOT_WALLET_ADDRESS;

        setJackpotBalanceSats(
          (previousBalance) =>
            previousBalance + activeGame.ticketPriceSats,
        );
      } else {
        throw new Error("Connect your bettor wallet first.");
      }

      const newTicket: TicketItem = {
        id: crypto.randomUUID?.() ??
          Math.random().toString(36).substring(2, 9),
        game: activeGame.name,
        gameId: activeGame.id,
        slotEpochMs: roundEpochMs,
        numbers: purchasedNumbers,
        txid,
        buyerAddress:
          normalizedBuyerAddress ??
          bettorAddress,
        paymentAddress,
        amountSats: activeGame.ticketPriceSats,
        timestamp: new Date().toLocaleTimeString(),
        simulated: simulationMode,
      };

      // Update the ticket list and form immediately after broadcast.
      setPurchasedTickets((previousTickets) => [
        newTicket,
        ...previousTickets,
      ]);
      setSelectedNumbers([]);
      setPurchaseStatus(null);
      setPurchaseMessage(
        `Ticket ${purchasedNumbers.join("-")} purchased successfully. Txid: ${txid}`,
      );

      // Balance reads are slower and may briefly return the pre-transaction
      // values, so refresh them in the background after a short indexing delay.
      if (!simulationMode) {
        refreshBalancesAfterPurchase(
          normalizedBuyerAddress,
          paidWithPaytaca,
        );
      }
    } catch (err) {
      const message = getReadableError(err);
      console.error("Buy ticket failed:", message, err);
      setChainError(message);
      setPurchaseMessage(null);
      setPurchaseStatus(null);
    } finally {
      setTxPending(false);
    }
  };

  const handleResolveOnChain = async () => {
    if (!resolvedDraw || !bettorAddress) return;
    setResolvePending(true);
    setChainError(null);
    try {
      if (simulationMode) {
        const key = simSlotKey(
          resolvedDraw.gameId,
          jackpotWalletEpochRef.current,
        );
        setSimSlots((prev) => ({
          ...prev,
          [key]: simResolve(prev[key] ?? emptySimSlot()),
        }));
        setResolveTxid(fakeTxid());
        return;
      }

      const contract = getSlotContract(
        activeGame,
        jackpotWalletEpochRef.current,
      );

      const { oracleSig, oracleMessage } = await signOracleWinningNumber(
        oracleKeypair.privateKey,
        resolvedDraw.winningNumber,
      );

      let txid: string;

      if (paytaca) {
        const normalizedWinnerAddress =
          normalizeChipnetAddress(paytaca.address);

        const winnerPkHash = pkHashFromAddress(
          normalizedWinnerAddress,
        );
        const result = await resolveDrawViaPaytaca(
          contract,
          oracleSig,
          oracleMessage,
          normalizedWinnerAddress,
          winnerPkHash,
          resolvedDraw.winningNumber,
        );
        txid = getPaytacaTransactionHash(result);
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
        throw new Error("Connect your bettor wallet first.");
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

  const handleAutomaticWinnerPayout = async (
    winnerAddress: string,
    expectedJackpotSats: bigint,
  ) => {
    setPendingWinnerAddress(
      winnerAddress,
    );
    setPayoutTxid(null);

    if (simulationMode) {
      const simulatedTxid = fakeTxid();

      setPayoutTxid(simulatedTxid);
      setJackpotBalanceSats(0n);
      setDrawMessage(
        `Simulated jackpot sent to ${winnerAddress}.`,
      );
      setPendingWinnerAddress(null);
      return;
    }

    if (!paytaca) {
      setChainError(
        "A winning ticket was found, but the jackpot Paytaca wallet is not connected. Connect the jackpot wallet to complete the payout.",
      );
      return;
    }

    const connectedSignerAddress =
      normalizeChipnetAddress(
        paytaca.address,
      );

    const normalizedJackpotAddress =
      normalizeChipnetAddress(
        JACKPOT_WALLET_ADDRESS,
      );

    console.log(
      "Jackpot signer verification:",
      {
        rawPaytacaAddress:
          paytaca.address,
        normalizedPaytacaAddress:
          connectedSignerAddress,
        normalizedJackpotAddress,
      },
    );

    if (
      !addressesAreEqual(
        connectedSignerAddress,
        normalizedJackpotAddress,
      )
    ) {
      setChainError(
        `The connected Paytaca wallet is not the jackpot wallet. Connected: ${connectedSignerAddress}. Expected: ${normalizedJackpotAddress}.`,
      );
      return;
    }

    if (expectedJackpotSats <= 0n) {
      setChainError(
        "Winner detected, but the jackpot balance is empty.",
      );
      return;
    }

    setPayoutPending(true);
    setChainError(null);

    try {
      /**
       * This immediately opens Paytaca's normal transaction confirmation.
       * There is no extra organizer approval button in the web application.
       */
      const result =
        await payWinnerViaPaytaca(
          normalizedJackpotAddress,
          winnerAddress,
        );

      const txid =
        getPaytacaTransactionHash(
          result,
        );

      setPayoutTxid(txid);
      setJackpotBalanceSats(0n);
      setPendingWinnerAddress(null);
      setDrawMessage(
        `Jackpot sent successfully to ${winnerAddress}.`,
      );

      window.setTimeout(() => {
        void getWalletBalanceSats(
          normalizedJackpotAddress,
        )
          .then((balance) => {
            setJackpotBalanceSats(
              balance,
            );
          })
          .catch((error) => {
            console.warn(
              "Jackpot balance refresh after payout failed:",
              error,
            );
          });
      }, 1500);
    } catch (error) {
      const message =
        getReadableError(error);

      console.error(
        "Automatic jackpot payout failed:",
        message,
        error,
      );

      setChainError(message);
    } finally {
      setPayoutPending(false);
    }
  };

  // The draw machine passes the exact digits it animated to/revealed.
  const handleDrawComplete = (winning: number[]) => {
    setLastWinningNumbers(winning);
    setDrawPending(false);

    const gameId = drawingGameIdRef.current;
    const slotEpoch = drawingSlotEpochRef.current;

    const slotTickets = purchasedTickets.filter(
      (ticket) =>
        ticket.gameId === gameId &&
        ticket.slotEpochMs === slotEpoch,
    );

    const matchingTickets = slotTickets.filter(
      (ticket) =>
        ticket.numbers.length === winning.length &&
        ticket.numbers.every(
          (number, index) => number === winning[index],
        ),
    );

    const hadWinner = forceWinMode || matchingTickets.length > 0;
    const winnerCount = forceWinMode
      ? Math.max(1, matchingTickets.length)
      : matchingTickets.length;
    const completedJackpotSats = jackpotBalanceSats;
    const nextRoundEpochMs = Date.now();

    setDrawHistory((previousHistory) => [
      {
        id: `${gameId}-${slotEpoch}`,
        game: activeGame.name,
        numbers: [...winning],
        jackpotSats: completedJackpotSats,
        hadWinner,
        winnerCount,
        drawnAt: new Date().toLocaleString(),
        simulated: simulationMode,
      },
      ...previousHistory,
    ]);

    if (hadWinner) {
      const calcPhp = bchToPhpRate
        ? (
            (Number(completedJackpotSats) / 1e8) *
            bchToPhpRate
          ).toLocaleString(undefined, {
            maximumFractionDigits: 2,
          })
        : "12,500.00";

      setWonPrizePhp(calcPhp);
      setShowPopupCelebration(true);

      const winningTicket =
        matchingTickets[0];

      const winnerAddress =
        winningTicket?.buyerAddress ??
        bettorAddress;

      if (!winnerAddress) {
        setChainError(
          "A winning ticket was found, but its wallet address is unavailable.",
        );
      } else {
        setDrawMessage(
          "🎉 JACKPOT! Sending the prize to the winning wallet...",
        );

        void handleAutomaticWinnerPayout(
          winnerAddress,
          completedJackpotSats,
        );
      }
    } else {
      // No transfer is required. The BCH remains in the same jackpot wallet.
      setDrawMessage(
        `No winner. ${bchPriceFormatted(
          completedJackpotSats,
        )} remains in the jackpot wallet for the next draw.`,
      );
    }

    // A new round prevents old tickets from participating again.
    setRoundEpochMs(nextRoundEpochMs);
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
                3D Lotto on Bitcoin Cash
              </h1>
              {simulationMode && (
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-300 bg-amber-950/50 border border-amber-800/60 px-2 py-0.5 rounded-full">
                  <FlaskConical className="w-3 h-3" />
                  Simulation
                </span>
              )}
            </div>
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
                    Current Jackpot
                  </div>
                  <div className="text-lg font-bold text-emerald-400 mt-0.5">
                    {jackpotBalanceLoading
                      ? "Loading..."
                      : bchPriceFormatted(jackpotBalanceSats)}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {jackpotBalanceLoading
                      ? "₱..."
                      : phpPriceFormatted(jackpotBalanceSats)}
                  </div>
                  <button
                    type="button"
                    onClick={() => copyAddress(JACKPOT_WALLET_ADDRESS)}
                    className="mt-1 flex max-w-[240px] items-center gap-1 font-mono text-[9px] text-slate-500 hover:text-emerald-400"
                    title={JACKPOT_WALLET_ADDRESS}
                  >
                    <span className="truncate">{JACKPOT_WALLET_ADDRESS}</span>
                    {addressCopied ? (
                      <Check className="h-3 w-3 shrink-0 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3 shrink-0" />
                    )}
                  </button>
                  {jackpotBalanceError && !simulationMode && (
                    <div
                      className="mt-1 max-w-[240px] text-[9px] text-red-400"
                      title={jackpotBalanceError}
                    >
                      Jackpot balance temporarily unavailable
                    </div>
                  )}
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
                // Feed the machine the already-generated frontend result so
                // the animation reveals the exact winning digits.
                forcedResult={resolvedDraw ? resolvedDraw.numbers : undefined}
                onComplete={handleDrawComplete}
              />

              {drawMessage && (
                <div className="mt-4 text-sm font-medium text-center text-emerald-300 bg-emerald-950/40 border border-emerald-800/60 px-4 py-2 rounded-xl animate-fade-in">
                  {drawMessage}
                </div>
              )}

              {payoutPending && pendingWinnerAddress && (
                <div className="mt-3 rounded-xl border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-center text-xs text-amber-300">
                  Confirm the jackpot transfer in Paytaca.
                  <div className="mt-1 break-all font-mono text-[10px] text-amber-200">
                    Winner: {pendingWinnerAddress}
                  </div>
                </div>
              )}

              {payoutTxid && (
                <div className="mt-3 rounded-xl border border-emerald-800/60 bg-emerald-950/30 px-4 py-3 text-center text-xs text-emerald-300">
                  Jackpot payout broadcast successfully.
                  <div className="mt-1 break-all font-mono text-[10px] text-emerald-200">
                    Txid: {payoutTxid}
                  </div>
                </div>
              )}
            </div>

            <div className="mb-6 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/60">
              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                <h3 className="flex items-center text-sm font-bold uppercase tracking-wider text-slate-300">
                  <Trophy className="mr-2 h-4 w-4 text-emerald-400" />
                  Draw Result History
                </h3>
                <span className="text-[10px] text-slate-500">
                  {drawHistory.length} draw{drawHistory.length === 1 ? "" : "s"}
                </span>
              </div>

              {drawHistory.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-slate-500">
                  Completed draw results will appear here.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left text-xs">
                    <thead className="bg-slate-900/80 text-[10px] uppercase tracking-wider text-slate-400">
                      <tr>
                        <th className="px-4 py-3 font-bold">Drawn At</th>
                        <th className="px-4 py-3 font-bold">Result</th>
                        <th className="px-4 py-3 font-bold">Jackpot</th>
                        <th className="px-4 py-3 font-bold">Outcome</th>
                        <th className="px-4 py-3 font-bold">Mode</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {drawHistory.map((draw) => (
                        <tr key={draw.id} className="text-slate-300">
                          <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                            {draw.drawnAt}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              {draw.numbers.map((number, index) => (
                                <span
                                  key={`${draw.id}-${index}`}
                                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-800/60 bg-emerald-950/40 font-mono font-bold text-emerald-300"
                                >
                                  {number}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <div className="font-mono font-bold text-white">
                              {bchPriceFormatted(draw.jackpotSats)}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              {phpPriceFormatted(draw.jackpotSats)}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase ${
                                draw.hadWinner
                                  ? "border-emerald-800/60 bg-emerald-950/50 text-emerald-300"
                                  : "border-amber-800/60 bg-amber-950/40 text-amber-300"
                              }`}
                            >
                              {draw.hadWinner
                                ? `${draw.winnerCount} winner${draw.winnerCount === 1 ? "" : "s"}`
                                : "Rolled over"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-400">
                            {draw.simulated ? "Simulation" : "Live"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                        : "Frontend Draw Ready"}
                    </span>
                  </div>
                  <span className="text-xs font-mono text-emerald-400 bg-emerald-900/40 px-2 py-0.5 rounded">
                    {resolvedDraw.simulated
                      ? "Simulated"
                      : "Frontend RNG"}
                  </span>
                </div>
                <p className="text-xs text-slate-300">
                  Winning numbers{" "}
                  {resolvedDraw.simulated
                    ? "generated locally"
                    : "generated securely in this browser"}
                  :{" "}
                  <strong className="text-white">
                    {resolvedDraw.numbers.join(" - ")}
                  </strong>
                </p>
                <div className="flex items-center space-x-3 pt-1">
                  <Button
                    onClick={handleResolveOnChain}
                    disabled={resolvePending || !bettorAddress}
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


          </Card>
        </div>

        <div className="space-y-6">
          <Card className="bg-slate-900/40 border-slate-800 p-5 rounded-2xl shadow-xl">
<div className="space-y-4">
  <div className="flex items-center justify-between gap-3">
    <h3 className="flex items-center text-sm font-bold uppercase tracking-wider text-slate-300">
      <Ticket className="mr-2 h-4 w-4 text-emerald-400" />
      Select Your Numbers
    </h3>

    <div className="flex items-center space-x-2">
      <Button
        size="sm"
        variant="outline"
        onClick={handleQuickPick}
        disabled={bettingClosed}
        className="h-8 border-slate-700 bg-slate-800/40 text-xs text-slate-300 hover:bg-slate-800"
      >
        <Zap className="mr-1 h-3 w-3 text-amber-400" />
        Quick Pick
      </Button>

      {selectedNumbers.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setSelectedNumbers([])}
          disabled={bettingClosed}
          className="h-8 text-xs text-slate-400 hover:text-red-400"
        >
          Clear
        </Button>
      )}
    </div>
  </div>

  {/* Ordered selected-number slots */}
  <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Your Ordered Combination
        </div>

        <p className="mt-1 text-xs text-slate-500">
          Numbers are recorded in the exact order
          you select them. Duplicate digits are allowed.
        </p>
      </div>

      <div className="shrink-0 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 font-mono text-xs font-bold text-slate-300">
        {selectedNumbers.length}/
        {activeGame.pickCount}
      </div>
    </div>

    <div
      className="grid gap-3"
      style={{
        gridTemplateColumns: `repeat(${activeGame.pickCount}, minmax(0, 1fr))`,
      }}
    >
      {Array.from(
        { length: activeGame.pickCount },
        (_, index) => {
          const selectedNumber =
            selectedNumbers[index];

          const hasNumber =
            selectedNumber !== undefined;

          return (
            <button
              key={index}
              type="button"
              onClick={() => {
                if (hasNumber) {
                  removeSelectedNumber(index);
                }
              }}
              disabled={
                !hasNumber || bettingClosed
              }
              className={`relative flex min-h-24 flex-col items-center justify-center rounded-xl border transition-all ${
                hasNumber
                  ? "border-emerald-500 bg-gradient-to-b from-emerald-600 to-emerald-700 text-white shadow-lg shadow-emerald-950/40"
                  : "border-dashed border-slate-700 bg-slate-900/60 text-slate-600"
              } ${
                hasNumber &&
                !bettingClosed
                  ? "cursor-pointer hover:-translate-y-0.5 hover:border-emerald-400 hover:from-emerald-500 hover:to-emerald-600"
                  : "cursor-default"
              }`}
              title={
                hasNumber
                  ? `Remove the ${getOrdinalLabel(index)} selected number`
                  : `Waiting for the ${getOrdinalLabel(index)} number`
              }
            >
              <span
                className={`absolute left-2 top-2 rounded-md border px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${
                  hasNumber
                    ? "border-emerald-300/30 bg-emerald-950/40 text-emerald-100"
                    : "border-slate-700 bg-slate-800 text-slate-500"
                }`}
              >
                {getOrdinalLabel(index)}
              </span>

              <span className="font-mono text-4xl font-black">
                {hasNumber
                  ? selectedNumber
                  : "—"}
              </span>

              <span
                className={`mt-1 text-[9px] font-semibold uppercase ${
                  hasNumber
                    ? "text-emerald-100/80"
                    : "text-slate-600"
                }`}
              >
                {hasNumber
                  ? "Click to remove"
                  : "Not selected"}
              </span>
            </button>
          );
        },
      )}
    </div>

 
  </div>

  {/* Available digits */}
  <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">
          Available Digits
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          Tap a digit to add it to the next available position. Duplicate digits are allowed.
        </p>
      </div>

      <div
        className={`rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-wide ${
          selectedNumbers.length >= activeGame.pickCount
            ? "border-emerald-800/60 bg-emerald-950/50 text-emerald-300"
            : "border-slate-700 bg-slate-900 text-slate-400"
        }`}
      >
        {selectedNumbers.length >= activeGame.pickCount
          ? "Combination complete"
          : `${activeGame.pickCount - selectedNumbers.length} remaining`}
      </div>
    </div>

    <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
      {Array.from(
        { length: activeGame.maxNumber + 1 },
        (_, number) => {
          const selectionPositions = selectedNumbers
            .map((selectedNumber, position) =>
              selectedNumber === number ? position : -1,
            )
            .filter((position) => position !== -1);

          const isSelected = selectionPositions.length > 0;
          const selectionLimitReached =
            selectedNumbers.length >= activeGame.pickCount;
          const isDisabled = bettingClosed || selectionLimitReached;

          return (
            <button
              key={number}
              type="button"
              onClick={() => toggleNumber(number)}
              disabled={isDisabled}
              aria-label={`Select digit ${number}`}
              className={`relative flex aspect-square min-h-12 w-full items-center justify-center rounded-xl border font-mono text-xl font-black transition-all duration-150 ${
                isSelected
                  ? "border-emerald-500 bg-emerald-950/70 text-emerald-200 shadow-md shadow-emerald-950/40"
                  : "border-slate-700 bg-slate-900/80 text-slate-200 hover:-translate-y-0.5 hover:border-emerald-600 hover:bg-slate-800 hover:text-white"
              } ${
                isDisabled
                  ? "cursor-not-allowed opacity-45"
                  : "cursor-pointer active:translate-y-0 active:scale-95"
              }`}
            >
              <span>{number}</span>

              {selectionPositions.length > 0 && (
                <div className="absolute -right-1.5 -top-1.5 flex max-w-[48px] flex-wrap justify-end gap-0.5">
                  {selectionPositions.map((position) => (
                    <span
                      key={position}
                      className="flex h-5 min-w-5 items-center justify-center rounded-full border border-emerald-200 bg-emerald-600 px-1 text-[9px] font-black leading-none text-white shadow-md"
                      title={`${getOrdinalLabel(position)} selected digit`}
                    >
                      {position + 1}
                    </span>
                  ))}
                </div>
              )}
            </button>
          );
        },
      )}
    </div>

    {selectedNumbers.length >= activeGame.pickCount && (
      <p className="mt-3 text-center text-[11px] text-slate-500">
        Remove a digit from the ordered combination above to choose another one.
      </p>
    )}
  </div>


  <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
    <div className="grid gap-3 sm:grid-cols-3">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Ticket
        </div>
        <div className="mt-1 font-mono text-lg font-black text-white">
          {selectedNumbers.length === activeGame.pickCount
            ? selectedNumbers.join("-")
            : "—"}
        </div>
      </div>

      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Ticket Price
        </div>
        <div className="mt-1 font-bold text-white">
          {bchPriceFormatted(activeGame.ticketPriceSats)}
        </div>
        <div className="text-[10px] text-slate-500">
          {phpPriceFormatted(activeGame.ticketPriceSats)}
        </div>
      </div>

      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Estimated Total
        </div>
        <div
          className={`mt-1 font-bold ${
            hasEstimatedTicketBalance
              ? "text-emerald-300"
              : "text-red-400"
          }`}
        >
          {bchPriceFormatted(estimatedTicketTotalSats)}
        </div>
        <div className="text-[10px] text-slate-500">
          Includes an estimated network-fee allowance
        </div>
      </div>
    </div>

    {!simulationMode && bettorAddress && (
      <div className="mt-3 flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs">
        <span className="text-slate-400">
          Available wallet balance
        </span>
        <span
          className={`font-mono font-bold ${
            hasEstimatedTicketBalance
              ? "text-emerald-300"
              : "text-red-400"
          }`}
        >
          {bchPriceFormatted(bettorBalanceSats)}
        </span>
      </div>
    )}

    <Button
      onClick={handleBuyTicket}
      disabled={
        txPending ||
        bettingClosed ||
        !bettorAddress ||
        !hasEstimatedTicketBalance ||
        selectedNumbers.length !== activeGame.pickCount
      }
      className="mt-4 h-12 w-full rounded-xl bg-emerald-600 text-sm font-black text-white shadow-lg shadow-emerald-900/40 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {txPending
        ? purchaseStatus ??
          (usingPaytaca
            ? "Confirm in Paytaca..."
            : "Purchasing ticket...")
        : bettingClosed
          ? "Betting Closed"
          : !bettorAddress
            ? "Connect a Wallet First"
            : selectedNumbers.length !== activeGame.pickCount
              ? `Select ${activeGame.pickCount} Digits`
              : !hasEstimatedTicketBalance
                ? "Insufficient Wallet Balance"
                : `Buy Ticket ${selectedNumbers.join("-")}`}
    </Button>

    {purchaseStatus && txPending && (
      <div className="mt-3 flex items-center justify-center gap-2 text-xs text-amber-300">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
        {purchaseStatus}
      </div>
    )}
  </div>

  {purchaseMessage && (
    <div className="rounded-xl border border-emerald-800/60 bg-emerald-950/40 p-3 text-xs text-emerald-300">
      <div className="flex items-start gap-2">
        <Check className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <div className="font-bold">
            Ticket purchase completed
          </div>
          <div className="mt-1 break-all font-mono text-[10px] text-emerald-200/80">
            {purchaseMessage}
          </div>
        </div>
      </div>
    </div>
  )}

  {chainError && (
    <div className="flex items-center space-x-2 rounded-xl border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-400">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>{chainError}</span>
    </div>
  )}

  {walletError && (
    <div className="flex items-center space-x-2 rounded-xl border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-400">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>{walletError}</span>
    </div>
  )}
</div>
          </Card>

          {simulationMode && (
            <Card className="bg-amber-950/20 border-amber-800/50 p-6 rounded-2xl shadow-xl space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-amber-300 flex items-center">
                <FlaskConical className="w-4 h-4 mr-2" />
                Simulation Mode Active
              </h3>
              <p className="text-[11px] text-amber-100/80">
                Ticket purchases accumulate in a simulated jackpot wallet.
                Drawing and resolving use local in-memory state, so no real BCH
                or contract seed deposit is required.
              </p>

              <Button
                onClick={handleResetSimulation}
                variant="outline"
                className="w-full border-amber-800/60 bg-amber-950/30 text-xs h-9 text-amber-200 hover:bg-amber-900/40"
              >
                <RotateCcw className="w-3 h-3 mr-2" />
                Reset Simulation
              </Button>
            </Card>
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
                    {jackpotBalanceLoading
                      ? "Loading..."
                      : bchPriceFormatted(jackpotBalanceSats)}
                  </div>
                  <div className="text-[10px] text-slate-400">Permanent Jackpot Wallet</div>
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
                  ? simulationMode
                    ? "Starting simulated draw..."
                    : "Generating result..."
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
