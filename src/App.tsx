import { useState, useEffect, useRef } from "react";
import { ElectrumNetworkProvider } from "cashscript";
import LotteryArtifact from "./contracts/Lottery.json";

import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import LotteryDrawMachine from "./components/LotteryDrawMachine";
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
  Zap,
  Lock,
} from "lucide-react";

// Network Config
const provider = new ElectrumNetworkProvider("chipnet");

// PCSO-style Digit Lotto Games — each game just varies how many digit
// chambers the draw machine shows (pickCount) and the digit range
// (maxNumber). Ticket price and jackpot pool scale up with difficulty.
interface LottoGame {
  id: string;
  name: string;
  shortLabel: string;
  maxNumber: number;
  pickCount: number;
  jackpotBch: number;
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
    jackpotBch: 2.0,
    drawDays: "Daily (11AM, 4PM, 9PM)",
    ticketPriceSats: 50000n, // 0.0005 BCH
  },
  {
    id: "swertres",
    name: "Swertres Lotto",
    shortLabel: "3D",
    maxNumber: 9,
    pickCount: 3,
    jackpotBch: 15.0,
    drawDays: "Daily (2PM, 5PM, 9PM)",
    ticketPriceSats: 100000n, // 0.001 BCH
  },
  {
    id: "4d",
    name: "4D Lotto",
    shortLabel: "4D",
    maxNumber: 9,
    pickCount: 4,
    jackpotBch: 40.0,
    drawDays: "Tue · Fri · Sun 9PM",
    ticketPriceSats: 150000n, // 0.0015 BCH
  },
  {
    id: "6d",
    name: "6D Lotto",
    shortLabel: "6D",
    maxNumber: 9,
    pickCount: 6,
    jackpotBch: 90.0,
    drawDays: "Daily 9PM",
    ticketPriceSats: 200000n, // 0.002 BCH
  },
];

interface TicketItem {
  id: string;
  game: string;
  numbers: number[];
  txid: string;
  address: string;
  amountSats: bigint;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// SYNCHRONIZED DRAW SCHEDULE
// ---------------------------------------------------------------------------
// Real lotteries run on a single preset draw time shared by every ticket
// holder — that's what keeps results identical across users and keeps the
// prize pool coherent (everyone is being evaluated against the same outcome
// at the same instant). Below, each game gets a fixed set of daily/weekly
// draw slots. `days` is 0=Sun..6=Sat; omit for "every day".
interface DrawSlot {
  hour: number;
  minute: number;
  days?: number[];
}

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

// Betting closes this many ms before a scheduled draw fires, so no one can
// time a last-second entry against a result that's effectively already set.
const BETTING_CUTOFF_MS = 10_000;

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

// Deterministic PRNG seeded from the game + the exact scheduled slot
// timestamp. Any client resolving this same slot arrives at the same
// numbers — that's the "synchronous, single shared result" property a real
// draw needs, instead of each user's browser rolling its own Math.random().
function hashStringToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSyncedDraw(game: LottoGame, slotEpochMs: number): number[] {
  const seed = hashStringToInt(`${game.id}:${slotEpochMs}`);
  const rng = mulberry32(seed);
  return Array.from({ length: game.pickCount }, () =>
    Math.floor(rng() * (game.maxNumber + 1)),
  );
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

export default function App() {
  const isInitializing = useRef(false);

  // Live Exchange Rate State
  const [bchToPhpRate, setBchToPhpRate] = useState<number | null>(null);

  // Mocknet Wallet State
  const [walletConnected, setWalletConnected] = useState(false);
  const [userBchAddress, setUserBchAddress] = useState("");
  const [walletBalanceSats, setWalletBalanceSats] =
    useState<bigint>(1000000000n); // 10 BCH Mock Balance

  // Active Game Selection State — drives the draw machine, ticket price, and jackpot pool
  const [selectedGameId, setSelectedGameId] = useState<string>("swertres");
  const activeGame =
    LOTTO_GAMES.find((g) => g.id === selectedGameId) ?? LOTTO_GAMES[1];

  // Per-game Covenant Pool Balances — each game keeps its own jackpot so switching
  // games doesn't bleed one prize pool into another
  const [contractBalances, setContractBalances] = useState<
    Record<string, bigint>
  >(
    Object.fromEntries(
      LOTTO_GAMES.map((g) => [g.id, BigInt(Math.round(g.jackpotBch * 1e8))]),
    ),
  );
  const contractBalanceSats = contractBalances[selectedGameId] ?? 0n;

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
  const [lastSecret, setLastSecret] = useState<string | null>(null);

  // Testing Force-Win State & Celebration Modal State
  const [forceWinMode, setForceWinMode] = useState(false);
  const [showPopupCelebration, setShowPopupCelebration] = useState(false);
  const [wonPrizePhp, setWonPrizePhp] = useState("");

  const [loading, setLoading] = useState(false);
  const [txPending, setTxPending] = useState(false);
  const [drawPending, setDrawPending] = useState(false);

  // --- Synchronized draw scheduling state ---
  const [nextDrawAt, setNextDrawAt] = useState<Date>(() =>
    getNextDrawDate(selectedGameId, new Date()),
  );
  const [msRemaining, setMsRemaining] = useState<number>(
    () => nextDrawAt.getTime() - Date.now(),
  );

  // Captures which game + which scheduled slot a draw was resolving, so a
  // late-resolving draw always credits/matches against the right game and
  // the right result — even if the UI has since moved to another game.
  const drawingGameIdRef = useRef(selectedGameId);
  const drawingSlotEpochRef = useRef<number>(nextDrawAt.getTime());
  const firedSlotRef = useRef<number | null>(null);
  const scheduledResultRef = useRef<number[] | null>(null);

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

  // 2. Connect Mocknet Local Wallet
  const connectMocknetWallet = () => {
    setLoading(true);
    setTimeout(() => {
      const fakeAddress = "bchtest:qpm20082t9q86pt326402436d8m57q42as2s4r8322";
      setUserBchAddress(fakeAddress);
      setWalletBalanceSats(1000000000n);
      setWalletConnected(true);
      setLoading(false);
    }, 400);
  };

  // Game Selection Handler — swaps the active game, resets any in-progress pick,
  // clears the previous game's draw result, and re-syncs the countdown to this
  // game's own preset schedule.
  const handleSelectGame = (gameId: string) => {
    if (drawPending || gameId === selectedGameId) return;
    setSelectedGameId(gameId);
    setSelectedNumbers([]);
    setLastWinningNumbers(null);
    setDrawMessage(null);
    setLastSecret(null);
    firedSlotRef.current = null;
    scheduledResultRef.current = null;
    setNextDrawAt(getNextDrawDate(gameId, new Date()));
  };

  // 3. Master clock — ticks every second, drives the countdown display, and
  // is the ONLY thing that triggers a draw. No per-user "Run Draw" click:
  // the result fires exactly once, for everyone, at the preset slot time.
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const remaining = nextDrawAt.getTime() - now;
      setMsRemaining(remaining);

      if (
        remaining <= 0 &&
        !drawPending &&
        firedSlotRef.current !== nextDrawAt.getTime()
      ) {
        firedSlotRef.current = nextDrawAt.getTime();
        drawingGameIdRef.current = selectedGameId;
        drawingSlotEpochRef.current = nextDrawAt.getTime();
        scheduledResultRef.current = generateSyncedDraw(
          activeGame,
          nextDrawAt.getTime(),
        );
        setDrawPending(true);
        setDrawMessage(null);
        setLastSecret(null);
        setLastWinningNumbers(null);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextDrawAt, drawPending, selectedGameId]);

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

  // Betting is closed once we're inside the cutoff window before the next
  // scheduled draw, or while a draw is actively resolving.
  const bettingClosed =
    drawPending ||
    (msRemaining > 0 && msRemaining <= BETTING_CUTOFF_MS) ||
    msRemaining <= 0;

  // Buy Ticket Handler
  const handleBuyTicket = async () => {
    if (
      !walletConnected ||
      selectedNumbers.length !== activeGame.pickCount ||
      bettingClosed
    )
      return;
    setTxPending(true);

    try {
      await new Promise((resolve) => setTimeout(resolve, 800));

      const price = activeGame.ticketPriceSats;
      setWalletBalanceSats((prev) => prev - price);
      setContractBalances((prev) => ({
        ...prev,
        [activeGame.id]: (prev[activeGame.id] ?? 0n) + price,
      }));

      const mockTxid =
        "tx_mocknet_" + Math.random().toString(36).substring(2, 12);
      const ticketId = "TCK-" + Math.floor(100000 + Math.random() * 900000);
      const timestampStr = new Date().toLocaleString();

      const newTicket: TicketItem = {
        id: ticketId,
        game: activeGame.name,
        numbers: selectedNumbers,
        txid: mockTxid,
        address: userBchAddress,
        amountSats: price,
        timestamp: timestampStr,
      };

      setPurchasedTickets([newTicket, ...purchasedTickets]);
      setSelectedNumbers([]);
    } catch (err) {
      console.error("Mocknet transaction evaluation failed:", err);
      alert("Mocknet transaction failed.");
    } finally {
      setTxPending(false);
    }
  };

  // TESTING ONLY: real draws wait for the preset schedule. This just pulls
  // the next slot into "now" so you don't have to sit through real hours
  // while testing — it does NOT change how the result is generated.
  const handleFastForwardDraw = () => {
    if (drawPending) return;
    setNextDrawAt(new Date());
  };

  // Called by LotteryDrawMachine once all balls have physically been drawn from the chamber
  const handleDrawComplete = (winningDraw: number[]) => {
    const drawnGameId = drawingGameIdRef.current;
    const drawnSlotEpoch = drawingSlotEpochRef.current;
    const drawnGame =
      LOTTO_GAMES.find((g) => g.id === drawnGameId) ?? activeGame;

    const generatedSecret =
      "slot_" +
      drawnSlotEpoch +
      "_" +
      Math.random().toString(36).substring(2, 6);
    setLastSecret(generatedSecret);
    setLastWinningNumbers(winningDraw);

    const winningStr = winningDraw.join("");
    const matchingTicket = purchasedTickets.find(
      (t) => t.game === drawnGame.name && t.numbers.join("") === winningStr,
    );

    if (matchingTicket) {
      const prizeWonSats = contractBalances[drawnGameId] ?? 0n;
      const prizeBch = Number(prizeWonSats) / 1e8;
      const prizePhpCalc = bchToPhpRate
        ? (prizeBch * bchToPhpRate).toLocaleString("en-PH", {
            maximumFractionDigits: 0,
          })
        : "15,000,000";

      setWonPrizePhp(prizePhpCalc);
      setWalletBalanceSats((prev) => prev + prizeWonSats);
      setContractBalances((prev) => ({ ...prev, [drawnGameId]: 0n }));
      setShowPopupCelebration(true);
      setDrawMessage(
        `🎉 JACKPOT WINNER! Your ${drawnGame.name} ticket ${winningStr} matched the ${formatSlotTime(new Date(drawnSlotEpoch))} draw! Prize successfully claimed!`,
      );
    } else {
      setDrawMessage(
        `❌ No matching ${drawnGame.name} tickets found for the ${formatSlotTime(new Date(drawnSlotEpoch))} draw combination ${winningStr}. Covenant pool rolls over to the next scheduled draw!`,
      );
    }

    setDrawPending(false);
    scheduledResultRef.current = null;

    // Advance to the following scheduled slot for the game that just drew,
    // so the countdown keeps running toward the next synchronized result.
    const nextSlot = getNextDrawDate(
      drawnGameId,
      new Date(drawnSlotEpoch + 1000),
    );
    if (drawnGameId === selectedGameId) {
      setNextDrawAt(nextSlot);
    }
  };

  // Formatting & Conversion Calculations
  const bchBalance = Number(walletBalanceSats) / 1e8;
  const phpBalance = bchToPhpRate
    ? (bchBalance * bchToPhpRate).toLocaleString("en-PH", {
        maximumFractionDigits: 2,
      })
    : "...";

  const contractBchBalance = Number(contractBalanceSats) / 1e8;
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
    const bal = contractBalances[game.id] ?? 0n;
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
                ✓ Deposited directly to your Mocknet wallet via Covenant
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
                  <span className="text-slate-300">{viewingTicket.txid}</span>
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
                Realistic Tickets
              </span>
            </h1>
            <p className="text-xs text-slate-400 font-mono">
              Verifiable On-Chain Ticket Passes & Payouts
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {walletConnected ? (
            <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-2xl px-4 py-2">
              <Wallet className="h-4 w-4 text-emerald-400" />
              <div className="flex flex-col text-right">
                <span className="text-xs font-mono font-bold text-emerald-400">
                  {bchBalance.toFixed(3)} BCH
                </span>
                <span className="text-[10px] font-mono text-slate-400">
                  ≈ ₱{phpBalance}
                </span>
              </div>
            </div>
          ) : (
            <Button
              onClick={connectMocknetWallet}
              disabled={loading}
              className="rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm py-2.5 px-5 cursor-pointer shadow-lg shadow-emerald-500/10"
            >
              <Bot className="h-4 w-4 mr-2" /> Connect Mocknet Wallet
            </Button>
          )}
        </div>
      </header>

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
                Chipnet Mocknet (Ticket Pass)
              </span>
            </div>
          </div>

          {/* Live Ball-Draw Machine — chamber count/digit range follow the active
              game, and only ever activates on the preset schedule below */}
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

          {/* Mocknet Address & Synchronized Draw Schedule Box */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <QrCode className="h-5 w-5 text-emerald-400" /> Mocknet Wallet &
                Draw Hub
              </span>
              <span className="text-[10px] font-mono text-slate-500 uppercase flex items-center gap-1">
                <Lock className="h-3 w-3" /> Preset · Synchronized
              </span>
            </div>

            {/* Next Scheduled Draw — replaces the old per-user "Run Draw" button.
                The result only fires once, for everyone, at this exact preset time. */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="text-center md:text-left">
                <span className="text-[10px] uppercase font-mono text-slate-400 tracking-wider flex items-center gap-1.5 justify-center md:justify-start">
                  <Clock className="h-3.5 w-3.5 text-emerald-400" /> Next{" "}
                  {activeGame.name} Draw
                </span>
                <div className="text-2xl md:text-3xl font-black font-mono tracking-widest text-emerald-400 mt-1">
                  {drawPending ? "DRAWING…" : formatCountdown(msRemaining)}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-1">
                  Scheduled for {formatSlotTime(nextDrawAt)}
                  {bettingClosed && !drawPending && (
                    <span className="text-rose-400 ml-2">· Betting closed</span>
                  )}
                </div>
              </div>

              <Button
                onClick={handleFastForwardDraw}
                disabled={drawPending}
                variant="outline"
                className="bg-slate-900 border-slate-700 text-amber-300 hover:bg-slate-800 rounded-xl cursor-pointer disabled:opacity-40 text-xs"
              >
                <Zap className="h-3.5 w-3.5 mr-1.5" /> Testing: Fast-Forward
              </Button>
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
                ({contractBchBalance.toFixed(2)} BCH Total Contract Balance
                Locked)
              </div>
            </Card>

            {/* Display Mocknet Address Details */}
            <div className="bg-slate-950/80 p-4 rounded-xl border border-slate-800 space-y-2 font-mono text-xs">
              <div className="text-slate-400 flex items-center justify-between">
                <span>Active Mocknet Address:</span>
                <span className="text-emerald-400 font-bold">
                  {walletConnected ? "Connected" : "Disconnected"}
                </span>
              </div>
              <div className="p-3 bg-slate-900 border border-slate-800 rounded-lg text-emerald-300 break-all select-all flex items-center justify-between">
                <span>
                  {walletConnected
                    ? userBchAddress
                    : "bchtest:qpm20082t9q86pt326402436d8m57q42as2s4r8322 (Default Mock Address)"}
                </span>
                <Button
                  onClick={() =>
                    navigator.clipboard.writeText(
                      walletConnected
                        ? userBchAddress
                        : "bchtest:qpm20082t9q86pt326402436d8m57q42as2s4r8322",
                    )
                  }
                  variant="outline"
                  className="h-7 text-[10px] bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 cursor-pointer ml-2"
                >
                  Copy
                </Button>
              </div>
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
                    Testing-only override: replaces the synchronized result with
                    your own ticket numbers so you can preview the win
                    celebration.
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

                <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800 space-y-1.5">
                  <div className="text-slate-400 flex items-center gap-1 font-bold text-[11px] uppercase tracking-wider text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Entropy Proofs
                    (`resolveDraw`)
                  </div>
                  <div className="text-slate-300 break-all text-[11px]">
                    <span className="text-slate-500">Slot Seed:</span>{" "}
                    {lastSecret}
                  </div>
                </div>
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
              jackpot pool, and re-syncs the countdown to that game's own schedule. */}
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
                          <Clock className="h-2.5 w-2.5" /> Next:{" "}
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
              {!walletConnected ? (
                <Button
                  onClick={connectMocknetWallet}
                  disabled={loading}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-base py-6 rounded-xl shadow-lg shadow-emerald-500/20 cursor-pointer"
                >
                  CONNECT MOCKNET WALLET TO PLAY
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
                    "BETTING CLOSED — DRAW IN PROGRESS"
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
        PCSO Mocknet Decentralized Lottery • Powered by CashScript & Bitcoin
        Cash (BCH)
      </footer>
    </div>
  );
}
