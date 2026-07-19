/**
 * Turns an ArenaRunConfig (+ optional historical dataset JSON) into a
 * finished ArenaResult. Same determinism contract as buildRun: pure with
 * respect to its inputs, runs inside the web worker. The market scenario is
 * built by the shared ./scenario.js builder, so an arena and a console run
 * with the same {model, data, crowd} sub-configs replay the same market.
 */
import { WAD } from "@aero-autopilot/core/math";
import { WEEK, type Wad } from "@aero-autopilot/core/model";
import { runArena, type ArenaAgentSpec, type ArenaResult } from "@aero-autopilot/core/arena";
import { MAX_AGENTS, type ArenaRunConfig } from "./arenaConfig.js";
import { buildScenario } from "./scenario.js";
import { buildStrategy } from "./strategyCatalog.js";

export interface BuiltArena {
  result: ArenaResult;
  poolNames: Map<string, string>;
  datasetGeneratedAt: string | undefined;
  dataKind: "historical" | "synthetic";
  revenueUnit: "usd" | "index";
  startTime: number;
  durationSec: number;
}

export function buildAndRunArena(config: ArenaRunConfig, historical: unknown | null): BuiltArena {
  if (config.agents.length > MAX_AGENTS) {
    throw new Error(`arena supports at most ${MAX_AGENTS} agents`);
  }
  // The crowd scales off everyone's combined weight: the roster IS the
  // "portfolio" from the scenario's point of view.
  let portfolioWeight: Wad = 0n;
  for (const a of config.agents) {
    portfolioWeight += BigInt(a.trancheTokens) * WAD * BigInt(a.trancheCount);
  }
  const scenario = buildScenario(config, portfolioWeight, historical);
  const { model, crowd, startTime, durationSec } = scenario;

  const agents: ArenaAgentSpec[] = config.agents.map((a) => ({
    id: a.id,
    label: a.label,
    strategy: buildStrategy(a.strategy.kind, a.strategy.config),
    trancheCount: a.trancheCount,
    trancheWeight: BigInt(a.trancheTokens) * WAD,
  }));

  const stepSec = config.run.stepSec;
  const cooldownSec = config.model.kind === "epoch" ? WEEK : config.model.cooldownSec;
  const steps = durationSec / stepSec;
  const sampleEvery = Math.max(1, Math.floor(steps / 400));
  const crowdUpdateSec = Math.max(stepSec, Math.floor(21_600 / stepSec) * stepSec);

  const result = runArena(model, {
    startTime,
    durationSec,
    stepSec,
    agents,
    cooldownSec,
    sampleIntervalSec: sampleEvery * stepSec,
    crowdUpdateSec,
    ...(crowd ? { crowd } : {}),
  });

  return {
    result,
    poolNames: scenario.poolNames,
    datasetGeneratedAt: scenario.datasetGeneratedAt,
    dataKind: scenario.dataKind,
    revenueUnit: scenario.revenueUnit,
    startTime,
    durationSec,
  };
}
