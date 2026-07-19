/**
 * Turns a RunConfig (+ optional historical dataset JSON) into a finished
 * BacktestResult. Pure with respect to its inputs, the core is deterministic,
 * so the same config + dataset always replays identically (URL reproducibility).
 * Runs inside the web worker. The market scenario itself is built by the
 * shared ./scenario.js builder (also used by the arena).
 */
import { WAD } from "@aero-autopilot/core/math";
import { WEEK, type Wad } from "@aero-autopilot/core/model";
import { runBacktest, type BacktestResult } from "@aero-autopilot/core/backtest";
import type { RunConfig } from "./runConfig.js";
import { buildScenario } from "./scenario.js";
import { buildStrategy, probeStrategy } from "./strategyCatalog.js";

// Back-compat re-export: the catalog moved to ./strategyCatalog.js.
export { probeStrategy };

export interface BuiltRun {
  result: BacktestResult;
  poolNames: Map<string, string>;
  datasetGeneratedAt: string | undefined;
  /** Historical timestamps are real dates; synthetic ones are an arbitrary anchor. */
  dataKind: "historical" | "synthetic";
  /** "usd" when the dataset carries Alchemy-priced revenue; "index" otherwise
   *  (synthetic data sets feesUsd too, but its values are index units). */
  revenueUnit: "usd" | "index";
  startTime: number;
  durationSec: number;
}

export function buildAndRun(config: RunConfig, historical: unknown | null): BuiltRun {
  const trancheWeight: Wad = BigInt(config.run.trancheTokens) * WAD;
  const portfolioWeight = trancheWeight * BigInt(config.run.trancheCount);
  const scenario = buildScenario(config, portfolioWeight, historical);
  const { model, crowd, startTime, durationSec } = scenario;

  const strategy = buildStrategy(config.strategy.kind, config.strategy.config);
  const stepSec = config.run.stepSec;
  const cooldownSec = config.model.kind === "epoch" ? WEEK : config.model.cooldownSec;
  const steps = durationSec / stepSec;
  const sampleEvery = Math.max(1, Math.floor(steps / 400));
  // herd re-weighting every 6h of sim time (not every step), the dominant
  // cost of a run; negligible fidelity change at day-scale information lags
  const crowdUpdateSec = Math.max(stepSec, Math.floor(21_600 / stepSec) * stepSec);

  const result = runBacktest(strategy, model, {
    startTime,
    durationSec,
    stepSec,
    trancheCount: config.run.trancheCount,
    trancheWeight,
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
