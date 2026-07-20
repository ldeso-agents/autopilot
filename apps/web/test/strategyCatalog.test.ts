/** Config revival must be crash-proof: configs arrive from free-text form
 *  fields and hand-shareable URLs, so invalid entries fall back to factory
 *  defaults instead of throwing mid-run or silently corrupting the grid. */
import { describe, expect, it } from "vitest";
import { buildStrategy, reviveStrategyConfig } from "../src/lib/strategyCatalog.js";

describe("reviveStrategyConfig", () => {
  it("converts valid Wad decimal strings to bigint", () => {
    expect(reviveStrategyConfig({ alphaWad: "300000000000000000" })).toEqual({
      alphaWad: 300000000000000000n,
    });
  });

  it("drops invalid Wad strings instead of throwing BigInt SyntaxErrors", () => {
    expect(reviveStrategyConfig({ alphaWad: "0.3" })).toEqual({});
    expect(reviveStrategyConfig({ epsilonWad: "abc" })).toEqual({});
    expect(reviveStrategyConfig({ haircutWad: "" })).toEqual({});
    expect(reviveStrategyConfig({ sWad: "-5" })).toEqual({});
  });

  it("drops null and non-finite numerics (NaN survives share URLs as null)", () => {
    expect(reviveStrategyConfig({ cadenceSec: null })).toEqual({});
    expect(reviveStrategyConfig({ cadenceSec: Number.NaN })).toEqual({});
    expect(reviveStrategyConfig({ cadenceSec: Infinity })).toEqual({});
    expect(reviveStrategyConfig({ cadenceSec: 3600 })).toEqual({ cadenceSec: 3600 });
  });

  it("strips non-digits from seeds, falling back to the default when empty", () => {
    expect(reviveStrategyConfig({ seed: " 42 " })).toEqual({ seed: "42" });
    expect(reviveStrategyConfig({ seed: "abc" })).toEqual({});
    expect(reviveStrategyConfig({ seed: "12ab3" })).toEqual({ seed: "123" });
    expect(reviveStrategyConfig({ seed: "7" })).toEqual({ seed: "7" });
  });

  it("buildStrategy survives hostile configs with factory defaults", () => {
    const strategy = buildStrategy("banditAllocator", {
      cadenceSec: null,
      seed: "not-a-number",
      epsilonWad: "0.1",
      alphaWad: Number.NaN as unknown as string,
    });
    expect(strategy.cadenceSec).toBe(21_600); // default survived the garbage
    const ewma = buildStrategy("ewmaForecast", { alphaWad: "0.3", cadenceSec: Number.NaN });
    expect(ewma.cadenceSec).toBe(21_600);
  });
});
