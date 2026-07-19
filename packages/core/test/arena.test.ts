/**
 * Arena engine tests: conservation, competitiveness, fairness, determinism,
 * and a committed golden snapshot for the battle-royale roster.
 * Regenerate goldens with UPDATE_GOLDEN=1 pnpm --filter @aero-autopilot/core test
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WAD } from "../src/math/fixed.js";
import { runArena, type ArenaConfig, type ArenaResult } from "../src/arena/run.js";
import { createContinuousModel } from "../src/model/continuous.js";
import { reactiveHerd, staticCrowd } from "../src/model/crowd.js";
import { DAY, HOUR, WEEK, type ProtocolModel, type RevenueProcess } from "../src/model/types.js";
import { revenueProcessFromDataset } from "../src/data/revenue.js";
import { generateSyntheticDataset } from "../src/data/synthetic.js";
import { toJsonValue } from "../src/fixtures/serialize.js";
import { banditAllocator } from "../src/strategies/banditAllocator.js";
import { continuousGreedy } from "../src/strategies/continuousGreedy.js";
import { crowdingAvoider } from "../src/strategies/crowdingAvoider.js";
import { ewmaForecast } from "../src/strategies/ewmaForecast.js";
import { fixedGrid, fixedGrid48h } from "../src/strategies/fixedGrid.js";
import { momentumChaser } from "../src/strategies/momentumChaser.js";
import { persistenceCarry } from "../src/strategies/persistenceCarry.js";
import { randomRotator } from "../src/strategies/randomRotator.js";
import { uniformStatic } from "../src/strategies/uniformStatic.js";
import { waterFilling } from "../src/strategies/waterFilling.js";
import { constantRevenue, T0 } from "./helpers.js";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

function continuousArena(
  revenue: RevenueProcess,
  config: Omit<ArenaConfig, "startTime"> & { startTime?: number },
  cooldownSec = config.cooldownSec ?? HOUR,
): ArenaResult {
  const startTime = config.startTime ?? T0;
  const model: ProtocolModel = createContinuousModel({ revenue, startTime, cooldownSec });
  return runArena(model, { ...config, startTime, cooldownSec });
}

/** Σ agent earned + crowd revenue + dust must equal total revenue exactly. */
function expectConservation(result: ArenaResult): void {
  let agentEarned = 0n;
  for (const agent of result.agents) agentEarned += agent.earnedTotal;
  expect(agentEarned + result.totals.crowdRevenue + result.totals.revenueDust).toBe(
    result.totals.revenueTotal,
  );
}

describe("runArena", () => {
  it("conserves revenue across agents, crowd, and dust (exact)", () => {
    const dataset = generateSyntheticDataset({ seed: 5n, poolCount: 4, epochCount: 4, kind: "bursty", startTs: T0 });
    const revenue = revenueProcessFromDataset(dataset);
    const start = T0 + WEEK;
    const result = continuousArena(revenue, {
      startTime: start,
      durationSec: 2 * WEEK,
      stepSec: HOUR,
      cooldownSec: DAY,
      crowd: reactiveHerd({ revenue, totalWeight: 300n * WAD, lagSeconds: DAY, windowSec: DAY }),
      crowdUpdateSec: 6 * HOUR,
      agents: [
        { id: "grid", strategy: fixedGrid(6 * HOUR, { lookbackSec: DAY }), trancheCount: 2, trancheWeight: 50n * WAD },
        { id: "carry", strategy: persistenceCarry({ lookbackSec: DAY }), trancheCount: 2, trancheWeight: 50n * WAD },
        { id: "uniform", strategy: uniformStatic(), trancheCount: 1, trancheWeight: 100n * WAD },
      ],
    });
    expectConservation(result);
    for (const agent of result.agents) {
      expect(agent.equity.at(-1)).toBe(agent.totalReturn);
      expect(agent.equity).toHaveLength(result.times.length);
      expect(agent.allocationWeights).toHaveLength(result.times.length);
    }
  });

  it("is competitive: the informed agent beats the market, the blind one trails it", () => {
    // All revenue in pool a; the uniform baseline donates half its weight to b.
    const revenue = constantRevenue({ a: 1_000n * WAD, b: 0n });
    const result = continuousArena(revenue, {
      durationSec: 2 * DAY,
      stepSec: HOUR,
      cooldownSec: HOUR,
      crowd: staticCrowd(new Map([["a", 50n * WAD], ["b", 50n * WAD]])),
      agents: [
        { id: "grid", strategy: fixedGrid(HOUR, { lookbackSec: HOUR }), trancheCount: 1, trancheWeight: 100n * WAD },
        { id: "uniform", strategy: uniformStatic(), trancheCount: 1, trancheWeight: 100n * WAD },
      ],
    });
    const [grid, uniform] = result.agents;
    expect(grid!.returnVsMarket > 0n).toBe(true);
    expect(uniform!.returnVsMarket < 0n).toBe(true);
    expect(grid!.totalReturn > uniform!.totalReturn).toBe(true);
    expectConservation(result);
  });

  it("matches the market benchmark when a lone agent is the whole market", () => {
    const revenue = constantRevenue({ a: 123_456n, b: 789n });
    const result = continuousArena(revenue, {
      durationSec: DAY,
      stepSec: HOUR,
      cooldownSec: HOUR,
      agents: [
        { id: "solo", strategy: fixedGrid(HOUR, { lookbackSec: HOUR }), trancheCount: 1, trancheWeight: 100n * WAD },
      ],
    });
    const solo = result.agents[0]!;
    // First-step bootstrap dust + floor dust only.
    const slack = result.marketBenchmarkReturn / 1_000_000n + 2n;
    const diff = solo.returnVsMarket < 0n ? -solo.returnVsMarket : solo.returnVsMarket;
    expect(diff <= slack).toBe(true);
  });

  it("gives identical twins identical outcomes regardless of roster position", () => {
    const dataset = generateSyntheticDataset({ seed: 9n, poolCount: 3, epochCount: 3, kind: "persistent", startTs: T0 });
    const revenue = revenueProcessFromDataset(dataset);
    const result = continuousArena(revenue, {
      startTime: T0 + WEEK,
      durationSec: WEEK,
      stepSec: HOUR,
      cooldownSec: DAY,
      crowd: staticCrowd(new Map([[revenue.pools[0]!, 100n * WAD]])),
      agents: [
        { id: "twin-a", strategy: fixedGrid(6 * HOUR, { lookbackSec: DAY }), trancheCount: 2, trancheWeight: 50n * WAD },
        { id: "noise", strategy: uniformStatic(), trancheCount: 1, trancheWeight: 100n * WAD },
        { id: "twin-b", strategy: fixedGrid(6 * HOUR, { lookbackSec: DAY }), trancheCount: 2, trancheWeight: 50n * WAD },
      ],
    });
    const [a, , b] = result.agents;
    expect(a!.equity).toEqual(b!.equity);
    expect(a!.earnedTotal).toBe(b!.earnedTotal);
    expect(a!.rotations).toBe(b!.rotations);
    expect(a!.blockedSubmissions).toBe(b!.blockedSubmissions);
  });

  it("replays identically from fresh instances (seeded roster)", () => {
    const run = (): ArenaResult => {
      const dataset = generateSyntheticDataset({ seed: 3n, poolCount: 4, epochCount: 3, kind: "regime", startTs: T0 });
      const revenue = revenueProcessFromDataset(dataset);
      return continuousArena(revenue, {
        startTime: T0 + WEEK,
        durationSec: WEEK,
        stepSec: HOUR,
        cooldownSec: 6 * HOUR,
        crowd: reactiveHerd({ revenue, totalWeight: 200n * WAD, lagSeconds: DAY, windowSec: DAY }),
        agents: [
          { id: "rand", strategy: randomRotator({ seed: "4" }), trancheCount: 2, trancheWeight: 50n * WAD },
          { id: "bandit", strategy: banditAllocator({ seed: "4" }), trancheCount: 2, trancheWeight: 50n * WAD },
          { id: "ewma", strategy: ewmaForecast(), trancheCount: 1, trancheWeight: 100n * WAD },
        ],
      });
    };
    expect(run()).toEqual(run());
  });

  it("validates its inputs", () => {
    const revenue = constantRevenue({ a: WAD });
    const spec = { id: "x", strategy: uniformStatic(), trancheCount: 1, trancheWeight: WAD };
    expect(() =>
      continuousArena(revenue, { durationSec: HOUR, stepSec: HOUR, agents: [spec, spec] }),
    ).toThrow(/duplicate agent id/);
    expect(() =>
      continuousArena(revenue, { durationSec: HOUR, stepSec: HOUR, agents: [] }),
    ).toThrow(/at least one agent/);
    expect(() =>
      continuousArena(revenue, { durationSec: HOUR + 1, stepSec: HOUR, agents: [spec] }),
    ).toThrow(/multiple of stepSec/);
    expect(() =>
      continuousArena(revenue, {
        durationSec: HOUR,
        stepSec: HOUR,
        agents: [{ ...spec, trancheWeight: 0n }],
      }),
    ).toThrow(/trancheWeight/);
  });

  it("holds its invariants over random rosters (property)", () => {
    const strategies = [
      () => uniformStatic(),
      () => fixedGrid(6 * HOUR, { lookbackSec: DAY }),
      () => randomRotator({ seed: "8" }),
      () => momentumChaser(),
      () => crowdingAvoider(),
    ];
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: strategies.length - 1 }), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.bigInt({ min: 1n, max: 10n ** 22n }),
        (picks, days, weight) => {
          const revenue = constantRevenue({ a: 100n * WAD, b: 10n * WAD, c: WAD });
          const result = continuousArena(revenue, {
            durationSec: days * DAY,
            stepSec: HOUR,
            cooldownSec: 6 * HOUR,
            crowd: staticCrowd(new Map([["b", 40n * WAD]])),
            agents: picks.map((pick, i) => ({
              id: `agent-${i}`,
              strategy: strategies[pick]!(),
              trancheCount: 1 + (i % 2),
              trancheWeight: weight,
            })),
          });
          expectConservation(result);
          for (const agent of result.agents) {
            for (let s = 1; s < agent.equity.length; s += 1) {
              expect(agent.equity[s]! >= agent.equity[s - 1]!).toBe(true);
            }
            for (const row of agent.allocationWeights) {
              let sum = 0n;
              for (const w of row) sum += w;
              expect(sum <= WAD).toBe(true);
            }
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  it("battle royale golden (exact, committed)", () => {
    const dataset = generateSyntheticDataset({ seed: 7n, poolCount: 4, epochCount: 8, kind: "regime", startTs: T0 });
    const revenue = revenueProcessFromDataset(dataset);
    const start = T0 + WEEK + 2 * HOUR;
    const crowd = reactiveHerd({ revenue, totalWeight: 1_000n * WAD, lagSeconds: WEEK, windowSec: WEEK });
    const model = createContinuousModel({
      revenue,
      startTime: start,
      cooldownSec: 2 * DAY,
      emissionRatePerSec: WAD,
      caps: { enabled: true },
    });
    const tranche = { trancheCount: 2, trancheWeight: 50n * WAD };
    const result = runArena(model, {
      startTime: start,
      durationSec: 5 * WEEK,
      stepSec: HOUR,
      sampleIntervalSec: 12 * HOUR,
      cooldownSec: 2 * DAY,
      crowd,
      crowdUpdateSec: DAY,
      agents: [
        { id: "grid48", strategy: fixedGrid48h({ lookbackSec: DAY }), ...tranche },
        { id: "carry", strategy: persistenceCarry({ lookbackSec: WEEK, buckets: 7 }), ...tranche },
        { id: "water", strategy: waterFilling({ lookbackSec: DAY }), ...tranche },
        { id: "greedy", strategy: continuousGreedy({ cadenceSec: HOUR, lookbackSec: DAY }), ...tranche },
        { id: "uniform", strategy: uniformStatic(), ...tranche },
        { id: "random", strategy: randomRotator({ seed: "7" }), ...tranche },
        { id: "chaser", strategy: momentumChaser(), ...tranche },
        { id: "ewma", strategy: ewmaForecast(), ...tranche },
        { id: "avoider", strategy: crowdingAvoider(), ...tranche },
        { id: "bandit", strategy: banditAllocator({ seed: "7" }), ...tranche },
      ],
    });
    expectConservation(result);

    const path = join(GOLDEN_DIR, "arena-battle-royale.json");
    const actual = toJsonValue({
      marketBenchmarkReturn: result.marketBenchmarkReturn,
      oracleReturn: result.oracleReturn ?? 0n,
      samples: result.times.length,
      agents: result.agents.map((agent) => ({
        id: agent.id,
        totalReturn: agent.totalReturn,
        returnVsMarket: agent.returnVsMarket,
        turnover: agent.turnover,
        rotations: agent.rotations,
        blockedSubmissions: agent.blockedSubmissions,
      })),
    });
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    }
    expect(existsSync(path), `missing golden ${path}, run with UPDATE_GOLDEN=1`).toBe(true);
    expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });
});
