/**
 * Arena runner: N strategy agents compete for revenue inside ONE shared
 * protocol model. Each agent owns its own tranches (protocol positions) and
 * proposes on its own (cadenceSec, phaseSec) grid; revenue is split pro-rata
 * by weight by the model itself, so one agent's capture is the others'
 * dilution. The optional crowd model plays the ambient market.
 *
 * Fairness contract (simultaneous moves): all agents due at the same instant
 * propose against ONE frozen market snapshot taken before any of them
 * rotates, so no agent sees a same-instant competitor's move. Execution then
 * applies in agents-array order — economically neutral, because weights are
 * piecewise constant and every rotation lands before the next `advance`, so
 * revenue over [t, t+step) is split by post-rotation weights regardless of
 * submission order. The fixed order exists only to make blocked-submission
 * accounting deterministic.
 *
 * The neutrality argument assumes PER-POSITION cooldown gating. Under a
 * model with GLOBAL cooldown granularity the first successful rotation at a
 * tick starts the shared cooldown and locks every later agent out
 * (AllocationBlockedError), making roster order economically decisive.
 * Arena models must therefore use per-position cooldowns; the web builder
 * enforces this (buildArena forces cooldownGranularity: "position").
 *
 * Determinism: fixed agent order + frozen snapshots + seeded strategy
 * closures + integer-only accounting make `runArena` a pure function of its
 * inputs; two runs from freshly constructed models and strategies are
 * bigint-identical.
 */

import { divWad, mulDiv, WAD } from "../math/fixed.js";
import { WEEK } from "../model/types.js";
import type { CrowdModel } from "../model/crowd.js";
import {
  AllocationBlockedError,
  type MarketState,
  type ModelTotals,
  type PoolId,
  type ProtocolModel,
  type TargetAllocation,
  type Wad,
} from "../model/types.js";
import { DEFAULT_COOLDOWN_SEC } from "../model/continuous.js";
import {
  applyRotation,
  l1Distance,
  plan,
  type TrancheState,
} from "../scheduler/scheduler.js";
import type { Portfolio, Strategy } from "../strategies/types.js";

/** One competitor: a strategy instance driving its own positions. */
export interface ArenaAgentSpec {
  /** Stable unique id; position ids are `${id}/tranche-NN`. */
  id: string;
  /** Display label; defaults to the strategy's name. */
  label?: string;
  strategy: Strategy;
  /** Number of tranches (1:1 with model positions). */
  trancheCount: number;
  /** Staking weight per tranche. */
  trancheWeight: Wad;
}

/** Arena configuration. */
export interface ArenaConfig {
  /** Simulation start (unix seconds). Must match the model's startTime. */
  startTime: number;
  /** Total simulated duration in seconds; a multiple of stepSec. */
  durationSec: number;
  /** Simulation step in seconds. */
  stepSec: number;
  /** Competitors. Array order is the deterministic execution order. */
  agents: readonly ArenaAgentSpec[];
  /**
   * Cooldown the schedulers plan around, seconds; ONE value for everyone
   * (the continuous model gates all positions with a single model-level
   * cooldown, so per-agent cooldowns are not expressible). Default 172800.
   */
  cooldownSec?: number;
  /** Equity/allocation sampling interval, seconds. Default stepSec. */
  sampleIntervalSec?: number;
  /** Optional crowd model driving external weights. */
  crowd?: CrowdModel;
  /** How often crowd weights refresh, seconds. Default stepSec. */
  crowdUpdateSec?: number;
  /** Compute the shared foresight (oracle) benchmark series. Default true. */
  includeOracle?: boolean;
}

/** Per-agent arena outcome. */
export interface ArenaAgentResult {
  id: string;
  label: string;
  strategyName: string;
  /** Total staking weight (trancheWeight × trancheCount). */
  weight: Wad;
  /** Raw revenue accrued across the agent's tranches, Wad. */
  earnedTotal: Wad;
  /** Cumulative revenue per unit weight, Wad (earnedTotal / weight). */
  totalReturn: Wad;
  /** totalReturn − marketBenchmarkReturn (signed): the arena score. */
  returnVsMarket: bigint;
  /** Σ L1(Δallocation)/2 per executed rotation, Wad fractions, cumulated. */
  turnover: Wad;
  /** Number of executed rotations. */
  rotations: number;
  /** Rotations refused by the model (cooldown/epoch gates). */
  blockedSubmissions: number;
  /** Equity per unit weight at each sample, aligned with ArenaResult.times. */
  equity: Wad[];
  /** allocationWeights[sample][poolIdx]: the agent's Wad portfolio fraction. */
  allocationWeights: Wad[][];
}

/** Arena outcome: shared series + per-agent results. */
export interface ArenaResult {
  times: number[];
  pools: PoolId[];
  /** In input order; sort by returnVsMarket for a leaderboard. */
  agents: ArenaAgentResult[];
  /** Market benchmark per unit weight at each sample (shared: revenue per
   *  unit of GLOBAL weight, agents + crowd alike). */
  marketBenchmark: Wad[];
  marketBenchmarkReturn: Wad;
  /**
   * Foresight benchmark per unit weight (cheap, NON-displacing variant): an
   * infinitesimal portfolio holding each weekly epoch's pools in proportion
   * to that epoch's realized revenue, earning delta·share/poolWeight per
   * step without adding its own weight to the denominator. Slightly
   * optimistic versus the displacing single-run oracle. Pools that carried
   * no weight at any step of an epoch are excluded from that epoch's
   * revenue shares entirely — their revenue reaches nobody and must not
   * dilute the held pools' shares; zero-weight steps of an otherwise-held
   * pool are skipped.
   */
  oracleBenchmark?: Wad[];
  oracleReturn?: Wad;
  /** Model conservation counters at the end of the run. */
  totals: ModelTotals;
}

interface AgentRun {
  spec: ArenaAgentSpec;
  weight: Wad;
  tranches: TrancheState[];
  turnover: Wad;
  rotations: number;
  blockedSubmissions: number;
  equity: Wad[];
  allocationWeights: Wad[][];
}

/** Materializes the weight view of a live MarketState at one instant. */
function freezeMarketState(live: MarketState): MarketState {
  const poolWeights = new Map<PoolId, Wad>();
  for (const pool of live.pools) poolWeights.set(pool, live.poolWeight(pool));
  const total = live.totalWeight();
  return {
    now: live.now,
    pools: live.pools,
    // Pure function of the revenue process and `now`; safe to delegate.
    trailingRevenue: (pool, windowSec) => live.trailingRevenue(pool, windowSec),
    poolWeight: (pool) => poolWeights.get(pool) ?? 0n,
    totalWeight: () => total,
  };
}

/**
 * Runs the agents against `model`. The model must be freshly constructed at
 * `config.startTime` with no positions registered; the runner creates one
 * position per tranche per agent. Every agent fires once at startTime
 * (bootstrap) and then on its strategy's (cadenceSec, phaseSec) grid.
 */
export function runArena(model: ProtocolModel, config: ArenaConfig): ArenaResult {
  const { startTime, durationSec, stepSec } = config;
  if (stepSec <= 0 || !Number.isInteger(stepSec)) {
    throw new Error("stepSec must be a positive integer");
  }
  if (durationSec % stepSec !== 0) throw new Error("durationSec must be a multiple of stepSec");
  if (config.agents.length === 0) throw new Error("arena needs at least one agent");
  const cooldownSec = config.cooldownSec ?? DEFAULT_COOLDOWN_SEC;
  const sampleIntervalSec = config.sampleIntervalSec ?? stepSec;
  const crowdUpdateSec = config.crowdUpdateSec ?? stepSec;
  const includeOracle = config.includeOracle ?? true;

  const seen = new Set<string>();
  const agents: AgentRun[] = config.agents.map((spec) => {
    if (seen.has(spec.id)) throw new Error(`duplicate agent id ${spec.id}`);
    seen.add(spec.id);
    if (!Number.isInteger(spec.trancheCount) || spec.trancheCount < 1) {
      throw new Error(`agent ${spec.id}: trancheCount must be a positive integer`);
    }
    if (spec.trancheWeight <= 0n) throw new Error(`agent ${spec.id}: trancheWeight must be positive`);
    const tranches: TrancheState[] = [];
    for (let i = 0; i < spec.trancheCount; i += 1) {
      const id = `${spec.id}/tranche-${String(i).padStart(2, "0")}`;
      tranches.push({
        id,
        positionWeight: spec.trancheWeight,
        lastActionAt: startTime - cooldownSec,
        allocation: new Map(),
      });
      model.addPosition(id, spec.trancheWeight);
    }
    return {
      spec,
      weight: spec.trancheWeight * BigInt(spec.trancheCount),
      tranches,
      turnover: 0n,
      rotations: 0,
      blockedSubmissions: 0,
      equity: [],
      allocationWeights: [],
    };
  });

  const portfolioOf = (agent: AgentRun): Portfolio => ({
    tranches: agent.tranches,
    totalWeight: agent.weight,
    cooldownSec,
  });

  const strategyDue = (strategy: Strategy, t: number): boolean =>
    ((t - strategy.phaseSec) % strategy.cadenceSec + strategy.cadenceSec) %
      strategy.cadenceSec === 0;

  const executeTarget = (agent: AgentRun, target: TargetAllocation, t: number): void => {
    const actions = plan(agent.tranches, target, t, cooldownSec);
    for (const action of actions) {
      if (action.kind !== "rotate") continue;
      const idx = agent.tranches.findIndex((tr) => tr.id === action.trancheId);
      const tranche = agent.tranches[idx]!;
      try {
        model.submitAllocation(tranche.id, action.allocation);
      } catch (err) {
        if (err instanceof AllocationBlockedError) {
          agent.blockedSubmissions += 1;
          continue;
        }
        throw err;
      }
      agent.turnover += l1Distance(tranche.allocation, action.allocation) / 2n;
      agent.rotations += 1;
      agent.tranches = agent.tranches.with(idx, applyRotation(tranche, action.allocation, t));
    }
  };

  const allocPools = [...model.marketState().pools];
  const times: number[] = [];
  const marketSeries: Wad[] = [];
  let marketBenchmark = 0n;
  let prevRevByPool: ReadonlyMap<string, Wad> = new Map();

  // -- cheap foresight (oracle) benchmark ------------------------------------
  // Shares fix per weekly epoch (knowable only at the flip); steps buffer
  // their (revenue delta, pool weight at step start) pairs and samples taken
  // inside an open epoch are back-filled when it closes.
  let oracleCum = 0n;
  const oracleSeries: Wad[] = [];
  let epochStepDeltas: Wad[][] = [];
  let epochStepWeights: Wad[][] = [];
  let epochRevenue: Wad[] = allocPools.map(() => 0n);
  let epochHadWeight: boolean[] = allocPools.map(() => false);
  let pendingOracleSamples: { row: number; steps: number }[] = [];

  const closeOracleEpoch = (): void => {
    // Never-weighted pools are excluded from the epoch's shares: their
    // revenue reaches nobody, so counting it in the denominator would
    // dilute the held pools and understate the foresight line.
    let totalRev = 0n;
    for (let p = 0; p < allocPools.length; p += 1) {
      if (epochHadWeight[p]) totalRev += epochRevenue[p]!;
    }
    const shares = allocPools.map((_, p) =>
      totalRev === 0n || !epochHadWeight[p] ? 0n : mulDiv(WAD, epochRevenue[p]!, totalRev),
    );
    let pi = 0;
    while (pi < pendingOracleSamples.length && pendingOracleSamples[pi]!.steps === 0) {
      oracleSeries[pendingOracleSamples[pi]!.row] = oracleCum;
      pi += 1;
    }
    for (let s = 0; s < epochStepDeltas.length; s += 1) {
      const deltas = epochStepDeltas[s]!;
      const weights = epochStepWeights[s]!;
      for (let p = 0; p < allocPools.length; p += 1) {
        const delta = deltas[p]!;
        const share = shares[p]!;
        const w = weights[p]!;
        if (delta <= 0n || share === 0n || w === 0n) continue;
        oracleCum += mulDiv(delta, share, w);
      }
      while (pi < pendingOracleSamples.length && pendingOracleSamples[pi]!.steps === s + 1) {
        oracleSeries[pendingOracleSamples[pi]!.row] = oracleCum;
        pi += 1;
      }
    }
    epochStepDeltas = [];
    epochStepWeights = [];
    epochRevenue = allocPools.map(() => 0n);
    epochHadWeight = allocPools.map(() => false);
    pendingOracleSamples = [];
  };

  const sample = (t: number): void => {
    times.push(t);
    marketSeries.push(marketBenchmark);
    for (const agent of agents) {
      let earned = 0n;
      for (const tranche of agent.tranches) earned += model.earned(tranche.id);
      agent.equity.push(divWad(earned, agent.weight));
      agent.allocationWeights.push(
        allocPools.map((pool) => {
          let onPool = 0n;
          for (const tranche of agent.tranches) {
            const frac = tranche.allocation.get(pool) ?? 0n;
            if (frac > 0n) onPool += mulDiv(tranche.positionWeight, frac, WAD);
          }
          return divWad(onPool, agent.weight);
        }),
      );
    }
    if (includeOracle) {
      oracleSeries.push(0n); // back-filled at epoch close
      pendingOracleSamples.push({ row: oracleSeries.length - 1, steps: epochStepDeltas.length });
    }
  };

  const end = startTime + durationSec;
  for (let t = startTime; t < end; t += stepSec) {
    if (config.crowd && (t - startTime) % crowdUpdateSec === 0) {
      model.setCrowdWeights(config.crowd.weightsAt(t));
    }
    const due = agents.filter(
      (agent) => t === startTime || strategyDue(agent.spec.strategy, t),
    );
    if (due.length > 0) {
      const frozen = freezeMarketState(model.marketState());
      const proposals = due.map((agent) => ({
        agent,
        target: agent.spec.strategy.propose(frozen, portfolioOf(agent)),
      }));
      for (const { agent, target } of proposals) executeTarget(agent, target, t);
    }
    const marketBefore = model.marketState();
    const globalWeight = marketBefore.totalWeight();
    const poolWeightsBefore = allocPools.map((pool) => marketBefore.poolWeight(pool));
    model.advance(stepSec);
    const revByPool = model.revenueByPool();
    const deltas = allocPools.map(
      (pool) => (revByPool.get(pool) ?? 0n) - (prevRevByPool.get(pool) ?? 0n),
    );
    prevRevByPool = revByPool;
    let deltaRev = 0n;
    for (const delta of deltas) deltaRev += delta;
    if (globalWeight > 0n) marketBenchmark += divWad(deltaRev, globalWeight);
    if (includeOracle) {
      epochStepDeltas.push(deltas);
      epochStepWeights.push(poolWeightsBefore);
      for (let p = 0; p < allocPools.length; p += 1) {
        epochRevenue[p] = epochRevenue[p]! + deltas[p]!;
        if (poolWeightsBefore[p]! > 0n) epochHadWeight[p] = true;
      }
      if (Math.floor((t + stepSec) / WEEK) > Math.floor(t / WEEK)) closeOracleEpoch();
    }
    if ((t + stepSec - startTime) % sampleIntervalSec === 0) sample(t + stepSec);
  }
  // The sampling grid need not land on the run end (sampleIntervalSec is a
  // multiple of stepSec, not necessarily a divisor of durationSec); force a
  // final sample so the series end where the scalar returns are measured.
  if (times.length === 0 || times[times.length - 1] !== end) sample(end);
  if (includeOracle) closeOracleEpoch(); // partial final epoch

  return {
    times,
    pools: allocPools,
    agents: agents.map((agent) => {
      let earnedTotal = 0n;
      for (const tranche of agent.tranches) earnedTotal += model.earned(tranche.id);
      const totalReturn = divWad(earnedTotal, agent.weight);
      return {
        id: agent.spec.id,
        label: agent.spec.label ?? agent.spec.strategy.name,
        strategyName: agent.spec.strategy.name,
        weight: agent.weight,
        earnedTotal,
        totalReturn,
        returnVsMarket: totalReturn - marketBenchmark,
        turnover: agent.turnover,
        rotations: agent.rotations,
        blockedSubmissions: agent.blockedSubmissions,
        equity: agent.equity,
        allocationWeights: agent.allocationWeights,
      };
    }),
    marketBenchmark: marketSeries,
    marketBenchmarkReturn: marketBenchmark,
    ...(includeOracle ? { oracleBenchmark: oracleSeries, oracleReturn: oracleCum } : {}),
    totals: model.totals(),
  };
}
