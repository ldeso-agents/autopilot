/**
 * EwmaForecast: allocates proportionally to an exponentially weighted moving
 * average of per-pool trailing revenue. The EWMA smooths bucket noise that a
 * plain trailing-revenue grid inherits wholesale, while adapting faster than
 * a long lookback window — a middle ground between FixedGrid's raw signal
 * and PersistenceCarry's volatility haircut.
 *
 * Update (exact nonnegative bigint arithmetic, no subtraction):
 *   ewma' = mulDiv(WAD − alphaWad, ewma, WAD) + mulDiv(alphaWad, x, WAD)
 * with x = trailingRevenue(pool, lookbackSec); the first observation seeds
 * the average directly.
 */

import { mulDiv, WAD } from "../math/fixed.js";
import type { MarketState, PoolId, TargetAllocation, Wad } from "../model/types.js";
import { normalizeToWad } from "./normalize.js";
import type { ConfigSchema, Portfolio, Strategy } from "./types.js";

/** Configuration for EwmaForecast. */
export interface EwmaForecastConfig {
  /** Invocation cadence in seconds. Default 6h. */
  cadenceSec?: number;
  /** EWMA smoothing factor in Wad (1e18 = react instantly). Default 0.3. */
  alphaWad?: Wad;
  /** Trailing revenue window per observation, seconds. Default 6h. */
  lookbackSec?: number;
}

/** Default EwmaForecast config values. */
export const ewmaForecastDefaults = {
  cadenceSec: 21_600,
  alphaWad: (WAD * 3n) / 10n,
  lookbackSec: 21_600,
} as const;

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    cadenceSec: {
      type: "integer",
      description: "How often the forecast updates and re-proposes, in seconds.",
      default: 21_600,
      minimum: 1,
    },
    alphaWad: {
      type: "string",
      description: "EWMA smoothing factor as a Wad decimal string (1e18 = no smoothing).",
      default: "300000000000000000",
    },
    lookbackSec: {
      type: "integer",
      description: "Trailing revenue window observed each update, in seconds.",
      default: 21_600,
      minimum: 1,
    },
  },
  additionalProperties: false,
};

/** EwmaForecast strategy factory (the EWMA state lives in the closure). */
export function ewmaForecast(config: EwmaForecastConfig = {}): Strategy {
  const cfg = { ...ewmaForecastDefaults, ...config };
  if (cfg.alphaWad < 0n || cfg.alphaWad > WAD) {
    throw new Error(`ewmaForecast: alphaWad must be in [0, WAD], got ${cfg.alphaWad}`);
  }
  const ewma = new Map<PoolId, Wad>();
  return {
    name: "EwmaForecast",
    configSchema,
    config: cfg,
    cadenceSec: cfg.cadenceSec,
    phaseSec: 0,
    propose(state: MarketState, _portfolio: Portfolio): TargetAllocation {
      const pools = [...state.pools].sort();
      const scores = new Map<PoolId, Wad>();
      for (const pool of pools) {
        const x = state.trailingRevenue(pool, cfg.lookbackSec);
        const prev = ewma.get(pool);
        const next =
          prev === undefined
            ? x
            : mulDiv(WAD - cfg.alphaWad, prev, WAD) + mulDiv(cfg.alphaWad, x, WAD);
        ewma.set(pool, next);
        scores.set(pool, next);
      }
      return normalizeToWad(scores);
    },
  };
}
