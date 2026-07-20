/**
 * The one strategy catalog shared by the console and the arena: factory per
 * StrategyKind, display labels, the config-string revival rule, and probe
 * instances for schema-driven forms. Adding a StrategyKind without updating
 * STRATEGY_FACTORIES is a type error by construction.
 */
import {
  banditAllocator,
  continuousGreedy,
  crowdingAvoider,
  ewmaForecast,
  fixedGrid1h,
  fixedGrid24h,
  fixedGrid48h,
  fixedGridWeekly,
  momentumChaser,
  persistenceCarry,
  randomRotator,
  uniformStatic,
  waterFilling,
  type Strategy,
} from "@aero-autopilot/core/strategies";
import type { StrategyKind } from "./runConfig.js";

export const STRATEGY_FACTORIES: Record<StrategyKind, (config: Record<string, unknown>) => Strategy> = {
  fixedGridWeekly: (c) => fixedGridWeekly(c),
  fixedGrid48h: (c) => fixedGrid48h(c),
  fixedGrid24h: (c) => fixedGrid24h(c),
  fixedGrid1h: (c) => fixedGrid1h(c),
  persistenceCarry: (c) => persistenceCarry(c),
  waterFilling: (c) => waterFilling(c),
  continuousGreedy: (c) => continuousGreedy(c),
  uniformStatic: (c) => uniformStatic(c),
  randomRotator: (c) => randomRotator(c),
  momentumChaser: (c) => momentumChaser(c),
  ewmaForecast: (c) => ewmaForecast(c),
  crowdingAvoider: (c) => crowdingAvoider(c),
  banditAllocator: (c) => banditAllocator(c),
};

// Display labels only; the `kind` ids are serialized into share URLs and
// must stay stable. "Revenue mirror" names the POLICY (allocate proportional
// to trailing revenue, see the Theory page); the suffix is the cadence.
export const STRATEGY_LABELS: { kind: StrategyKind; label: string }[] = [
  { kind: "fixedGridWeekly", label: "Revenue mirror: weekly (live on v2)" },
  { kind: "fixedGrid48h", label: "Revenue mirror, 48h" },
  { kind: "fixedGrid24h", label: "Revenue mirror, 24h" },
  { kind: "fixedGrid1h", label: "Revenue mirror, 1h" },
  { kind: "persistenceCarry", label: "Persistence carry" },
  { kind: "waterFilling", label: "Water-filling (optimal response)" },
  { kind: "continuousGreedy", label: "Continuous greedy" },
  { kind: "uniformStatic", label: "Uniform static (baseline)" },
  { kind: "randomRotator", label: "Random rotator (baseline)" },
  { kind: "momentumChaser", label: "Momentum chaser (herds late)" },
  { kind: "ewmaForecast", label: "EWMA forecast" },
  { kind: "crowdingAvoider", label: "Crowding avoider" },
  { kind: "banditAllocator", label: "Bandit (ε-greedy)" },
];

/** Probe instances used by the UI to read configSchema + defaults. */
export function probeStrategy(kind: StrategyKind): Strategy {
  return STRATEGY_FACTORIES[kind]({});
}

/**
 * Wad-typed config fields travel as decimal strings in JSON; convert here.
 * Configs arrive from free-text form fields and hand-shareable URLs, so
 * invalid entries are DROPPED (the factory default applies) rather than
 * passed through, where they would either throw mid-run (`BigInt("0.3")`,
 * `BigInt("abc")` for seeds) or silently corrupt it (a NaN-turned-null
 * cadence disables the strategy's whole invocation grid).
 */
export function reviveStrategyConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (key.endsWith("Wad") && typeof value === "string") {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) continue; // not a Wad integer string
      out[key] = BigInt(trimmed);
      continue;
    }
    if (key === "seed" && typeof value === "string") {
      const digits = value.replace(/\D/g, "");
      if (digits) out[key] = digits;
      continue; // empty after stripping: factory default seed
    }
    out[key] = value;
  }
  return out;
}

/** Builds a live strategy instance from its serialized {kind, config} form. */
export function buildStrategy(kind: StrategyKind, config: Record<string, unknown>): Strategy {
  return STRATEGY_FACTORIES[kind](reviveStrategyConfig(config));
}
