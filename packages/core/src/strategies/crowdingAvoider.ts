/**
 * CrowdingAvoider: allocates proportionally to marginal revenue per unit of
 * EXTERNAL weight — trailing revenue divided by everyone else's weight on
 * the pool. Where FixedGrid chases gross revenue (and therefore crowds into
 * whatever everyone already holds), CrowdingAvoider seeks the revenue the
 * fewest competitors are splitting. `MarketState.poolWeight` already counts
 * every other position plus the crowd, so in an arena this strategy is
 * competitor-aware with no extra plumbing; its own standing weight is
 * subtracted out so it does not flee pools merely because it sits in them.
 *
 * A floor on the divisor (`floorWeightWad`) avoids division by zero on
 * empty pools and damps the score of pools too thin to trust.
 */

import { mulDiv, WAD } from "../math/fixed.js";
import { DAY } from "../model/types.js";
import type { MarketState, PoolId, TargetAllocation, Wad } from "../model/types.js";
import { normalizeToWad } from "./normalize.js";
import {
  portfolioWeightOnPool,
  type ConfigSchema,
  type Portfolio,
  type Strategy,
} from "./types.js";

/** Configuration for CrowdingAvoider. */
export interface CrowdingAvoiderConfig {
  /** Invocation cadence in seconds. Default 6h. */
  cadenceSec?: number;
  /** Trailing revenue window, seconds. Default 24h. */
  lookbackSec?: number;
  /** Divisor floor in Wad weight units (also a thinness damper). Default 1. */
  floorWeightWad?: Wad;
}

/** Default CrowdingAvoider config values. */
export const crowdingAvoiderDefaults = {
  cadenceSec: 21_600,
  lookbackSec: DAY,
  floorWeightWad: WAD,
} as const;

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    cadenceSec: {
      type: "integer",
      description: "How often the strategy re-evaluates, in seconds.",
      default: 21_600,
      minimum: 1,
    },
    lookbackSec: {
      type: "integer",
      description: "Trailing revenue window in seconds used as the signal.",
      default: DAY,
      minimum: 1,
    },
    floorWeightWad: {
      type: "string",
      description: "Minimum divisor weight as a Wad decimal string (thinness damper).",
      default: "1000000000000000000",
    },
  },
  additionalProperties: false,
};

/** CrowdingAvoider strategy factory. */
export function crowdingAvoider(config: CrowdingAvoiderConfig = {}): Strategy {
  const cfg = { ...crowdingAvoiderDefaults, ...config };
  if (cfg.floorWeightWad <= 0n) {
    throw new Error(`crowdingAvoider: floorWeightWad must be positive, got ${cfg.floorWeightWad}`);
  }
  return {
    name: "CrowdingAvoider",
    configSchema,
    config: cfg,
    cadenceSec: cfg.cadenceSec,
    phaseSec: 0,
    propose(state: MarketState, portfolio: Portfolio): TargetAllocation {
      const pools = [...state.pools].sort();
      const scores = new Map<PoolId, Wad>();
      for (const pool of pools) {
        const revenue = state.trailingRevenue(pool, cfg.lookbackSec);
        const ours = portfolioWeightOnPool(portfolio, pool);
        const external = state.poolWeight(pool) - ours;
        const clamped = external > 0n ? external : 0n;
        const divisor = clamped > cfg.floorWeightWad ? clamped : cfg.floorWeightWad;
        scores.set(pool, mulDiv(revenue, WAD, divisor));
      }
      return normalizeToWad(scores);
    },
  };
}
