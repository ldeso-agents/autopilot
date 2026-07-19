import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isqrt, sumBig, WAD } from "../src/math/fixed.js";
import type { MarketState, TargetAllocation } from "../src/model/types.js";
import { WEEK } from "../src/model/types.js";
import type { TrancheState } from "../src/scheduler/scheduler.js";
import {
  continuousGreedy,
  marginalYield,
} from "../src/strategies/continuousGreedy.js";
import { fixedGrid, fixedGrid48h, fixedGridWeekly } from "../src/strategies/fixedGrid.js";
import { normalizeToWad } from "../src/strategies/normalize.js";
import {
  persistenceCarry,
  persistenceFactor,
} from "../src/strategies/persistenceCarry.js";
import { portfolioWeightOnPool, type Portfolio } from "../src/strategies/types.js";
import { waterFill, waterFilling, WATER_FILL_SCALE } from "../src/strategies/waterFilling.js";
import { uniformStatic } from "../src/strategies/uniformStatic.js";
import { randomRotator } from "../src/strategies/randomRotator.js";
import { momentumChaser } from "../src/strategies/momentumChaser.js";
import { ewmaForecast } from "../src/strategies/ewmaForecast.js";
import { crowdingAvoider } from "../src/strategies/crowdingAvoider.js";
import { banditAllocator } from "../src/strategies/banditAllocator.js";

/** Fake market state: cumulative revenue via constant per-second rates. */
function fakeState(
  rates: Record<string, bigint>,
  weights: Record<string, bigint>,
  now = 1_000_000_000,
): MarketState {
  const pools = Object.keys(rates);
  return {
    now,
    pools,
    trailingRevenue: (pool, windowSec) => (rates[pool] ?? 0n) * BigInt(windowSec),
    poolWeight: (pool) => weights[pool] ?? 0n,
    totalWeight: () => sumBig(Object.values(weights)),
  };
}

function makePortfolio(tranches: TrancheState[], cooldownSec = 172_800): Portfolio {
  return {
    tranches,
    totalWeight: sumBig(tranches.map((t) => t.positionWeight)),
    cooldownSec,
  };
}

const freeTranche = (id: string, weight = WAD): TrancheState => ({
  id,
  positionWeight: weight,
  lastActionAt: 0,
  allocation: new Map(),
});

function expectSumsToWad(target: TargetAllocation): void {
  expect(sumBig([...target.values()])).toBe(WAD);
}

describe("normalizeToWad", () => {
  it("always sums exactly to WAD (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 4 }), fc.bigInt({ min: 0n, max: 10n ** 30n })), {
          minLength: 1,
          maxLength: 8,
        }),
        (pairs) => {
          expectSumsToWad(normalizeToWad(new Map(pairs)));
        },
      ),
    );
  });
});

describe("fixedGrid", () => {
  it("allocates proportional to trailing revenue", () => {
    const strategy = fixedGridWeekly();
    const state = fakeState({ a: 30n, b: 10n }, { a: 0n, b: 0n });
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expectSumsToWad(target);
    expect(target.get("a")).toBe((WAD * 3n) / 4n);
    expect(target.get("b")).toBe(WAD / 4n);
  });

  it("weekly grid phases its cadence submitOffsetSec before the flip", () => {
    const strategy = fixedGridWeekly({ submitOffsetSec: 3_600 });
    expect(strategy.cadenceSec).toBe(WEEK);
    expect(strategy.phaseSec).toBe(WEEK - 3_600);
    expect(strategy.name).toBe("FixedGridWeekly");
  });

  it("short grids share the factory", () => {
    expect(fixedGrid48h().cadenceSec).toBe(172_800);
    expect(fixedGrid(60).cadenceSec).toBe(60);
    expect(fixedGrid(60).phaseSec).toBe(0);
    expect(() => fixedGrid(0)).toThrow(/positive integer/);
  });

  it("falls back to uniform when there is no revenue anywhere", () => {
    const strategy = fixedGrid48h();
    const state = fakeState({ a: 0n, b: 0n }, { a: 0n, b: 0n });
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expect(target.get("a")).toBe(WAD / 2n);
    expect(target.get("b")).toBe(WAD / 2n);
  });

  it("respects the pool allowlist", () => {
    const strategy = fixedGrid48h({ pools: ["a", "c"] });
    const state = fakeState({ a: 5n, b: 100n, c: 5n }, {});
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expect(target.has("b")).toBe(false);
    expectSumsToWad(target);
  });
});

describe("persistenceFactor", () => {
  it("gives no haircut to perfectly steady revenue", () => {
    expect(persistenceFactor([10n, 10n, 10n], WAD / 2n)).toBe(WAD);
  });

  it("haircuts proportional to MAD/mean, capped at the full haircut", () => {
    // buckets [0, 20]: mean 10, MAD 10 -> vol 100% -> full haircut.
    expect(persistenceFactor([0n, 20n], WAD / 2n)).toBe(WAD / 2n);
    // buckets [5, 15]: mean 10, MAD 5 -> vol 50% -> half the haircut.
    expect(persistenceFactor([5n, 15n], WAD / 2n)).toBe(WAD - WAD / 4n);
    // zero mean -> treated as fully volatile.
    expect(persistenceFactor([0n, 0n], WAD / 2n)).toBe(WAD / 2n);
  });
});

describe("persistenceCarry", () => {
  it("downweights volatile pools relative to plain trailing revenue", () => {
    const strategy = persistenceCarry({ lookbackSec: 700, buckets: 7, sWad: 0n });
    // Steady pool a; pool b same total trailing revenue but all in one bucket.
    const state: MarketState = {
      now: 1_000_000_000,
      pools: ["a", "b"],
      trailingRevenue: (pool, windowSec) => {
        if (pool === "a") return 10n * BigInt(windowSec);
        // b: 7000 total, all accrued in the most recent 100s bucket.
        return BigInt(Math.min(windowSec, 100)) * 70n;
      },
      poolWeight: () => 0n,
      totalWeight: () => 0n,
    };
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expectSumsToWad(target);
    expect(target.get("a")! > target.get("b")!).toBe(true);
  });

  it("applies (s,S): holds the last target until the L1 gap exceeds s", () => {
    const strategy = persistenceCarry({ sWad: WAD / 4n, lookbackSec: 700, buckets: 7 });
    const portfolio = makePortfolio([freeTranche("t0")], 0);
    const first = strategy.propose(fakeState({ a: 10n, b: 10n }, {}), portfolio);
    // Small shift (below s = 25pp): stays on the previous target.
    const second = strategy.propose(fakeState({ a: 11n, b: 10n }, {}), portfolio);
    expect(second).toEqual(first);
    // Large shift: moves fully to the new ideal (S).
    const third = strategy.propose(fakeState({ a: 100n, b: 1n }, {}), portfolio);
    expect(third).not.toEqual(first);
    expect(third.get("a")! > (WAD * 9n) / 10n).toBe(true);
  });

  it("does not spend the threshold while all tranches are locked", () => {
    const strategy = persistenceCarry({ sWad: 0n, lookbackSec: 700, buckets: 7 });
    const locked = makePortfolio(
      [{ id: "t0", positionWeight: WAD, lastActionAt: 999_999_999, allocation: new Map() }],
      172_800,
    );
    const first = strategy.propose(fakeState({ a: 10n, b: 10n }, {}), locked);
    const second = strategy.propose(fakeState({ a: 100n, b: 1n }, {}), locked);
    expect(second).toEqual(first); // locked: reaffirm last target
  });
});

describe("waterFill (exact allocator)", () => {
  const bigArb = fc.bigInt({ min: 0n, max: 10n ** 30n });

  it("conserves the budget exactly (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(bigArb, bigArb), { minLength: 1, maxLength: 6 }),
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        (rw, budget) => {
          const R = rw.map(([r]) => r);
          const W = rw.map(([, w]) => w);
          const { weights } = waterFill(R, W, budget);
          expect(sumBig(weights)).toBe(budget);
          for (const w of weights) expect(w >= 0n).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("satisfies the bisection invariant: sum(λ) <= budget < sum(λ-1)", () => {
    const wAt = (R: bigint[], W: bigint[], lambda: bigint): bigint =>
      sumBig(
        R.map((r, i) => {
          const p = r * W[i]!;
          if (p === 0n) return 0n;
          const root = isqrt((p * WATER_FILL_SCALE) / lambda);
          return root > W[i]! ? root - W[i]! : 0n;
        }),
      );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.bigInt({ min: 1n, max: 10n ** 24n }), fc.bigInt({ min: 1n, max: 10n ** 24n })), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.bigInt({ min: 1n, max: 10n ** 24n }),
        (rw, budget) => {
          const R = rw.map(([r]) => r);
          const W = rw.map(([, w]) => w);
          const { lambda } = waterFill(R, W, budget);
          expect(wAt(R, W, lambda) <= budget).toBe(true);
          if (lambda > 1n) expect(wAt(R, W, lambda - 1n) > budget).toBe(true);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("equalizes marginal yield: puts more into higher R pools", () => {
    const { weights } = waterFill([100n * WAD, 10n * WAD], [WAD, WAD], 10n * WAD);
    expect(weights[0]! > weights[1]!).toBe(true);
    expect(sumBig(weights)).toBe(10n * WAD);
  });

  it("symmetric pools split the budget symmetrically (up to remainder policy)", () => {
    const { weights } = waterFill([WAD, WAD], [WAD, WAD], 2n * WAD);
    const diff = weights[0]! - weights[1]!;
    expect(diff >= 0n ? diff : -diff).toBeLessThanOrEqual(1n);
  });

  it("handles degenerate inputs", () => {
    expect(waterFill([], [], 0n).weights).toEqual([]);
    expect(waterFill([WAD], [WAD], 0n).weights).toEqual([0n]);
    // Zero R everywhere: whole budget goes to index 0 (largest R tie -> lowest index).
    expect(waterFill([0n, 0n], [WAD, WAD], 7n).weights).toEqual([7n, 0n]);
    expect(() => waterFill([1n], [1n, 2n], 1n)).toThrow(/length mismatch/);
    expect(() => waterFill([1n], [1n], -1n)).toThrow(/negative/);
  });

  it("documents its iteration bound: iterations === bitLength(λ_hi)", () => {
    const { iterations } = waterFill([WAD], [WAD], WAD);
    // λ_hi = R*scale/W + 1 = 1e36 + 1 -> ~120 bits.
    expect(iterations).toBeGreaterThan(100);
    expect(iterations).toBeLessThan(140);
  });
});

describe("waterFilling strategy", () => {
  it("proposes a normalized target favoring under-crowded revenue", () => {
    const strategy = waterFilling();
    // Same revenue, but pool b is heavily crowded.
    const state = fakeState({ a: WAD, b: WAD }, { a: 10n * WAD, b: 1_000n * WAD });
    const target = strategy.propose(state, makePortfolio([freeTranche("t0", 100n * WAD)]));
    expectSumsToWad(target);
    expect(target.get("a")! > target.get("b")!).toBe(true);
  });

  it("subtracts our own tranche weight from the external weight", () => {
    const tranche: TrancheState = {
      id: "t0",
      positionWeight: 10n * WAD,
      lastActionAt: 0,
      allocation: new Map([["a", WAD]]),
    };
    expect(portfolioWeightOnPool(makePortfolio([tranche]), "a")).toBe(10n * WAD);
    expect(portfolioWeightOnPool(makePortfolio([tranche]), "b")).toBe(0n);
  });
});

describe("continuousGreedy", () => {
  it("marginalYield is exact and handles zero denominators", () => {
    expect(marginalYield(WAD, 0n, 0n)).toBe(0n);
    expect(marginalYield(4n * WAD, WAD, WAD)).toBe(WAD); // 4W*W*WAD/(2W)^2 = WAD
  });

  it("moves when the yield gap exceeds threshold + cost", () => {
    const strategy = continuousGreedy({ thresholdWad: WAD / 100n, costWad: 0n });
    const tranche: TrancheState = {
      id: "t0",
      positionWeight: WAD,
      lastActionAt: 0,
      allocation: new Map([["b", WAD]]), // we sit in the bad pool
    };
    const portfolio = makePortfolio([tranche], 0);
    const first = strategy.propose(fakeState({ a: WAD, b: WAD }, { a: WAD, b: WAD }), portfolio);
    expectSumsToWad(first);
    // Massive gap: pool a revenue explodes -> re-proposes toward a.
    const second = strategy.propose(
      fakeState({ a: 1_000n * WAD, b: 1n }, { a: WAD, b: WAD }),
      portfolio,
    );
    expect(second.get("a")! > second.get("b")!).toBe(true);
  });

  it("holds the last target while every tranche is locked", () => {
    const strategy = continuousGreedy({ thresholdWad: 0n, costWad: 0n });
    const locked: TrancheState = {
      id: "t0",
      positionWeight: WAD,
      lastActionAt: 999_999_999,
      allocation: new Map([["b", WAD]]),
    };
    const portfolio = makePortfolio([locked], 172_800);
    const first = strategy.propose(fakeState({ a: WAD, b: WAD }, { a: WAD, b: WAD }), portfolio);
    const second = strategy.propose(
      fakeState({ a: 1_000n * WAD, b: 1n }, { a: WAD, b: WAD }),
      portfolio,
    );
    expect(second).toEqual(first);
  });

  it("defaults to one Base block cadence", () => {
    expect(continuousGreedy().cadenceSec).toBe(2);
  });
});

describe("uniformStatic", () => {
  it("splits equally over the universe and re-proposes identically", () => {
    const strategy = uniformStatic();
    const state = fakeState({ a: 30n, b: 10n }, { a: WAD, b: 0n });
    const first = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expectSumsToWad(first);
    expect(first.get("a")).toBe(WAD / 2n);
    expect(first.get("b")).toBe(WAD / 2n);
    expect(strategy.propose(state, makePortfolio([freeTranche("t0")]))).toEqual(first);
    expect(strategy.cadenceSec).toBe(WEEK);
  });

  it("respects the pool allowlist", () => {
    const strategy = uniformStatic({ pools: ["a", "c"] });
    const state = fakeState({ a: 5n, b: 100n, c: 5n }, {});
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expect(target.has("b")).toBe(false);
    expectSumsToWad(target);
  });
});

describe("randomRotator", () => {
  it("draws exactly poolsPerDraw distinct pools, equal split", () => {
    const strategy = randomRotator({ seed: "3", poolsPerDraw: 2 });
    const state = fakeState({ a: 1n, b: 1n, c: 1n, d: 1n }, {});
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expectSumsToWad(target);
    const nonZero = [...target.values()].filter((v) => v > 0n);
    expect(nonZero.length).toBe(2);
  });

  it("clamps poolsPerDraw to the universe size", () => {
    const strategy = randomRotator({ seed: "3", poolsPerDraw: 10 });
    const target = strategy.propose(fakeState({ a: 1n, b: 1n }, {}), makePortfolio([freeTranche("t0")]));
    expect([...target.values()].filter((v) => v > 0n).length).toBe(2);
  });

  it("replays identically from the same seed (fresh instance)", () => {
    const state = fakeState({ a: 1n, b: 1n, c: 1n, d: 1n, e: 1n }, {});
    const run = (seed: string) => {
      const strategy = randomRotator({ seed, poolsPerDraw: 2 });
      const draws: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
        draws.push([...target.entries()].filter(([, v]) => v > 0n).map(([p]) => p).sort().join(","));
      }
      return draws;
    };
    expect(run("11")).toEqual(run("11"));
    expect(run("11")).not.toEqual(run("12"));
  });

  it("rejects a non-positive poolsPerDraw", () => {
    expect(() => randomRotator({ poolsPerDraw: 0 })).toThrow(/positive integer/);
  });
});

describe("momentumChaser", () => {
  it("follows the standing crowd on the first call, uniform on an empty market", () => {
    const strategy = momentumChaser();
    const crowded = strategy.propose(
      fakeState({ a: 0n, b: 0n }, { a: 3n * WAD, b: WAD }),
      makePortfolio([freeTranche("t0")]),
    );
    expect(crowded.get("a")).toBe((WAD * 3n) / 4n);
    const fresh = momentumChaser();
    const uniform = fresh.propose(fakeState({ a: 0n, b: 0n }, { a: 0n, b: 0n }), makePortfolio([freeTranche("t0")]));
    expect(uniform.get("a")).toBe(WAD / 2n);
  });

  it("chases weight inflow one call late", () => {
    const strategy = momentumChaser();
    const portfolio = makePortfolio([freeTranche("t0")]);
    strategy.propose(fakeState({ a: 0n, b: 0n }, { a: WAD, b: WAD }), portfolio);
    // All new weight went to b since the last look: chases b exclusively.
    const target = strategy.propose(fakeState({ a: 0n, b: 0n }, { a: WAD, b: 5n * WAD }), portfolio);
    expect(target.get("b")).toBe(WAD);
    expect(target.get("a")).toBe(0n);
  });

  it("falls back to the standing crowd when nothing flowed in", () => {
    const strategy = momentumChaser();
    const portfolio = makePortfolio([freeTranche("t0")]);
    strategy.propose(fakeState({ a: 0n, b: 0n }, { a: 3n * WAD, b: WAD }), portfolio);
    const target = strategy.propose(fakeState({ a: 0n, b: 0n }, { a: 3n * WAD, b: WAD }), portfolio);
    expect(target.get("a")).toBe((WAD * 3n) / 4n);
  });
});

describe("ewmaForecast", () => {
  it("allocates proportional to revenue under constant rates", () => {
    const strategy = ewmaForecast();
    const state = fakeState({ a: 30n, b: 10n }, {});
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expectSumsToWad(target);
    expect(target.get("a")).toBe((WAD * 3n) / 4n);
  });

  it("smooths a rate change: allocation lags the new proportions", () => {
    const strategy = ewmaForecast({ alphaWad: WAD / 2n });
    const portfolio = makePortfolio([freeTranche("t0")]);
    strategy.propose(fakeState({ a: 10n, b: 10n }, {}), portfolio);
    // Rates flip to 30/10; with alpha=0.5 the EWMA only moves halfway.
    const target = strategy.propose(fakeState({ a: 30n, b: 10n }, {}), portfolio);
    expect(target.get("a")! > WAD / 2n).toBe(true);
    expect(target.get("a")! < (WAD * 3n) / 4n).toBe(true);
    // alpha = WAD reacts instantly.
    const instant = ewmaForecast({ alphaWad: WAD });
    instant.propose(fakeState({ a: 10n, b: 10n }, {}), portfolio);
    expect(instant.propose(fakeState({ a: 30n, b: 10n }, {}), portfolio).get("a")).toBe((WAD * 3n) / 4n);
  });

  it("rejects an out-of-range alpha", () => {
    expect(() => ewmaForecast({ alphaWad: WAD + 1n })).toThrow(/alphaWad/);
  });
});

describe("crowdingAvoider", () => {
  it("prefers the less crowded pool at equal revenue", () => {
    const strategy = crowdingAvoider();
    const state = fakeState({ a: WAD, b: WAD }, { a: 10n * WAD, b: 1_000n * WAD });
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expectSumsToWad(target);
    expect(target.get("a")! > target.get("b")!).toBe(true);
  });

  it("subtracts its own standing weight from the divisor", () => {
    const strategy = crowdingAvoider();
    const tranche: TrancheState = {
      id: "t0",
      positionWeight: 90n * WAD,
      lastActionAt: 0,
      allocation: new Map([["a", WAD]]),
    };
    // Pool a's weight is 100 but 90 is ours -> external 10, same as b's.
    const state = fakeState({ a: WAD, b: WAD }, { a: 100n * WAD, b: 10n * WAD });
    const target = strategy.propose(state, makePortfolio([tranche]));
    expect(target.get("a")).toBe(target.get("b"));
  });

  it("floors the divisor on empty pools", () => {
    const strategy = crowdingAvoider({ floorWeightWad: 5n * WAD });
    const state = fakeState({ a: WAD, b: WAD }, { a: 0n, b: 10n * WAD });
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    // a scored at revenue/5, b at revenue/10: a preferred but finite.
    expect(target.get("a")! > target.get("b")!).toBe(true);
    expect(() => crowdingAvoider({ floorWeightWad: 0n })).toThrow(/positive/);
  });
});

describe("banditAllocator", () => {
  it("proposes uniform before any observation", () => {
    const strategy = banditAllocator();
    const target = strategy.propose(fakeState({ a: 10n, b: 10n }, {}), makePortfolio([freeTranche("t0")]));
    expect(target.get("a")).toBe(WAD / 2n);
  });

  it("exploits the argmax estimate at epsilon 0", () => {
    const strategy = banditAllocator({ epsilonWad: 0n });
    const held: TrancheState = {
      id: "t0",
      positionWeight: WAD,
      lastActionAt: 0,
      allocation: new Map([["a", WAD / 2n], ["b", WAD / 2n]]),
    };
    const portfolio = makePortfolio([held]);
    const state = fakeState({ a: 30n, b: 10n }, { a: WAD, b: WAD });
    const target = strategy.propose(state, portfolio);
    expect(target.get("a")).toBe(WAD);
    expect(target.size).toBe(1);
  });

  it("always explores at epsilon WAD, still summing to WAD", () => {
    const strategy = banditAllocator({ epsilonWad: WAD, seed: "5" });
    const held: TrancheState = {
      id: "t0",
      positionWeight: WAD,
      lastActionAt: 0,
      allocation: new Map([["a", WAD]]),
    };
    for (let i = 0; i < 5; i += 1) {
      const target = strategy.propose(
        fakeState({ a: 30n, b: 10n, c: 1n }, { a: WAD, b: WAD, c: WAD }),
        makePortfolio([held]),
      );
      expectSumsToWad(target);
      expect(target.size).toBe(1);
    }
  });

  it("replays identically from the same seed (fresh instance)", () => {
    const held: TrancheState = {
      id: "t0",
      positionWeight: WAD,
      lastActionAt: 0,
      allocation: new Map([["a", WAD]]),
    };
    const run = (seed: string) => {
      const strategy = banditAllocator({ seed, epsilonWad: WAD / 2n });
      const picks: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        const target = strategy.propose(
          fakeState({ a: 3n, b: 2n, c: 1n }, { a: WAD, b: WAD, c: WAD }),
          makePortfolio([held]),
        );
        picks.push([...target.keys()].join(","));
      }
      return picks;
    };
    expect(run("9")).toEqual(run("9"));
  });

  it("rejects out-of-range epsilon and alpha", () => {
    expect(() => banditAllocator({ epsilonWad: WAD + 1n })).toThrow(/epsilonWad/);
    expect(() => banditAllocator({ alphaWad: -1n })).toThrow(/alphaWad/);
  });
});

describe("new strategies: proposals always sum to WAD (property)", () => {
  const factories: Record<string, () => ReturnType<typeof uniformStatic>> = {
    uniformStatic: () => uniformStatic(),
    randomRotator: () => randomRotator({ seed: "2" }),
    momentumChaser: () => momentumChaser(),
    ewmaForecast: () => ewmaForecast(),
    crowdingAvoider: () => crowdingAvoider(),
    banditAllocator: () => banditAllocator({ seed: "2" }),
  };
  for (const [name, make] of Object.entries(factories)) {
    it(name, () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(
              fc.string({ minLength: 1, maxLength: 4 }),
              fc.bigInt({ min: 0n, max: 10n ** 24n }),
              fc.bigInt({ min: 0n, max: 10n ** 24n }),
            ),
            { minLength: 1, maxLength: 6 },
          ),
          (rows) => {
            const rates = Object.fromEntries(rows.map(([p, r]) => [p, r]));
            const weights = Object.fromEntries(rows.map(([p, , w]) => [p, w]));
            const strategy = make();
            const target = strategy.propose(fakeState(rates, weights), makePortfolio([freeTranche("t0")]));
            expectSumsToWad(target);
          },
        ),
        { numRuns: 40 },
      );
    });
  }
});
