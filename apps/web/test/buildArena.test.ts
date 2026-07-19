/** Arena build smoke: the battle-royale preset builds, runs on synthetic
 *  data, serializes to floats, and replays identically (URL contract). */
import { describe, expect, it } from "vitest";
import { buildAndRunArena } from "../src/lib/buildArena.js";
import { toDisplayArenaResult } from "../src/lib/serialize.js";
import { DEFAULT_ARENA, MAX_AGENTS } from "../src/lib/arenaConfig.js";

describe("buildAndRunArena", () => {
  it("runs the battle royale and produces aligned display series", { timeout: 60_000 }, () => {
    const run = buildAndRunArena(DEFAULT_ARENA, null);
    expect(run.result.agents).toHaveLength(DEFAULT_ARENA.agents.length);

    const display = toDisplayArenaResult(run);
    expect(display.agents).toHaveLength(DEFAULT_ARENA.agents.length);
    expect(display.marketBenchmark).toHaveLength(display.times.length);
    expect(display.oracleBenchmark).toHaveLength(display.times.length);
    expect(display.poolNames).toHaveLength(display.pools.length);
    for (const agent of display.agents) {
      expect(agent.equity).toHaveLength(display.times.length);
      expect(agent.allocationWeights).toHaveLength(display.times.length);
      expect(agent.equity.every((n) => typeof n === "number" && n >= 0)).toBe(true);
      // equal stakes in the default roster
      expect(agent.weightShare).toBeCloseTo(1 / DEFAULT_ARENA.agents.length, 10);
    }
    // labels flow through from the config
    expect(display.agents.map((a) => a.label)).toEqual(DEFAULT_ARENA.agents.map((a) => a.label));
  });

  it("replays identically from the same config (fresh everything)", { timeout: 60_000 }, () => {
    const a = toDisplayArenaResult(buildAndRunArena(DEFAULT_ARENA, null));
    const b = toDisplayArenaResult(buildAndRunArena(DEFAULT_ARENA, null));
    expect(a).toEqual(b);
  });

  it("rejects oversized rosters", () => {
    const oversized = {
      ...DEFAULT_ARENA,
      agents: Array.from({ length: MAX_AGENTS + 1 }, (_, i) => ({
        ...DEFAULT_ARENA.agents[0]!,
        id: `agent-${i + 1}`,
      })),
    };
    expect(() => buildAndRunArena(oversized, null)).toThrow(/at most/);
  });
});
