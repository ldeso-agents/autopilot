/** The arena URL round-trip must be exact, same contract as `#run=`: a
 *  shared link reproduces the identical roster on a deterministic core. */
import { describe, expect, it } from "vitest";
import {
  ARENA_PRESETS,
  DEFAULT_ARENA,
  MAX_AGENTS,
  arenaConfigFromHash,
  arenaConfigToHash,
  decodeArenaConfig,
  encodeArenaConfig,
  matchArenaPreset,
} from "../src/lib/arenaConfig.js";

describe("arena-config URL serialization", () => {
  it("round-trips the default arena exactly", () => {
    expect(decodeArenaConfig(encodeArenaConfig(DEFAULT_ARENA))).toEqual(DEFAULT_ARENA);
  });

  it("round-trips every preset through the full hash", () => {
    for (const preset of ARENA_PRESETS) {
      const hash = arenaConfigToHash(preset.config);
      expect(arenaConfigFromHash(hash), preset.id).toEqual(preset.config);
    }
  });

  it("presets respect the roster ceiling and have unique agent ids", () => {
    for (const preset of ARENA_PRESETS) {
      expect(preset.config.agents.length).toBeLessThanOrEqual(MAX_AGENTS);
      const ids = preset.config.agents.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("hash payload is URL-safe base64 only", () => {
    expect(arenaConfigToHash(DEFAULT_ARENA)).toMatch(/^#arena=[A-Za-z0-9_-]+$/);
  });

  it("matches presets exactly and rejects near-misses", () => {
    for (const preset of ARENA_PRESETS) {
      expect(matchArenaPreset(preset.config)).toBe(preset.id);
    }
    expect(matchArenaPreset(DEFAULT_ARENA)).toBe("battle-royale");
    const custom = {
      ...DEFAULT_ARENA,
      agents: [{ ...DEFAULT_ARENA.agents[0]!, trancheTokens: 123_456 }],
    };
    expect(matchArenaPreset(custom)).toBeNull();
  });

  it("rejects garbage hashes without throwing", () => {
    expect(arenaConfigFromHash("#arena=%%%")).toBeUndefined();
    expect(arenaConfigFromHash("#arena=aGVsbG8")).toBeUndefined(); // valid b64, not a config
    expect(arenaConfigFromHash("#run=aGVsbG8")).toBeUndefined();
    expect(arenaConfigFromHash("#other")).toBeUndefined();
  });
});
