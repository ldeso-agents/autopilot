/**
 * Shared scenario builder: dataset → revenue process (+ wash-bait overlay) →
 * timing anchor → protocol model → crowd. Everything a replay needs except
 * the allocator(s); the console's single-strategy run and the arena both
 * build their scenario here so a given {model, data, crowd, run} config
 * means exactly the same market either way. `portfolioWeight` is an input
 * because the crowd's total weight scales off it.
 */
import { WAD } from "@aero-autopilot/core/math";
import {
  WEEK,
  HOUR,
  createContinuousModel,
  createEpochModel,
  reactiveHerd,
  staticCrowd,
  adversarialWashBait,
  type CrowdModel,
  type ProtocolModel,
  type RevenueProcess,
  type Wad,
} from "@aero-autopilot/core/model";
// deep imports: the /data barrel pulls in node-only modules (fs-backed token
// cache, indexer CLI) that cannot bundle for the browser
import { validateDataset, type DatasetV1 } from "@aero-autopilot/core/data/schema";
import { generateSyntheticDataset } from "@aero-autopilot/core/data/synthetic";
import { revenueProcessFromDataset } from "@aero-autopilot/core/data/revenue";
import type { RunConfig } from "./runConfig.js";

/** The scenario-defining slice of a run config (console and arena alike). */
export interface ScenarioConfig {
  model: RunConfig["model"];
  data: RunConfig["data"];
  crowd: RunConfig["crowd"];
  run: { durationWeeks: number; stepSec: number };
}

/** A built market scenario, ready to take allocator positions. */
export interface BuiltScenario {
  model: ProtocolModel;
  crowd: CrowdModel | undefined;
  revenue: RevenueProcess;
  poolNames: Map<string, string>;
  startTime: number;
  durationSec: number;
  datasetGeneratedAt: string | undefined;
  /** Historical timestamps are real dates; synthetic ones are an arbitrary anchor. */
  dataKind: "historical" | "synthetic";
  /** "usd" when the dataset carries Alchemy-priced revenue; "index" otherwise. */
  revenueUnit: "usd" | "index";
}

export function buildScenario(
  config: ScenarioConfig,
  portfolioWeight: Wad,
  historical: unknown | null,
): BuiltScenario {
  // -- dataset --------------------------------------------------------------
  let dataset: DatasetV1;
  if (config.data.kind === "historical") {
    if (historical === null) throw new Error("historical dataset not loaded");
    dataset = validateDataset(historical);
  } else {
    dataset = generateSyntheticDataset({
      seed: BigInt(config.data.seed),
      poolCount: config.data.poolCount,
      epochCount: config.data.epochCount,
      kind: config.data.process,
    });
  }
  const poolNames = new Map(dataset.pools.map((p) => [p.address, p.displayName]));

  // -- revenue process (+ optional wash-bait overlay) ------------------------
  let revenue: RevenueProcess = revenueProcessFromDataset(dataset);
  const epochs = dataset.pools[0]?.epochs ?? [];
  if (epochs.length < 3) throw new Error("dataset needs at least 3 epochs");
  // epoch order is source-dependent (sugar returns newest-first), scan all
  const allTs = dataset.pools.flatMap((p) => p.epochs.map((e) => e.ts));
  if (allTs.length === 0) throw new Error("dataset has no epochs");
  const dataStart = Math.min(...allTs);
  const lastEpochStart = Math.max(...allTs);
  // The newest historical epoch is usually still in progress at index time
  // (generatedAt falls inside it): its rewards are partially accumulated and
  // its week extends past "now". Replay only through complete epochs.
  const generatedAtSec = Date.parse(dataset.generatedAt) / 1000;
  const lastEpochPartial =
    config.data.kind === "historical" && generatedAtSec < lastEpochStart + WEEK;
  const dataEnd = lastEpochPartial ? lastEpochStart : lastEpochStart + WEEK;

  const wash = config.crowd.washBait;
  if (wash) {
    const pools = [...revenue.pools].sort();
    const target = pools[Math.min(wash.poolIndex, pools.length - 1)]!;
    // baseline: the pool's own average revenue rate over the dataset
    const baseRate = revenue.revenueBetween(target, dataStart, dataEnd) / BigInt(dataEnd - dataStart);
    const pump = baseRate * BigInt(Math.max(1, wash.rateMultiple));
    // alternating 2-day pumps starting in week 2
    const schedule = [];
    for (let ts = dataStart + 2 * WEEK; ts + 2 * 86_400 < dataEnd; ts += 2 * WEEK) {
      schedule.push({ start: ts, end: ts + 2 * 86_400, ratePerSecWad: pump });
    }
    revenue = adversarialWashBait(revenue, target, schedule);
  }

  // -- timing ----------------------------------------------------------------
  const stepSec = config.run.stepSec;
  // Earliest allowed start: one week of history for signals. Historical runs
  // anchor the window at the dataset's END so a short duration replays the
  // LATEST weeks (the ones that reflect the venue today), not the oldest;
  // synthetic processes are stationary, so they keep the fixed start.
  const earliestStart = dataStart + WEEK;
  const anchoredStart =
    config.data.kind === "historical"
      ? Math.max(earliestStart, dataEnd - config.run.durationWeeks * WEEK)
      : earliestStart;
  // +2h clears the v2 distribute window at the epoch flip
  const startTime = anchoredStart + 2 * HOUR;
  const maxDuration = dataEnd - startTime;
  let durationSec = Math.min(config.run.durationWeeks * WEEK, maxDuration);
  durationSec -= durationSec % stepSec;
  if (durationSec <= 0) throw new Error("duration too short for the dataset");

  // -- model -----------------------------------------------------------------
  const emissionRatePerSec = (BigInt(config.model.emissionPerDay) * WAD) / 86_400n;
  let model: ProtocolModel;
  if (config.model.kind === "epoch") {
    model = createEpochModel({ revenue, startTime });
  } else {
    model = createContinuousModel({
      revenue,
      startTime,
      cooldownSec: config.model.cooldownSec,
      cooldownGranularity: config.model.cooldownGranularity,
      emissionRatePerSec,
      caps: config.model.caps.enabled
        ? {
            enabled: true,
            kappaWad: (BigInt(config.model.caps.kappaMilli) * WAD) / 1000n,
            intervalSec: config.model.caps.intervalSec,
            windowSec: config.model.caps.windowSec,
          }
        : { enabled: false },
      decay: config.model.decay.enabled
        ? {
            enabled: true,
            ratePerSecWad: (BigInt(config.model.decay.ratePerDayMilli) * WAD) / 1000n / 86_400n,
          }
        : { enabled: false, ratePerSecWad: 0n },
    });
  }

  // -- crowd -----------------------------------------------------------------
  let crowd: CrowdModel | undefined;
  if (config.crowd.kind === "herd") {
    crowd = reactiveHerd({
      revenue,
      totalWeight: portfolioWeight * BigInt(config.crowd.multiple),
      lagSeconds: config.crowd.lagSec,
    });
  } else if (config.crowd.kind === "static") {
    const pools = [...revenue.pools].sort();
    const per = (portfolioWeight * BigInt(config.crowd.multiple)) / BigInt(pools.length);
    crowd = staticCrowd(new Map(pools.map((p) => [p, per])));
  }

  const revenueUnit: "usd" | "index" =
    dataset.source === "sugar" && dataset.pools.some((p) => p.epochs.some((e) => e.feesUsd !== undefined))
      ? "usd"
      : "index";

  return {
    model,
    crowd,
    revenue,
    poolNames,
    startTime,
    durationSec,
    datasetGeneratedAt: (dataset as { generatedAt?: string }).generatedAt,
    dataKind: config.data.kind,
    revenueUnit,
  };
}
