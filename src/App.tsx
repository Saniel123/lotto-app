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
  signOracleWinningNumber,
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
  Zap,
  Copy,
  Check,
  ExternalLink,
  Droplets,
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
    drawDays: "Daily (2PM, 5PM, 9PM)",
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
}

interface DrawSlot {
  hour: number;
  minute: number;
  days?: number[];
}

const DRAW_SCHEDULES: Record<string, DrawSlot[]> = {
  swertres: [
    { hour: 14, minute: 0 },
    { hour: 17, minute: 0 },
    { hour: 21, minute: 0 },
  ],
};

const BETTING_CUTOFF_MS = 60_000;
const REFUND_GRACE_SECONDS = 7 * 24 * 60 * 60;
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

interface ResolvedDraw {
  gameId: string;
  slotEpochMs: number;
  blockHeight: number;
  blockHash: string;
  headerHex: string;
  winningNumber: number;
  numbers: number[];
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

async function findResolvingBlock(slotEpochMs: number, fromHeight: number) {
  let height = fromHeight;
  for (let i = 0; i < 5000; i++) {
    const header = await fetchBlockHeader(height);
    if (!header) return null;
    const ts = parseHeaderTimestamp(header) * 1000;
    if (ts >= slotEpochMs) return { height, header };
    height++;
  }
  return null;
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

  const [wallet, setWallet] = useState<WalletKeypair | null>(null);
  const [walletBalanceSats, setWalletBalanceSats] = useState<bigint>(0n);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);

  const CHIPNET_FAUCET_URL = "https://tbch.googol.cash";

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
  const [viewingTicket, setViewingTicket] = useState<TicketItem | null>(null);

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

  const [nextDrawAt, setNextDrawAt] = useState<Date>(() =>
    getNextDrawDate(selectedGameId, new Date()),
  );
  const [msRemaining, setMsRemaining] = useState<number>(
    () => nextDrawAt.getTime() - Date.now(),
  );

  const scanFromHeightRef = useRef<Record<string, number>>({});
  const resolvedSlotKeyRef = useRef<string | null>(null);
  const scheduledResultRef = useRef<number[] | null>(null);
  const drawingGameIdRef = useRef(selectedGameId);
  const drawingSlotEpochRef = useRef<number>(nextDrawAt.getTime());

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
  }, []);

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

  const disconnectWallet = () => {
    localStorage.removeItem(WALLET_STORAGE_KEY);
    setWallet(null);
    setWalletBalanceSats(0n);
    setWalletError(null);
  };

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
  }, [selectedGameId, nextDrawAt]);

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

  useEffect(() => {
    const tick = () => setMsRemaining(nextDrawAt.getTime() - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextDrawAt]);

  useEffect(() => {
    let cancelled = false;
    const gameId = selectedGameId;
    const slotEpochMs = nextDrawAt.getTime();
    const slotKey = `${gameId}:${slotEpochMs}`;

    const poll = async () => {
      if (cancelled || drawPending) return;
      if (resolvedSlotKeyRef.current === slotKey) return;
      if (Date.now() < slotEpochMs) return;

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
            scanFromHeightRef.current[gameId] = found.height + 1;
            return;
          }

          const blockHash = bytesToHexReversed(rawDigest);
          const game = LOTTO_GAMES[0];
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
          setForceDrawPending(false);
          setDrawPending(true);
        }
      } catch (err) {
        console.warn("Chain poll failed, will retry:", err);
        if (!cancelled) setChainError("Could not reach the chain — retrying…");
      } finally {
        if (!cancelled) setChainChecking(false);
      }
    };

    poll();
    const id = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [nextDrawAt, selectedGameId, drawPending]);

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

  const bettingClosed =
    drawPending ||
    forceDrawPending ||
    (msRemaining > 0 && msRemaining <= BETTING_CUTOFF_MS) ||
    msRemaining <= 0;

  const handleForceDrawNow = () => {
    if (drawPending || forceDrawPending) return;
    setChainError(null);
    setDrawMessage(null);
    setForceDrawPending(true);
    setNextDrawAt(new Date());
  };

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
    if (!wallet || selectedNumbers.length !== activeGame.pickCount) return;
    setTxPending(true);
    setChainError(null);
    try {
      const contract = getSlotContract(activeGame, nextDrawAt.getTime());

      // Combine the picked digits into the single number the contract's
      // pickedNumber/winningNumber commitment scheme expects.
     const pickedNumber = digitsToPickedNumber(selectedNumbers);
const maxRange = maxTicketRangeFor(activeGame);
console.log("buyTicket debug:", { selectedNumbers, pickedNumber, maxRange });
      

      const res = await chainBuyTicket(
        contract,
        activeGame.ticketPriceSats,
        wallet.pkHash,
        pickedNumber,
        wallet.privateKey,
        wallet.address,
      );

      const newTicket: TicketItem = {
        id: Math.random().toString(36).substring(2, 9),
        game: activeGame.name,
        gameId: activeGame.id,
        slotEpochMs: nextDrawAt.getTime(),
        numbers: [...selectedNumbers],
        txid: res.txid,
        address: contract.address,
        amountSats: activeGame.ticketPriceSats,
        timestamp: new Date().toLocaleTimeString(),
      };

      setPurchasedTickets([newTicket, ...purchasedTickets]);
      setSelectedNumbers([]);

      const bal = await getWalletBalanceSats(wallet.address);
      setWalletBalanceSats(bal);

      const utxos = await contract.getUtxos();
      const total = utxos.reduce((sum, u) => sum + BigInt(u.satoshis), 0n);
      setActiveContractSats(total);
    } catch (err) {
  console.error("Buy ticket failed:", err);
  console.error("Full error object:", err);
  if (err && typeof err === "object") {
    console.error("Error keys:", Object.keys(err));
  }
  setChainError(
    err instanceof Error ? err.message : "Could not buy ticket on-chain.",
  );
}    finally {
      setTxPending(false);
    }
  };

  const handleResolveOnChain = async () => {
    if (!resolvedDraw || !wallet) return;
    setResolvePending(true);
    setChainError(null);
    try {
      const contract = getSlotContract(activeGame, resolvedDraw.slotEpochMs);

      const { oracleSig, oracleMessage } = await signOracleWinningNumber(
        oracleKeypair.privateKey,
        resolvedDraw.winningNumber,
      );

      const txid = await chainResolveDraw(
        contract,
        oracleSig,
        oracleMessage,
        wallet.address,
        wallet.pkHash,
        resolvedDraw.winningNumber,
        wallet.privateKey,
      );

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

  const handleDrawComplete = () => {
    const winning = scheduledResultRef.current ?? [3, 3, 3];
    setLastWinningNumbers(winning);
    setDrawPending(false);

    const gameId = drawingGameIdRef.current;
    const slotEpoch = drawingSlotEpochRef.current;
    const game = LOTTO_GAMES[0];

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

    setNextDrawAt(getNextDrawDate(selectedGameId, new Date()));
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
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-40 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-emerald-600 p-2 rounded-xl text-white shadow-lg shadow-emerald-900/40">
            <Trophy className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-emerald-400 to-teal-200 bg-clip-text text-transparent">
              PCSO Swertres Lotto on Bitcoin Cash
            </h1>
            <p className="text-xs text-slate-400">
              Decentralized Digit Games on Chipnet
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {wallet ? (
            <div className="flex items-center bg-slate-800/80 border border-slate-700 rounded-xl px-3 py-1.5 text-xs space-x-3">
              <div>
                <button
                  onClick={() => copyAddress(wallet.address)}
                  title={wallet.address}
                  className="flex items-center gap-1.5 text-slate-400 font-mono text-[10px] hover:text-emerald-400 transition-colors"
                >
                  <span>
                    {wallet.address.slice(0, 8)}...{wallet.address.slice(-6)}
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
                onClick={disconnectWallet}
                className="h-7 px-2 text-slate-400 hover:text-red-400 hover:bg-slate-700/50"
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <Button
              onClick={connectWallet}
              disabled={walletLoading}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs h-9 px-4 rounded-xl shadow-lg shadow-emerald-900/30"
            >
              <Wallet className="w-4 h-4 mr-2" />
              {walletLoading ? "Connecting..." : "Connect Wallet"}
            </Button>
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
                  Draw Schedule: {activeGame.drawDays}
                </p>
              </div>

              <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl flex items-center space-x-6">
                <div>
                  <div className="text-[10px] uppercase font-bold text-slate-400 flex items-center">
                    <Clock className="w-3 h-3 mr-1 text-emerald-400" />
                    Next Estimated Draw
                  </div>
                  <div className="text-lg font-mono font-bold text-white mt-0.5">
                    {formatCountdown(msRemaining)}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {formatSlotTime(nextDrawAt)}
                  </div>
                </div>

                <div className="border-l border-slate-800 pl-6">
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
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 rounded-2xl p-6 mb-6 flex flex-col items-center justify-center min-h-[220px]">
              <LotteryDrawMachine
                pickCount={activeGame.pickCount}
                maxNumber={activeGame.maxNumber}
                isDrawing={drawPending}
                winningNumbers={lastWinningNumbers}
                onDrawComplete={handleDrawComplete}
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
                      Chain Draw Ready to Resolve
                    </span>
                  </div>
                  <span className="text-xs font-mono text-emerald-400 bg-emerald-900/40 px-2 py-0.5 rounded">
                    Block #{resolvedDraw.blockHeight}
                  </span>
                </div>
                <p className="text-xs text-slate-300">
                  Winning numbers derived from block hash:{" "}
                  <strong className="text-white">
                    {resolvedDraw.numbers.join(" - ")}
                  </strong>
                </p>
                <div className="flex items-center space-x-3 pt-1">
                  <Button
                    onClick={handleResolveOnChain}
                    disabled={resolvePending || !wallet}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-8 px-4 rounded-lg"
                  >
                    {resolvePending ? "Executing..." : "Execute resolveDraw()"}
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
                      disabled={seedPending || !wallet}
                      variant="outline"
                      className="border-slate-700 bg-slate-800/40 text-xs h-11 px-4 rounded-xl text-slate-300 hover:bg-slate-800"
                    >
                      {seedPending ? "Seeding..." : "Seed Contract"}
                    </Button>
                  )}

                  <Button
                    onClick={handleBuyTicket}
                    disabled={
                      txPending ||
                      bettingClosed ||
                      !wallet ||
                      selectedNumbers.length !== activeGame.pickCount
                    }
                    className="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm h-11 px-8 rounded-xl shadow-lg shadow-emerald-900/40 disabled:opacity-50"
                  >
                    {txPending
                      ? "Purchasing..."
                      : bettingClosed
                        ? "Betting Closed"
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
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          {wallet && (
            <Card className="bg-slate-900/40 border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 flex items-center">
                <Droplets className="w-4 h-4 mr-2 text-emerald-400" />
                Fund Your Chipnet Wallet
              </h3>

              <div>
                <div className="text-[10px] uppercase font-bold text-slate-400 mb-1.5">
                  Your Address
                </div>
                <div className="flex items-stretch bg-slate-950/70 border border-slate-800 rounded-xl overflow-hidden">
                  <div className="flex-1 px-3 py-2.5 text-[11px] font-mono text-slate-300 break-all select-all">
                    {wallet.address}
                  </div>
                  <button
                    onClick={() => copyAddress(wallet.address)}
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
                    Get free tBCH from the chipnet faucet
                  </div>
                </div>
                <a
                  href={CHIPNET_FAUCET_URL}
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
                your wallet. Fund with a bit extra to cover several
                purchases.
              </p>
            </Card>
          )}

          <Card className="bg-slate-900/40 border-slate-800 p-6 rounded-2xl shadow-xl">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 mb-4 flex items-center">
              <Layers className="w-4 h-4 mr-2 text-emerald-400" />
              Active Game
            </h3>
            <div className="space-y-3">
              <div
                className="w-full text-left p-4 rounded-xl border bg-emerald-950/30 border-emerald-700/60 shadow-lg shadow-emerald-950/20 transition-all flex items-center justify-between"
              >
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
                    {bchPriceFormatted(
                      gameContractSats[activeGame.id] ?? 0n,
                    )}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Pool Balance
                  </div>
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
                      <span className="font-bold text-emerald-400">
                        {t.game}
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
                    Simulate matching draw result for demo
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
                variant="outline"
                className="w-full border-slate-700 bg-slate-800/40 text-xs h-10 text-slate-300 hover:bg-slate-800"
              >
                {forceDrawPending ? "Waiting for slot..." : "Draw Now (Demo)"}
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
              Congratulations! Your ticket matched the winning combination on-chain and won an estimated prize of{" "}
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