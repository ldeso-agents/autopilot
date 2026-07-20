/**
 * Explicit worker-boundary serialization. BacktestResult carries bigints
 * (Wads), which structured clone supports but our chart layer wants plain
 * floats, so the worker sends a display-ready shape and nothing downstream
 * touches bigint again. Conversion Wad → float is analytics-only (P2 allows
 * floats outside fixture paths).
 */
import type { BuiltRun } from "./buildRun.js";
import type { BuiltArena } from "./buildArena.js";

export interface DisplayResult {
  totalReturn: number;
  marketBenchmarkReturn: number;
  /** Foresight (revenue-proportional) benchmark return, the ceiling reference. */
  revenueBenchmarkReturn: number;
  returnVsMarket: number;
  maxDrawdownVsMarket: number;
  turnover: number;
  rotations: number;
  blockedSubmissions: number;
  onTargetPct: number;
  offTargetPct: number;
  poolSamples: number;
  equity: { times: number[]; equity: number[]; marketBenchmark: number[]; revenueBenchmark: number[] };
  allocation: {
    times: number[];
    pools: string[];
    poolNames: string[];
    weights: number[][];
    /** Cumulative revenue earned from each pool (raw units, not per weight). */
    earned: number[][];
    /** Pool share of GLOBAL weight, the market benchmark's holdings. */
    marketBenchmarkWeights: number[][];
    /** Cumulative revenue the market benchmark portfolio of our size earned. */
    marketBenchmarkEarned: number[][];
    /** The foresight benchmark's holdings: each epoch's revenue shares. */
    revenueBenchmarkWeights: number[][];
    /** Cumulative revenue the foresight benchmark earned per pool. */
    revenueBenchmarkEarned: number[][];
  };
  datasetGeneratedAt: string | undefined;
  /** Historical timestamps are real dates; synthetic ones are an arbitrary anchor. */
  dataKind: "historical" | "synthetic";
  /** "usd" when revenue is Alchemy-priced USD; "index" for synthetic units. */
  revenueUnit: "usd" | "index";
  startTime: number;
  durationSec: number;
}

const WAD = 1e18;

export function toDisplayResult(run: BuiltRun): DisplayResult {
  const { result } = run;
  return {
    totalReturn: Number(result.totalReturn) / WAD,
    marketBenchmarkReturn: Number(result.marketBenchmarkReturn) / WAD,
    revenueBenchmarkReturn: Number(result.revenueBenchmarkReturn) / WAD,
    returnVsMarket: Number(result.returnVsMarket) / WAD,
    maxDrawdownVsMarket: Number(result.maxDrawdownVsMarket) / WAD,
    turnover: Number(result.turnover) / WAD,
    rotations: result.rotations,
    blockedSubmissions: result.blockedSubmissions,
    onTargetPct: result.onTargetPct,
    offTargetPct: result.offTargetPct,
    poolSamples: result.poolSamples,
    equity: {
      times: result.equityCurve.times,
      equity: result.equityCurve.equity.map((w) => Number(w) / WAD),
      marketBenchmark: result.equityCurve.marketBenchmark.map((w) => Number(w) / WAD),
      revenueBenchmark: result.equityCurve.revenueBenchmark.map((w) => Number(w) / WAD),
    },
    allocation: {
      times: result.allocationHistory.times,
      pools: result.allocationHistory.pools,
      poolNames: result.allocationHistory.pools.map((p) => run.poolNames.get(p) ?? p),
      weights: result.allocationHistory.weights.map((row) => row.map((w) => Number(w) / WAD)),
      earned: result.allocationHistory.earned.map((row) => row.map((w) => Number(w) / WAD)),
      marketBenchmarkWeights: result.allocationHistory.marketBenchmarkWeights.map((row) =>
        row.map((w) => Number(w) / WAD),
      ),
      marketBenchmarkEarned: result.allocationHistory.marketBenchmarkEarned.map((row) =>
        row.map((w) => Number(w) / WAD),
      ),
      revenueBenchmarkWeights: result.allocationHistory.revenueBenchmarkWeights.map((row) =>
        row.map((w) => Number(w) / WAD),
      ),
      revenueBenchmarkEarned: result.allocationHistory.revenueBenchmarkEarned.map((row) =>
        row.map((w) => Number(w) / WAD),
      ),
    },
    datasetGeneratedAt: run.datasetGeneratedAt,
    dataKind: run.dataKind,
    revenueUnit: run.revenueUnit,
    startTime: run.startTime,
    durationSec: run.durationSec,
  };
}

// ---------------------------------------------------------------------------
// Arena display shape (same Wad → float boundary rule)
// ---------------------------------------------------------------------------

export interface DisplayArenaAgent {
  id: string;
  label: string;
  strategyName: string;
  /** The agent's share of total AGENT weight (not counting the crowd). */
  weightShare: number;
  totalReturn: number;
  returnVsMarket: number;
  /** (agent − market) / (oracle − market); null when the oracle is absent
   *  or does not beat the market (the ratio would be meaningless). */
  capture: number | null;
  turnover: number;
  rotations: number;
  blockedSubmissions: number;
  equity: number[];
  /** allocationWeights[sample][poolIdx]: the agent's portfolio fraction. */
  allocationWeights: number[][];
}

export interface DisplayArenaResult {
  times: number[];
  pools: string[];
  poolNames: string[];
  marketBenchmark: number[];
  marketBenchmarkReturn: number;
  oracleBenchmark: number[] | null;
  oracleReturn: number | null;
  agents: DisplayArenaAgent[];
  datasetGeneratedAt: string | undefined;
  dataKind: "historical" | "synthetic";
  revenueUnit: "usd" | "index";
  startTime: number;
  durationSec: number;
}

export function toDisplayArenaResult(run: BuiltArena): DisplayArenaResult {
  const { result } = run;
  let totalAgentWeight = 0n;
  for (const agent of result.agents) totalAgentWeight += agent.weight;
  const market = Number(result.marketBenchmarkReturn) / WAD;
  const oracle = result.oracleReturn === undefined ? null : Number(result.oracleReturn) / WAD;
  return {
    times: result.times,
    pools: result.pools,
    poolNames: result.pools.map((p) => run.poolNames.get(p) ?? p),
    marketBenchmark: result.marketBenchmark.map((w) => Number(w) / WAD),
    marketBenchmarkReturn: market,
    oracleBenchmark: result.oracleBenchmark?.map((w) => Number(w) / WAD) ?? null,
    oracleReturn: oracle,
    agents: result.agents.map((agent) => {
      const totalReturn = Number(agent.totalReturn) / WAD;
      return {
        id: agent.id,
        label: agent.label,
        strategyName: agent.strategyName,
        weightShare: totalAgentWeight === 0n ? 0 : Number(agent.weight) / Number(totalAgentWeight),
        totalReturn,
        returnVsMarket: Number(agent.returnVsMarket) / WAD,
        capture: oracle !== null && oracle > market ? (totalReturn - market) / (oracle - market) : null,
        turnover: Number(agent.turnover) / WAD,
        rotations: agent.rotations,
        blockedSubmissions: agent.blockedSubmissions,
        equity: agent.equity.map((w) => Number(w) / WAD),
        allocationWeights: agent.allocationWeights.map((row) => row.map((w) => Number(w) / WAD)),
      };
    }),
    datasetGeneratedAt: run.datasetGeneratedAt,
    dataKind: run.dataKind,
    revenueUnit: run.revenueUnit,
    startTime: run.startTime,
    durationSec: run.durationSec,
  };
}

export type WorkerRequest =
  | { type: "run"; seq: number; config: unknown; historical: unknown | null }
  | { type: "arena"; seq: number; config: unknown; historical: unknown | null };
export type WorkerResponse =
  | { type: "done"; seq: number; result: DisplayResult; elapsedMs: number }
  | { type: "arenaDone"; seq: number; result: DisplayArenaResult; elapsedMs: number }
  | { type: "error"; seq: number; request: "run" | "arena"; message: string };
