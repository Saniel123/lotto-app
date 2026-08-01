import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

/**
 * LotteryDrawMachine — Vector (SVG) Edition
 * ------------------------------------------
 * Recreates the classic "pyramid" ball-draw machine look used in televised
 * 3-digit lottery broadcasts: a tall tapered glass chamber with numbered
 * balls tumbling at the base, a narrow tube running up the spine, and a
 * capsule at the apex that catches the winning ball. One chamber per digit,
 * all rendered as pure SVG so it's fully vector (crisp at any size, no
 * canvas/raster).
 *
 * Always render this component (don't conditionally mount it) — when
 * `active` is false it shows a resting "standby" state with the balls
 * settled at the base, so the machine is visible from the very start
 * instead of popping in only once a draw begins:
 *
 *   <LotteryDrawMachine
 *     active={drawPending}
 *     pickCount={SWERTRES_GAME.pickCount}
 *     maxDigit={SWERTRES_GAME.maxNumber}
 *     forcedResult={forceWinMode ? purchasedTickets[0]?.numbers : undefined}
 *     onComplete={handleDrawComplete}
 *   />
 */

interface Ball {
  digit: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface LotteryDrawMachineProps {
  active: boolean;
  pickCount?: number;
  maxDigit?: number;
  forcedResult?: number[];
  onComplete: (digits: number[]) => void;
}

// Chamber geometry (shared by every pyramid, in local SVG units)
const W = 180;
const H = 320;
const APEX_Y = 34; // capsule center y
const APEX_R = 17; // capsule radius
const TUBE_TOP_Y = 58;
const TRAP_TOP_Y = 150;
const TRAP_TOP_HALF = 26;
const TRAP_BOT_Y = 284;
const TRAP_BOT_HALF = 78;
const BALL_R = 12;

const MIX_DURATION_MS = 4200;
const SETTLE_DURATION_MS = 1400; // balls slow down before the pick, for suspense
const RISE_DURATION_MS = 1900;
const REVEAL_HOLD_MS = 1600;

type Phase = "idle" | "mixing" | "settling" | "rising" | "revealed" | "done";

const BALL_COLORS = [
  "#34d399",
  "#fbbf24",
  "#60a5fa",
  "#f472b6",
  "#a78bfa",
  "#4ade80",
  "#fb923c",
  "#38bdf8",
  "#f87171",
  "#facc15",
];

function trapBoundsAt(y: number) {
  const t = Math.max(
    0,
    Math.min(1, (y - TRAP_TOP_Y) / (TRAP_BOT_Y - TRAP_TOP_Y)),
  );
  const halfWidth = TRAP_TOP_HALF + t * (TRAP_BOT_HALF - TRAP_TOP_HALF);
  return {
    left: W / 2 - halfWidth + BALL_R,
    right: W / 2 + halfWidth - BALL_R,
  };
}

function spawnBalls(maxDigit: number): Ball[] {
  const balls: Ball[] = [];
  for (let d = 0; d <= maxDigit; d++) {
    const y = TRAP_TOP_Y + 30 + Math.random() * (TRAP_BOT_Y - TRAP_TOP_Y - 50);
    const { left, right } = trapBoundsAt(y);
    balls.push({
      digit: d,
      x: left + Math.random() * (right - left),
      y,
      vx: (Math.random() - 0.5) * 3.2,
      vy: (Math.random() - 0.5) * 3.2,
    });
  }
  return balls;
}

// Balls settled in a neat resting pile near the base — the "standby" look before a draw starts
function restingBalls(maxDigit: number): Ball[] {
  const count = maxDigit + 1;
  const perRow = Math.ceil(count / 2);
  const spacing = BALL_R * 2 + 3;
  const rowY = [TRAP_BOT_Y - 46, TRAP_BOT_Y - 20];
  const balls: Ball[] = [];
  for (let d = 0; d <= maxDigit; d++) {
    const row = d < perRow ? 0 : 1;
    const col = d < perRow ? d : d - perRow;
    const rowCount = row === 0 ? perRow : count - perRow;
    const rowWidth = (rowCount - 1) * spacing;
    balls.push({
      digit: d,
      x: W / 2 - rowWidth / 2 + col * spacing,
      y: rowY[row],
      vx: 0,
      vy: 0,
    });
  }
  return balls;
}

function PyramidChamber({
  balls,
  phase,
  winnerDigit,
  riseProgress,
  label,
}: {
  balls: Ball[];
  phase: Phase;
  winnerDigit: number | null;
  riseProgress: number;
  label: string;
}) {
  const capsuleFilled =
    (phase === "rising" && riseProgress > 0.9) ||
    phase === "revealed" ||
    phase === "done";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="max-w-[150px]">
      <defs>
        <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0f172a" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#0f172a" stopOpacity="0.55" />
        </linearGradient>
      </defs>

      {/* Tripod legs */}
      <line
        x1={W / 2 - TRAP_BOT_HALF + 6}
        y1={TRAP_BOT_Y}
        x2={W / 2 - 46}
        y2={H - 8}
        stroke="#1e293b"
        strokeWidth="4"
      />
      <line
        x1={W / 2 + TRAP_BOT_HALF - 6}
        y1={TRAP_BOT_Y}
        x2={W / 2 + 46}
        y2={H - 8}
        stroke="#1e293b"
        strokeWidth="4"
      />
      <line
        x1={W / 2}
        y1={TRAP_BOT_Y + 4}
        x2={W / 2}
        y2={H - 8}
        stroke="#1e293b"
        strokeWidth="4"
      />
      <line
        x1={W / 2 - 46}
        y1={H - 8}
        x2={W / 2 + 46}
        y2={H - 8}
        stroke="#334155"
        strokeWidth="5"
        strokeLinecap="round"
      />

      {/* Trapezoid chamber body */}
      <polygon
        points={`${W / 2 - TRAP_TOP_HALF},${TRAP_TOP_Y} ${W / 2 + TRAP_TOP_HALF},${TRAP_TOP_Y} ${W / 2 + TRAP_BOT_HALF},${TRAP_BOT_Y} ${W / 2 - TRAP_BOT_HALF},${TRAP_BOT_Y}`}
        fill="url(#glass)"
        stroke="#34d399"
        strokeOpacity="0.45"
        strokeWidth="2"
      />
      {/* Lattice cross-bracing for the "glass frame" look */}
      <line
        x1={W / 2 - TRAP_TOP_HALF}
        y1={TRAP_TOP_Y}
        x2={W / 2 - TRAP_BOT_HALF}
        y2={TRAP_BOT_Y}
        stroke="#334155"
        strokeWidth="1.5"
      />
      <line
        x1={W / 2 + TRAP_TOP_HALF}
        y1={TRAP_TOP_Y}
        x2={W / 2 + TRAP_BOT_HALF}
        y2={TRAP_BOT_Y}
        stroke="#334155"
        strokeWidth="1.5"
      />
      {[0.33, 0.66].map((f, i) => {
        const y = TRAP_TOP_Y + f * (TRAP_BOT_Y - TRAP_TOP_Y);
        const { left, right } = trapBoundsAt(y);
        return (
          <line
            key={i}
            x1={left - BALL_R}
            y1={y}
            x2={right + BALL_R}
            y2={y}
            stroke="#334155"
            strokeOpacity="0.4"
            strokeWidth="1"
          />
        );
      })}

      {/* Tube from chamber up to capsule */}
      <line
        x1={W / 2}
        y1={TRAP_TOP_Y}
        x2={W / 2}
        y2={TUBE_TOP_Y}
        stroke="#34d399"
        strokeOpacity="0.45"
        strokeWidth="10"
        strokeLinecap="round"
        fill="none"
      />
      <line
        x1={W / 2}
        y1={TRAP_TOP_Y}
        x2={W / 2}
        y2={TUBE_TOP_Y}
        stroke="#0f172a"
        strokeOpacity="0.5"
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
      />

      {/* Capsule at apex */}
      <circle
        cx={W / 2}
        cy={APEX_Y}
        r={APEX_R}
        fill={capsuleFilled ? "#0f172a" : "rgba(15,23,42,0.4)"}
        stroke={capsuleFilled ? "#fbbf24" : "#334155"}
        strokeWidth={capsuleFilled ? 2.5 : 1.5}
        style={{
          filter: capsuleFilled
            ? "drop-shadow(0 0 6px rgba(251,191,36,0.65))"
            : "none",
        }}
      />

      {/* Winner ball rising through the tube */}
      {phase === "rising" && winnerDigit !== null && (
        <BallGlyph
          x={W / 2}
          y={TRAP_TOP_Y - riseProgress * (TRAP_TOP_Y - APEX_Y)}
          digit={winnerDigit}
          glow
        />
      )}

      {/* Resting winner ball inside capsule */}
      {capsuleFilled && winnerDigit !== null && (
        <BallGlyph x={W / 2} y={APEX_Y} digit={winnerDigit} glow />
      )}

      {/* Tumbling / resting balls in the chamber */}
      {(phase === "idle" ||
        phase === "mixing" ||
        phase === "settling" ||
        (phase === "rising" && riseProgress < 1)) &&
        balls
          .filter((b) => !(phase === "rising" && b.digit === winnerDigit))
          .map((b, i) => (
            <BallGlyph
              key={b.digit}
              x={b.x}
              y={b.y}
              digit={b.digit}
              idleDelay={phase === "idle" ? i * 0.18 : undefined}
            />
          ))}

      {/* Label plate */}
      <rect
        x={W / 2 - 34}
        y={H - 26}
        width="68"
        height="20"
        rx="6"
        fill="#0f172a"
        stroke="#334155"
        strokeWidth="1"
      />
      <text
        x={W / 2}
        y={H - 12}
        textAnchor="middle"
        fontSize="10"
        fontFamily="monospace"
        fill="#94a3b8"
        fontWeight="bold"
      >
        {label}
      </text>
    </svg>
  );
}

function BallGlyph({
  x,
  y,
  digit,
  glow,
  idleDelay,
}: {
  x: number;
  y: number;
  digit: number;
  glow?: boolean;
  idleDelay?: number;
}) {
  const color = BALL_COLORS[digit % BALL_COLORS.length];
  return (
    <g
      style={
        glow
          ? { filter: "drop-shadow(0 0 5px rgba(251,191,36,0.7))" }
          : undefined
      }
      transform={`translate(${x} ${y})`}
    >
      {idleDelay !== undefined && (
        <animateTransform
          attributeName="transform"
          type="translate"
          additive="sum"
          values="0 0; 0 -3; 0 0"
          dur="2.6s"
          begin={`${idleDelay}s`}
          repeatCount="indefinite"
        />
      )}
      <circle
        r={BALL_R}
        fill={color}
        stroke={glow ? "#fde68a" : "#0f172a"}
        strokeWidth={glow ? 2 : 1}
      />
      <circle
        cx={-3.5}
        cy={-3.5}
        r={BALL_R * 0.35}
        fill="#ffffff"
        opacity="0.55"
      />
      <text
        x={0}
        y={3.5}
        textAnchor="middle"
        fontSize="11"
        fontFamily="monospace"
        fontWeight="bold"
        fill="#0f172a"
      >
        {digit}
      </text>
    </g>
  );
}

export default function LotteryDrawMachine({
  active,
  pickCount = 3,
  maxDigit = 9,
  forcedResult,
  onComplete,
}: LotteryDrawMachineProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [ballSets, setBallSets] = useState<Ball[][]>([]);
  const [winners, setWinners] = useState<(number | null)[]>([]);
  const [riseProgress, setRiseProgress] = useState(0);

  const ballSetsRef = useRef<Ball[][]>([]);
  const winnersRef = useRef<(number | null)[]>([]);
  const phaseRef = useRef<Phase>("idle");
  const rafRef = useRef<number | null>(null);
  const riseStartRef = useRef(0);

  const idleBalls = useRef<Ball[]>(restingBalls(maxDigit)).current;

  useEffect(() => {
    if (!active) {
      phaseRef.current = "idle";
      setPhase("idle");
      return;
    }

    const fresh = Array.from({ length: pickCount }, () => spawnBalls(maxDigit));
    ballSetsRef.current = fresh;
    setBallSets(fresh);
    winnersRef.current = Array.from({ length: pickCount }, () => null);
    setWinners(winnersRef.current);
    phaseRef.current = "mixing";
    setPhase("mixing");

    const toSettle = window.setTimeout(() => {
      phaseRef.current = "settling";
      setPhase("settling");
    }, MIX_DURATION_MS);

    const toRise = window.setTimeout(() => {
      const chosen = Array.from({ length: pickCount }, (_, i) =>
        forcedResult?.[i] !== undefined
          ? forcedResult[i]
          : Math.floor(Math.random() * (maxDigit + 1)),
      );
      winnersRef.current = chosen;
      setWinners(chosen);
      phaseRef.current = "rising";
      setPhase("rising");
      riseStartRef.current = performance.now();
    }, MIX_DURATION_MS + SETTLE_DURATION_MS);

    return () => {
      window.clearTimeout(toSettle);
      window.clearTimeout(toRise);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Physics loop (mixing) + rise progress loop
  useEffect(() => {
    if (!active) return;

    const tick = () => {
      if (phaseRef.current === "mixing" || phaseRef.current === "settling") {
        const sets = ballSetsRef.current;
        // during settling, damp velocity every frame so the tumble visibly slows to a near-stop
        const damping = phaseRef.current === "settling" ? 0.965 : 1;
        for (const balls of sets) {
          for (const b of balls) {
            b.vx *= damping;
            b.vy *= damping;
            b.x += b.vx;
            b.y += b.vy;
            const { left, right } = trapBoundsAt(b.y);
            if (b.x < left) {
              b.x = left;
              b.vx *= -1;
            }
            if (b.x > right) {
              b.x = right;
              b.vx *= -1;
            }
            if (b.y < TRAP_TOP_Y + BALL_R) {
              b.y = TRAP_TOP_Y + BALL_R;
              b.vy *= -1;
            }
            if (b.y > TRAP_BOT_Y - BALL_R) {
              b.y = TRAP_BOT_Y - BALL_R;
              b.vy *= -1;
            }
          }
        }
        setBallSets(sets.map((s) => s.map((b) => ({ ...b }))));
      } else if (phaseRef.current === "rising") {
        const elapsed = performance.now() - riseStartRef.current;
        const linearT = Math.min(1, elapsed / RISE_DURATION_MS);
        // ease-out: climbs slowly at first, then snaps up into the capsule for a dramatic finish
        const t = 1 - Math.pow(1 - linearT, 3);
        setRiseProgress(t);
        if (linearT >= 1) {
          phaseRef.current = "revealed";
          setPhase("revealed");
          window.setTimeout(() => {
            phaseRef.current = "done";
            setPhase("done");
            onComplete(winnersRef.current as number[]);
          }, REVEAL_HOLD_MS);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const phaseLabel: Record<Phase, string> = {
    idle: "Draw machine ready",
    mixing: "Mixing balls…",
    settling: "Settling down… here it comes!",
    rising: "Drawing winning balls…",
    revealed: "Draw complete!",
    done: "Draw complete!",
  };

  const displayPhase = active ? phase : "idle";
  const displayWinners = active
    ? winners
    : Array.from({ length: pickCount }, () => null);

  return (
    <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-center gap-2 text-xs font-mono text-amber-300 uppercase tracking-wider">
        <Sparkles className="h-3.5 w-3.5" />
        {phaseLabel[displayPhase]}
      </div>

      <div className="flex justify-center gap-1">
        {Array.from({ length: pickCount }).map((_, i) => (
          <PyramidChamber
            key={i}
            balls={active ? (ballSets[i] ?? []) : idleBalls}
            phase={displayPhase}
            winnerDigit={displayWinners[i] ?? null}
            riseProgress={riseProgress}
            label={`DIGIT ${i + 1}`}
          />
        ))}
      </div>

      {(displayPhase === "revealed" || displayPhase === "done") && (
        <div className="flex justify-center">
          <div className="flex items-center gap-2 bg-gradient-to-r from-amber-500 via-amber-400 to-yellow-400 text-slate-950 font-black rounded-xl px-5 py-2 shadow-lg shadow-amber-500/20">
            <span className="text-xs uppercase tracking-widest font-mono">
              Result
            </span>
            <span className="text-xl font-mono tracking-widest">
              {displayWinners.map((w) => w ?? "?").join(" - ")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
