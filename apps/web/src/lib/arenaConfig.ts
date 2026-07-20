/**
 * The full description of one arena run: a roster of competing agents plus
 * the shared market scenario (model/data/crowd, reusing the console's
 * sub-shapes verbatim). Serialized into the URL under `#arena=` so every
 * arena is reproducible from a shared link, exactly like console runs.
 */
import { fromBase64Url, toBase64Url, type RunConfig, type StrategyKind } from "./runConfig.js";

/** One competitor in the roster. */
export interface ArenaAgentConfig {
  /** Stable id within the config ("agent-1", …); also the engine agent id. */
  id: string;
  label: string;
  strategy: { kind: StrategyKind; config: Record<string, unknown> };
  trancheCount: number;
  trancheTokens: number;
}

export interface ArenaRunConfig {
  agents: ArenaAgentConfig[];
  model: RunConfig["model"];
  data: RunConfig["data"];
  /** Crowd `multiple` scales off the TOTAL weight of all agents combined. */
  crowd: RunConfig["crowd"];
  run: { durationWeeks: number; stepSec: number };
}

/** Roster ceiling: one categorical color slot per agent, never cycled. */
export const MAX_AGENTS = 8;

const CONTINUOUS_MODEL: RunConfig["model"] = {
  kind: "continuous",
  cooldownSec: 172_800,
  cooldownGranularity: "position",
  emissionPerDay: 100_000,
  caps: { enabled: true, kappaMilli: 1200, intervalSec: 172_800, windowSec: 172_800 },
  decay: { enabled: false, ratePerDayMilli: 10 },
};

const agent = (
  id: string,
  label: string,
  kind: StrategyKind,
  config: Record<string, unknown> = {},
): ArenaAgentConfig => ({
  id,
  label,
  strategy: { kind, config },
  trancheCount: 2,
  trancheTokens: 250_000,
});

/** Default arena: the battle royale, every strategy family in one market. */
export const DEFAULT_ARENA: ArenaRunConfig = {
  agents: [
    agent("agent-1", "Revenue mirror 48h", "fixedGrid48h"),
    agent("agent-2", "Persistence carry", "persistenceCarry"),
    agent("agent-3", "Water-filling", "waterFilling"),
    // 6h ticks: the water-filled propose is ~ms-expensive, hourly ticks over
    // 8 weeks would dominate the whole arena's compute budget
    agent("agent-4", "Continuous greedy", "continuousGreedy", { cadenceSec: 21_600 }),
    agent("agent-5", "EWMA forecast", "ewmaForecast"),
    agent("agent-6", "Crowding avoider", "crowdingAvoider"),
    agent("agent-7", "Bandit", "banditAllocator"),
    agent("agent-8", "Momentum chaser", "momentumChaser"),
  ],
  model: CONTINUOUS_MODEL,
  data: { kind: "synthetic", seed: "7", poolCount: 8, epochCount: 20, process: "regime" },
  crowd: { kind: "herd", lagSec: 604_800, multiple: 10 },
  run: { durationWeeks: 8, stepSec: 3600 },
};

/** One-click arena scenarios. */
export const ARENA_PRESETS: { id: string; label: string; blurb: string; config: ArenaRunConfig }[] = [
  {
    id: "battle-royale",
    label: "Battle royale",
    blurb:
      "Every strategy family in one shared Aero v3 market, splitting the same revenue pro-rata by weight. One agent's capture is the others' dilution; the leaderboard is the whole argument.",
    config: DEFAULT_ARENA,
  },
  {
    id: "smart-vs-dumb",
    label: "Smart money vs dumb money",
    blurb:
      "Three informed allocators (EWMA forecast, crowding avoider, water-filling) against three that trade on noise or lagged reflexive signals (momentum chaser, random rotator, uniform static). The gap between the packs is the value of information.",
    config: {
      agents: [
        agent("agent-1", "EWMA forecast", "ewmaForecast"),
        agent("agent-2", "Crowding avoider", "crowdingAvoider"),
        agent("agent-3", "Water-filling", "waterFilling"),
        agent("agent-4", "Momentum chaser", "momentumChaser"),
        agent("agent-5", "Random rotator", "randomRotator"),
        agent("agent-6", "Uniform static", "uniformStatic"),
      ],
      model: CONTINUOUS_MODEL,
      data: { kind: "synthetic", seed: "21", poolCount: 6, epochCount: 20, process: "persistent" },
      crowd: { kind: "herd", lagSec: 3 * 86_400, multiple: 8 },
      run: { durationWeeks: 8, stepSec: 3600 },
    },
  },
  {
    id: "cooldown-melee",
    label: "Cooldown melee",
    blurb:
      "The same revenue-mirror policy at four cadences on a one-hour cooldown with a bursty fee process: how much of the cadence race survives when everyone else is racing too?",
    config: {
      agents: [
        agent("agent-1", "Mirror, weekly", "fixedGridWeekly"),
        agent("agent-2", "Mirror, 48h", "fixedGrid48h"),
        agent("agent-3", "Mirror, 24h", "fixedGrid24h"),
        agent("agent-4", "Mirror, 1h", "fixedGrid1h"),
      ],
      model: { ...CONTINUOUS_MODEL, cooldownSec: 3_600, caps: { ...CONTINUOUS_MODEL.caps, enabled: false } },
      data: { kind: "synthetic", seed: "99", poolCount: 8, epochCount: 10, process: "bursty" },
      crowd: { kind: "herd", lagSec: 3_600, multiple: 10 },
      run: { durationWeeks: 6, stepSec: 1800 },
    },
  },
];

// ---------------------------------------------------------------------------
// URL hash serialization (`#arena=`, base64url JSON, same scheme as `#run=`)
// ---------------------------------------------------------------------------

export function encodeArenaConfig(config: ArenaRunConfig): string {
  return toBase64Url(JSON.stringify(config));
}

/** The preset id whose config equals `config` exactly, else null — so the
 *  preset bar never claims a scenario the loaded roster doesn't match. */
export function matchArenaPreset(config: ArenaRunConfig): string | null {
  const encoded = encodeArenaConfig(config);
  return ARENA_PRESETS.find((p) => encodeArenaConfig(p.config) === encoded)?.id ?? null;
}

export function decodeArenaConfig(encoded: string): ArenaRunConfig {
  const parsed: unknown = JSON.parse(fromBase64Url(encoded));
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid arena config");
  const cfg = parsed as ArenaRunConfig;
  if (!Array.isArray(cfg.agents) || cfg.agents.length === 0 || !cfg.model?.kind || !cfg.data?.kind || !cfg.run) {
    throw new Error("invalid arena config");
  }
  for (const a of cfg.agents) {
    if (!a?.id || !a.strategy?.kind) throw new Error("invalid arena config");
  }
  return cfg;
}

export function arenaConfigToHash(config: ArenaRunConfig): string {
  return `#arena=${encodeArenaConfig(config)}`;
}

export function arenaConfigFromHash(hash: string): ArenaRunConfig | undefined {
  const match = /#arena=([A-Za-z0-9_-]+)/.exec(hash);
  if (!match?.[1]) return undefined;
  try {
    return decodeArenaConfig(match[1]);
  } catch {
    return undefined;
  }
}
