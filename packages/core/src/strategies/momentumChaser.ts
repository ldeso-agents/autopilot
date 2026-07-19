/**
 * MomentumChaser, the intentionally bad herder: it allocates proportionally
 * to pool-weight INFLOW since its previous look — i.e. it chases where other
 * allocators' money just went, arriving exactly one cadence late by
 * construction. On the first call (or when no pool gained weight) it follows
 * the standing crowd instead; an all-zero market normalizes to uniform.
 * In an arena it demonstrates the cost of trading on a lagged, reflexive
 * signal: it buys the crowding, not the revenue.
 */

import { DAY } from "../model/types.js";
import type { MarketState, PoolId, TargetAllocation, Wad } from "../model/types.js";
import { normalizeToWad } from "./normalize.js";
import type { ConfigSchema, Portfolio, Strategy } from "./types.js";

/** Configuration for MomentumChaser. */
export interface MomentumChaserConfig {
  /** Invocation cadence in seconds (equal to the signal lag). Default 1 day. */
  cadenceSec?: number;
}

/** Default MomentumChaser config values. */
export const momentumChaserDefaults = { cadenceSec: DAY } as const;

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    cadenceSec: {
      type: "integer",
      description: "How often the inflow signal is sampled; also its lag.",
      default: DAY,
      minimum: 1,
    },
  },
  additionalProperties: false,
};

/** MomentumChaser strategy factory (previous weights live in the closure). */
export function momentumChaser(config: MomentumChaserConfig = {}): Strategy {
  const cfg = { ...momentumChaserDefaults, ...config };
  let prev: Map<PoolId, Wad> | null = null;
  return {
    name: "MomentumChaser",
    configSchema,
    config: cfg,
    cadenceSec: cfg.cadenceSec,
    phaseSec: 0,
    propose(state: MarketState, _portfolio: Portfolio): TargetAllocation {
      const pools = [...state.pools].sort();
      const weights = new Map<PoolId, Wad>();
      for (const pool of pools) weights.set(pool, state.poolWeight(pool));
      const scores = new Map<PoolId, Wad>();
      let anyInflow = false;
      if (prev !== null) {
        for (const pool of pools) {
          const inflow = weights.get(pool)! - (prev.get(pool) ?? 0n);
          const score = inflow > 0n ? inflow : 0n;
          scores.set(pool, score);
          if (score > 0n) anyInflow = true;
        }
      }
      prev = weights;
      if (!anyInflow) {
        // First call or a still market: follow the standing crowd (uniform
        // when the market is empty, via normalizeToWad's all-zero rule).
        for (const pool of pools) scores.set(pool, weights.get(pool)!);
      }
      return normalizeToWad(scores);
    },
  };
}
