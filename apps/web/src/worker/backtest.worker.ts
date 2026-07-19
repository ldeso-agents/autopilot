/// <reference lib="webworker" />
/**
 * Backtests and arena runs execute off the main thread; the UI stays
 * responsive. Input is the full RunConfig / ArenaRunConfig (+ historical
 * dataset JSON when selected); output is the display-ready result (bigints
 * already converted, see serialize.ts).
 */
import { buildAndRun } from "../lib/buildRun.js";
import { buildAndRunArena } from "../lib/buildArena.js";
import {
  toDisplayArenaResult,
  toDisplayResult,
  type WorkerRequest,
  type WorkerResponse,
} from "../lib/serialize.js";
import type { RunConfig } from "../lib/runConfig.js";
import type { ArenaRunConfig } from "../lib/arenaConfig.js";

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== "run" && msg.type !== "arena") return;
  const started = performance.now();
  try {
    let response: WorkerResponse;
    if (msg.type === "run") {
      const run = buildAndRun(msg.config as RunConfig, msg.historical);
      response = {
        type: "done",
        seq: msg.seq,
        result: toDisplayResult(run),
        elapsedMs: performance.now() - started,
      };
    } else {
      const run = buildAndRunArena(msg.config as ArenaRunConfig, msg.historical);
      response = {
        type: "arenaDone",
        seq: msg.seq,
        result: toDisplayArenaResult(run),
        elapsedMs: performance.now() - started,
      };
    }
    self.postMessage(response);
  } catch (err) {
    const response: WorkerResponse = {
      type: "error",
      seq: msg.seq,
      request: msg.type,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
