/**
 * UniformStatic, the do-nothing baseline: an equal split over the pool
 * universe, re-proposed unchanged on every cadence tick. After the bootstrap
 * rotation the scheduler's zero-distance short-circuit makes every
 * re-proposal free, so the strategy pays one rotation and then holds. In an
 * arena it measures how much (or little) the market rewards pure passivity.
 */

import { WEEK } from "../model/types.js";
import type { MarketState, PoolId, TargetAllocation, Wad } from "../model/types.js";
import { normalizeToWad } from "./normalize.js";
import type { ConfigSchema, Portfolio, Strategy } from "./types.js";

/** Configuration for UniformStatic. */
export interface UniformStaticConfig {
  /** Invocation cadence in seconds. Default 7 days. */
  cadenceSec?: number;
  /** Allowlisted pool universe. Defaults to every pool in the market state. */
  pools?: readonly PoolId[];
}

/** Default UniformStatic config values. */
export const uniformStaticDefaults = { cadenceSec: WEEK } as const;

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    cadenceSec: {
      type: "integer",
      description: "How often the (identical) target is re-proposed, in seconds.",
      default: WEEK,
      minimum: 1,
    },
    pools: {
      type: "array",
      description: "Allowlisted pool ids; empty means the full pool universe.",
      items: { type: "string" },
    },
  },
  additionalProperties: false,
};

/** UniformStatic strategy factory. */
export function uniformStatic(config: UniformStaticConfig = {}): Strategy {
  const cfg = { ...uniformStaticDefaults, ...config };
  return {
    name: "UniformStatic",
    configSchema,
    config: cfg,
    cadenceSec: cfg.cadenceSec,
    phaseSec: 0,
    propose(state: MarketState, _portfolio: Portfolio): TargetAllocation {
      const pools = [...(cfg.pools && cfg.pools.length > 0 ? cfg.pools : state.pools)].sort();
      const scores = new Map<PoolId, Wad>();
      for (const pool of pools) scores.set(pool, 1n);
      return normalizeToWad(scores);
    },
  };
}
