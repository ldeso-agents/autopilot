/**
 * RandomRotator, the seeded-noise baseline: every cadence tick it draws
 * `poolsPerDraw` distinct pools uniformly at random (partial Fisher–Yates
 * over the sorted universe) and splits the target equally between them.
 * All randomness flows through the package PRNG, so a fresh instance with
 * the same seed replays identically — the invocation grid is a pure
 * function of (cadenceSec, phaseSec), which pins the draw sequence.
 */

import { createPrng } from "../math/prng.js";
import { DAY } from "../model/types.js";
import type { MarketState, PoolId, TargetAllocation, Wad } from "../model/types.js";
import { normalizeToWad } from "./normalize.js";
import type { ConfigSchema, Portfolio, Strategy } from "./types.js";

/** Configuration for RandomRotator. */
export interface RandomRotatorConfig {
  /** PRNG seed (decimal string or bigint). Default "1". */
  seed?: string | number | bigint;
  /** Invocation cadence in seconds. Default 1 day. */
  cadenceSec?: number;
  /** Number of distinct pools per draw. Default 2, clamped to the universe. */
  poolsPerDraw?: number;
}

/** Default RandomRotator config values. */
export const randomRotatorDefaults = { seed: "1", cadenceSec: DAY, poolsPerDraw: 2 } as const;

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    seed: {
      type: "string",
      description: "PRNG seed; same seed always replays the same draw sequence.",
      default: "1",
    },
    cadenceSec: {
      type: "integer",
      description: "How often a fresh random target is drawn, in seconds.",
      default: DAY,
      minimum: 1,
    },
    poolsPerDraw: {
      type: "integer",
      description: "Distinct pools per draw; the target splits equally between them.",
      default: 2,
      minimum: 1,
    },
  },
  additionalProperties: false,
};

/** RandomRotator strategy factory (PRNG state lives in the closure). */
export function randomRotator(config: RandomRotatorConfig = {}): Strategy {
  const cfg = { ...randomRotatorDefaults, ...config };
  if (!Number.isInteger(cfg.poolsPerDraw) || cfg.poolsPerDraw < 1) {
    throw new Error(`randomRotator: poolsPerDraw must be a positive integer, got ${cfg.poolsPerDraw}`);
  }
  const rng = createPrng(BigInt(cfg.seed));
  return {
    name: "RandomRotator",
    configSchema,
    config: cfg,
    cadenceSec: cfg.cadenceSec,
    phaseSec: 0,
    propose(state: MarketState, _portfolio: Portfolio): TargetAllocation {
      const pools = [...state.pools].sort();
      const k = Math.min(cfg.poolsPerDraw, pools.length);
      // Partial Fisher–Yates: the first k entries end up a uniform k-subset.
      for (let i = 0; i < k; i += 1) {
        const j = i + rng.nextIntBelow(pools.length - i);
        const tmp = pools[i]!;
        pools[i] = pools[j]!;
        pools[j] = tmp;
      }
      const scores = new Map<PoolId, Wad>();
      for (let i = 0; i < k; i += 1) scores.set(pools[i]!, 1n);
      return normalizeToWad(scores);
    },
  };
}
