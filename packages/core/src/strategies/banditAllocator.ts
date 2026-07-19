/**
 * BanditAllocator: epsilon-greedy multi-armed bandit over pools. Each
 * cadence tick it (1) observes the realized per-weight yield of every pool
 * it currently holds and folds it into a per-pool EWMA value estimate
 * (partial feedback — unheld pools' estimates go stale, so the
 * exploration/exploitation tension is real), then (2) either explores
 * (probability `epsilonWad`: all-in on a uniformly random pool) or exploits
 * (all-in on the argmax estimate, ties broken by pool id ascending).
 * Before the first observation it proposes a uniform split.
 *
 * Epsilon-greedy rather than UCB deliberately: UCB needs ln/sqrt floats and
 * `Math.log` is implementation-defined across JS engines, which would break
 * the node-golden ↔ browser-replay determinism contract. Everything here is
 * exact bigint via the package PRNG.
 */

import { mulDiv, WAD } from "../math/fixed.js";
import { createPrng } from "../math/prng.js";
import type { MarketState, PoolId, TargetAllocation, Wad } from "../model/types.js";
import { normalizeToWad } from "./normalize.js";
import {
  portfolioWeightOnPool,
  type ConfigSchema,
  type Portfolio,
  type Strategy,
} from "./types.js";

/** Configuration for BanditAllocator. */
export interface BanditAllocatorConfig {
  /** Invocation cadence in seconds. Default 6h. */
  cadenceSec?: number;
  /** PRNG seed (decimal string or bigint). Default "1". */
  seed?: string | number | bigint;
  /** Exploration probability in Wad (1e18 = always explore). Default 0.1. */
  epsilonWad?: Wad;
  /** EWMA factor for the value estimates in Wad. Default 0.5. */
  alphaWad?: Wad;
}

/** Default BanditAllocator config values. */
export const banditAllocatorDefaults = {
  cadenceSec: 21_600,
  seed: "1",
  epsilonWad: WAD / 10n,
  alphaWad: WAD / 2n,
} as const;

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    cadenceSec: {
      type: "integer",
      description: "How often the bandit observes and re-decides, in seconds.",
      default: 21_600,
      minimum: 1,
    },
    seed: {
      type: "string",
      description: "PRNG seed; same seed always replays the same explore/exploit path.",
      default: "1",
    },
    epsilonWad: {
      type: "string",
      description: "Exploration probability as a Wad decimal string (1e18 = always).",
      default: "100000000000000000",
    },
    alphaWad: {
      type: "string",
      description: "Value-estimate EWMA factor as a Wad decimal string.",
      default: "500000000000000000",
    },
  },
  additionalProperties: false,
};

/** BanditAllocator strategy factory (estimates + PRNG live in the closure). */
export function banditAllocator(config: BanditAllocatorConfig = {}): Strategy {
  const cfg = { ...banditAllocatorDefaults, ...config };
  if (cfg.epsilonWad < 0n || cfg.epsilonWad > WAD) {
    throw new Error(`banditAllocator: epsilonWad must be in [0, WAD], got ${cfg.epsilonWad}`);
  }
  if (cfg.alphaWad < 0n || cfg.alphaWad > WAD) {
    throw new Error(`banditAllocator: alphaWad must be in [0, WAD], got ${cfg.alphaWad}`);
  }
  const rng = createPrng(BigInt(cfg.seed));
  const q = new Map<PoolId, Wad>();
  return {
    name: "BanditAllocator",
    configSchema,
    config: cfg,
    cadenceSec: cfg.cadenceSec,
    phaseSec: 0,
    propose(state: MarketState, portfolio: Portfolio): TargetAllocation {
      const pools = [...state.pools].sort();
      // Observe: realized per-weight yield of every held pool.
      for (const pool of pools) {
        if (portfolioWeightOnPool(portfolio, pool) === 0n) continue;
        const w = state.poolWeight(pool);
        const reward = mulDiv(state.trailingRevenue(pool, cfg.cadenceSec), WAD, w > WAD ? w : WAD);
        const prev = q.get(pool);
        const next =
          prev === undefined
            ? reward
            : mulDiv(WAD - cfg.alphaWad, prev, WAD) + mulDiv(cfg.alphaWad, reward, WAD);
        q.set(pool, next);
      }
      // Act: uniform before any observation, then epsilon-greedy all-in.
      if (q.size === 0) {
        const scores = new Map<PoolId, Wad>();
        for (const pool of pools) scores.set(pool, 1n);
        return normalizeToWad(scores);
      }
      let chosen: PoolId;
      if (rng.nextBigintBelow(WAD) < cfg.epsilonWad) {
        chosen = pools[rng.nextIntBelow(pools.length)]!;
      } else {
        chosen = pools[0]!;
        let best = -1n;
        for (const pool of pools) {
          const value = q.get(pool) ?? 0n;
          if (value > best) {
            best = value;
            chosen = pool;
          }
        }
      }
      return new Map([[chosen, WAD]]);
    },
  };
}
