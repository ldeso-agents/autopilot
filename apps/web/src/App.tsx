import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigPanel } from "./components/ConfigPanel.js";
import { Guide } from "./components/Guide.js";
import { Theory } from "./components/Theory.js";
import { Strategies } from "./components/Strategies.js";
import { Vocabulary } from "./components/Vocabulary.js";
import { Logbook } from "./components/Logbook.js";
import { Gauges } from "./components/Gauges.js";
import { EquityChart } from "./components/EquityChart.js";
import { AllocationHeatmap, type HeatmapView } from "./components/AllocationHeatmap.js";
import { EarningsHeatmap } from "./components/EarningsHeatmap.js";
import { ArenaPanel } from "./components/ArenaPanel.js";
import { ArenaEquityChart } from "./components/ArenaEquityChart.js";
import { Leaderboard } from "./components/Leaderboard.js";
import {
  DEFAULT_RUN,
  PRESETS,
  configFromHash,
  configToHash,
  type RunConfig,
} from "./lib/runConfig.js";
import {
  ARENA_PRESETS,
  DEFAULT_ARENA,
  arenaConfigFromHash,
  arenaConfigToHash,
  matchArenaPreset,
  type ArenaRunConfig,
} from "./lib/arenaConfig.js";
import type { DisplayArenaResult, DisplayResult, WorkerResponse } from "./lib/serialize.js";

const STALE_AFTER_DAYS = 14;
const DEBOUNCE_MS = 300;

/** The doc pages, in reading order. Each is a real path under the site base
 *  (e.g. /theory/), so links behave like an ordinary multi-page site. The
 *  console lives at the base path; its run config still travels in the
 *  `#run=` hash. The arena is its own page at /arena/ with an `#arena=`
 *  hash. Static hosts serve a per-page index.html + a 404.html copy of the
 *  SPA (see vite.config), so deep links resolve without a server. */
type DocView = "theory" | "strategies" | "guide" | "vocabulary" | "logbook";
const DOC_PAGES: { view: DocView; segment: string; label: string }[] = [
  { view: "theory", segment: "theory", label: "theory" },
  { view: "strategies", segment: "strategies", label: "strategies" },
  { view: "guide", segment: "guide", label: "guide" },
  { view: "vocabulary", segment: "vocabulary", label: "vocabulary" },
  { view: "logbook", segment: "logbook", label: "logbook" },
];
type View = "console" | "arena" | DocView;

/** Vite's configured base path ("/" in dev, "/<repo>/" on Pages). */
const BASE = import.meta.env.BASE_URL;

/** The path segment below BASE, trailing slashes stripped ("" = console). */
function currentSegment(): string {
  let p = location.pathname;
  p = p.startsWith(BASE) ? p.slice(BASE.length) : p.replace(/^\//, "");
  return p.replace(/\/+$/, "");
}
function viewFromPath(): View {
  const segment = currentSegment();
  if (segment === "arena") return "arena";
  const page = DOC_PAGES.find((d) => d.segment === segment);
  return page ? page.view : "console";
}
function pageUrl(view: DocView): string {
  return BASE + DOC_PAGES.find((d) => d.view === view)!.segment + "/";
}
/** Console URL at the base path, carrying the run hash (e.g. "#run=…"). */
function consoleUrl(hash = ""): string {
  return BASE + hash;
}
/** Arena URL at /arena/, carrying the roster hash (e.g. "#arena=…"). */
function arenaUrl(hash = ""): string {
  return BASE + "arena/" + hash;
}

/** Strategy / market-bench / revenue-bench switch on both heat-map panels; the
 *  controls share one state so the maps always show the same portfolio. */
function ViewToggle({
  view,
  onChange,
}: {
  view: HeatmapView;
  onChange: (view: HeatmapView) => void;
}) {
  return (
    <div className="seg-toggle" role="group" aria-label="heatmap portfolio">
      {(["strategy", "market", "revenue"] as const).map((v) => (
        <button key={v} className={view === v ? "active" : ""} onClick={() => onChange(v)}>
          {v === "strategy" ? "strategy" : v === "market" ? "market bench" : "revenue bench"}
        </button>
      ))}
    </div>
  );
}

/** Placard suffix for the non-strategy heat-map views. */
function viewSuffix(view: HeatmapView): string {
  if (view === "market") return ": market benchmark";
  if (view === "revenue") return ": revenue benchmark (foresight)";
  return "";
}

/** Days of dataset age past the staleness threshold, or null when fresh or
 *  not applicable (synthetic data carries no real generation time). */
function stalenessDays(dataKind: string, generatedAt: string | undefined): number | null {
  if (dataKind !== "historical" || !generatedAt) return null;
  const age = Date.now() - Date.parse(generatedAt);
  if (!Number.isFinite(age)) return null;
  const ageDays = age / 86_400_000;
  return ageDays > STALE_AFTER_DAYS ? Math.floor(ageDays) : null;
}

/** Live replay state: the last good result stays on the instruments while a
 *  newer run computes (or a half-typed config errors), no flicker, no button. */
interface LiveState<R> {
  result: R | null;
  elapsedMs: number;
  running: boolean;
  error: string | null;
}

export function App() {
  const [config, setConfig] = useState<RunConfig>(() => configFromHash(location.hash) ?? DEFAULT_RUN);
  const [arenaConfig, setArenaConfig] = useState<ArenaRunConfig>(
    () => arenaConfigFromHash(location.hash) ?? DEFAULT_ARENA,
  );
  const [view, setView] = useState<View>(() => viewFromPath());
  const [heatmapView, setHeatmapView] = useState<HeatmapView>("strategy");

  // browser back/forward: resync the page from the URL, and the visible
  // page's config from its hash. In-app navigation uses pushState below.
  useEffect(() => {
    const onPop = () => {
      const v = viewFromPath();
      setView(v);
      if (v === "console") {
        const c = configFromHash(location.hash);
        if (c) setConfig(c);
      } else if (v === "arena") {
        const c = arenaConfigFromHash(location.hash);
        if (c) {
          setArenaConfig(c);
          setActiveArenaPreset(matchArenaPreset(c));
        }
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [live, setLive] = useState<LiveState<DisplayResult>>({ result: null, elapsedMs: 0, running: false, error: null });
  const [arenaLive, setArenaLive] = useState<LiveState<DisplayArenaResult>>({ result: null, elapsedMs: 0, running: false, error: null });
  const [activePreset, setActivePreset] = useState<string | null>(null);
  // derived from the loaded config, never assumed: a shared custom #arena=
  // link must not light up a preset button it doesn't match
  const [activeArenaPreset, setActiveArenaPreset] = useState<string | null>(() =>
    matchArenaPreset(arenaConfigFromHash(location.hash) ?? DEFAULT_ARENA),
  );
  const [copied, setCopied] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const datasetRef = useRef<unknown | null>(null);
  // generation counter: responses older than the latest request are dropped
  const seqRef = useRef(0);

  const busyRef = useRef(false);
  // per-kind key of the last successfully computed config: a re-fire whose
  // config already produced the on-screen result (e.g. a console↔arena view
  // switch) skips the worker instead of recomputing or cancelling anything
  const lastGoodKeyRef = useRef<{ run: string | null; arena: string | null }>({ run: null, arena: null });
  const postedRef = useRef<{ seq: number; kind: "run" | "arena"; key: string } | null>(null);

  const spawnWorker = useCallback(() => {
    const worker = new Worker(new URL("./worker/backtest.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.seq !== seqRef.current) return; // stale run, a newer config superseded it
      busyRef.current = false;
      if (msg.type === "done") {
        if (postedRef.current?.seq === msg.seq) lastGoodKeyRef.current.run = postedRef.current.key;
        setLive({ result: msg.result, elapsedMs: msg.elapsedMs, running: false, error: null });
      } else if (msg.type === "arenaDone") {
        if (postedRef.current?.seq === msg.seq) lastGoodKeyRef.current.arena = postedRef.current.key;
        setArenaLive({ result: msg.result, elapsedMs: msg.elapsedMs, running: false, error: null });
      } else if (msg.request === "arena") {
        setArenaLive((prev) => ({ ...prev, running: false, error: msg.message }));
      } else {
        setLive((prev) => ({ ...prev, running: false, error: msg.message }));
      }
    };
    workerRef.current = worker;
    return worker;
  }, []);

  useEffect(() => {
    const worker = spawnWorker();
    return () => worker.terminate();
  }, [spawnWorker]);

  // live replay: every config change re-runs after a short debounce. The
  // request kind follows the visible page: the arena page computes the
  // roster, everything else keeps the console run warm.
  const arenaVisible = view === "arena";
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        if (!workerRef.current) return;
        const kind: "run" | "arena" = arenaVisible ? "arena" : "run";
        const key = arenaVisible ? arenaConfigToHash(arenaConfig) : configToHash(config);
        // keep the visible page's shareable URL current, but never rewrite
        // another page's path
        const syncUrl = () => {
          const pathView = viewFromPath();
          if (pathView === "console" && !arenaVisible) {
            history.replaceState(null, "", key); // replace, never push, no history spam
          } else if (pathView === "arena" && arenaVisible) {
            history.replaceState(null, "", arenaUrl(key));
          }
        };
        // this exact config's result is already delivered (e.g. a view
        // switch, or an edit reverted): don't recompute. Any in-flight run
        // is now superseded by the cached result — invalidate it so its
        // response can't land over the reverted config, and settle the
        // running flags it may have raised.
        if (lastGoodKeyRef.current[kind] === key) {
          syncUrl();
          seqRef.current += 1;
          setLive((prev) => ({ ...prev, running: false }));
          setArenaLive((prev) => ({ ...prev, running: false }));
          return;
        }
        const seq = ++seqRef.current;
        if (arenaVisible) setArenaLive((prev) => ({ ...prev, running: true }));
        else setLive((prev) => ({ ...prev, running: true }));
        try {
          const dataKind = arenaVisible ? arenaConfig.data.kind : config.data.kind;
          let historical: unknown | null = null;
          if (dataKind === "historical") {
            if (datasetRef.current === null) {
              const res = await fetch(`${import.meta.env.BASE_URL}data/aerodrome-epochs.v1.json`);
              if (!res.ok) throw new Error("historical dataset not published yet, run `pnpm data` and redeploy");
              datasetRef.current = await res.json();
            }
            historical = datasetRef.current;
          }
          if (seq !== seqRef.current) return; // superseded while fetching
          syncUrl();
          // true cancellation: a worker mid-computation can't be interrupted, so a
          // superseding run kills it and posts to a fresh one instead of queueing
          if (busyRef.current) {
            workerRef.current?.terminate();
            spawnWorker();
          }
          busyRef.current = true;
          postedRef.current = { seq, kind, key };
          workerRef.current?.postMessage({
            type: kind,
            seq,
            config: arenaVisible ? arenaConfig : config,
            historical,
          });
        } catch (err) {
          if (seq !== seqRef.current) return;
          const message = err instanceof Error ? err.message : String(err);
          if (arenaVisible) setArenaLive((prev) => ({ ...prev, running: false, error: message }));
          else setLive((prev) => ({ ...prev, running: false, error: message }));
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [config, arenaConfig, arenaVisible, spawnWorker]);

  const copyLink = useCallback(() => {
    history.replaceState(
      null,
      "",
      view === "arena" ? arenaUrl(arenaConfigToHash(arenaConfig)) : consoleUrl(configToHash(config)),
    );
    void navigator.clipboard.writeText(location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [config, arenaConfig, view]);

  /** Navigate to a doc page (real path, pushed so back/forward works). */
  const openPage = useCallback((v: DocView) => {
    history.pushState(null, "", pageUrl(v));
    setView(v);
  }, []);
  /** Return to the console at the base path, carrying the current run hash. */
  const openConsole = useCallback(
    (runConfig: RunConfig) => {
      history.pushState(null, "", consoleUrl(configToHash(runConfig)));
      setView("console");
    },
    [],
  );
  /** Open the arena page, carrying the current roster hash. */
  const openArena = useCallback(() => {
    history.pushState(null, "", arenaUrl(arenaConfigToHash(arenaConfig)));
    setView("arena");
  }, [arenaConfig]);

  const staleness = useMemo(
    () => stalenessDays(config.data.kind, live.result?.datasetGeneratedAt),
    [live.result, config.data.kind],
  );
  const arenaStaleness = useMemo(
    () => stalenessDays(arenaConfig.data.kind, arenaLive.result?.datasetGeneratedAt),
    [arenaLive.result, arenaConfig.data.kind],
  );

  const preset = PRESETS.find((p) => p.id === activePreset);
  const arenaPreset = ARENA_PRESETS.find((p) => p.id === activeArenaPreset);

  return (
    <>
      <header className="masthead">
        <h1>
          Aero Autopilot <span className="thin">/ strategy replay console</span>
        </h1>
        <span className="links">
          live replay · deterministic core · shared links replay exactly ·{" "}
          <a
            href={arenaUrl()}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              openArena();
            }}
          >
            arena
          </a>{" "}
          ·{" "}
          {DOC_PAGES.map((page) => (
            <span key={page.view}>
              <a
                href={pageUrl(page.view)}
                onClick={(e) => {
                  // let modified clicks (new tab, etc.) behave like a real link
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  openPage(page.view);
                }}
              >
                {page.label}
              </a>{" "}
              ·{" "}
            </span>
          ))}
          <a href="https://github.com/leo-klima-agents/autopilot" rel="noreferrer">
            source
          </a>
        </span>
      </header>
      <div className={`flight-director ${(view === "arena" ? arenaLive : live).running ? "running" : ""}`} aria-hidden>
        <div className="horizon" />
      </div>

      {view === "arena" ? (
        <main className="deck">
          <section aria-label="arena roster">
            <div className="panel">
              <p className="placard">Arena scenarios</p>
              <div className="preset-bar">
                {ARENA_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className={activeArenaPreset === p.id ? "active" : ""}
                    onClick={() => {
                      setArenaConfig(p.config);
                      setActiveArenaPreset(p.id);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="preset-blurb">
                {arenaPreset
                  ? arenaPreset.blurb
                  : "Assemble a roster; every agent allocates in the same market and they split the same revenue, weight for weight."}
              </p>
            </div>

            <ArenaPanel
              config={arenaConfig}
              onChange={(next) => {
                setArenaConfig(next);
                setActiveArenaPreset(null);
              }}
            />
          </section>

          <section aria-label="arena standings">
            {arenaStaleness !== null && (
              <div className="banner">
                Historical dataset is {arenaStaleness} days old, replaying the last published data (the data
                pipeline refreshes weekly).
              </div>
            )}
            {arenaLive.error && (
              <div className="banner alert" role="status">
                Arena run failed: {arenaLive.error}
                {arenaLive.result ? ", showing the last good run." : ""}
              </div>
            )}
            {arenaLive.result ? (
              <>
                <div className="panel">
                  <button className="copy-link" onClick={copyLink}>
                    {copied ? "Copied" : "Copy link to this arena"}
                  </button>
                  <p className="placard">
                    Leaderboard{" "}
                    <span className="unit">
                      · {arenaLive.running ? "recomputing…" : `computed in ${Math.round(arenaLive.elapsedMs)} ms`}
                    </span>
                  </p>
                  <Leaderboard result={arenaLive.result} />
                </div>
                <div className="panel">
                  <p className="placard">Equity per unit weight, all agents</p>
                  <ArenaEquityChart result={arenaLive.result} />
                  <div className="legend">
                    <span>
                      solid: agents, cumulative {arenaLive.result.revenueUnit === "usd" ? "USD " : ""}revenue per unit
                      weight
                    </span>
                    <span>
                      <span className="chip" style={{ background: "#E8B44F" }} />
                      market bench: global revenue ÷ global weight
                    </span>
                    <span>
                      <span className="chip" style={{ background: "#6FB8D3" }} />
                      revenue bench: each week's revenue shares, held with foresight
                    </span>
                  </div>
                </div>
              </>
            ) : (
              !arenaLive.error && (
                <div className="panel">
                  <div className="empty">
                    {arenaLive.running ? "Running the arena in a worker; the panel stays live." : "Warming up…"}
                  </div>
                </div>
              )
            )}
          </section>
        </main>
      ) : view !== "console" ? (
        (() => {
          const closeDoc = () => openConsole(config);
          if (view === "theory") return <Theory onClose={closeDoc} />;
          if (view === "strategies") return <Strategies onClose={closeDoc} />;
          if (view === "guide") return <Guide onClose={closeDoc} />;
          if (view === "vocabulary") return <Vocabulary onClose={closeDoc} />;
          return (
            <Logbook
              onClose={closeDoc}
              onOpenRun={(runConfig) => {
                setConfig(runConfig);
                setActivePreset(null);
                openConsole(runConfig);
              }}
            />
          );
        })()
      ) : (
      <main className="deck">
        <section aria-label="flight plan">
          <div className="panel">
            <p className="placard">Scenarios</p>
            <div className="preset-bar">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={activePreset === p.id ? "active" : ""}
                  onClick={() => {
                    setConfig(p.config);
                    setActivePreset(p.id);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="preset-blurb">
              {preset
                ? preset.blurb
                : "Pick a story scenario, or file your own flight plan, the instruments replay live as you adjust it."}
            </p>
          </div>

          <ConfigPanel
            config={config}
            onChange={(next) => {
              setConfig(next);
              setActivePreset(null);
            }}
          />
        </section>

        <section aria-label="instruments">
          {staleness !== null && (
            <div className="banner">
              Historical dataset is {staleness} days old, replaying the last published data (the data pipeline
              refreshes weekly).
            </div>
          )}
          {live.error && (
            <div className="banner alert" role="status">
              Replay failed: {live.error}
              {live.result ? ", showing the last good run." : ""}
            </div>
          )}

          {live.result ? (
            <>
              <div className="panel">
                <button className="copy-link" onClick={copyLink}>
                  {copied ? "Copied" : "Copy link to this run"}
                </button>
                <p className="placard">
                  Instruments{" "}
                  <span className="unit">
                    · {live.running ? "recomputing…" : `computed in ${Math.round(live.elapsedMs)} ms`}
                  </span>
                </p>
                <Gauges result={live.result} />
              </div>
              <div className="panel">
                <p className="placard">Equity vs benchmarks</p>
                <EquityChart result={live.result} />
                <div className="legend">
                  <span>
                    <span className="chip" style={{ background: "#6FD3A6" }} />
                    strategy: cumulative {live.result.revenueUnit === "usd" ? "USD " : ""}revenue per unit weight
                  </span>
                  <span>
                    <span className="chip" style={{ background: "#E8B44F" }} />
                    market bench: global revenue ÷ global weight
                  </span>
                  <span>
                    <span className="chip" style={{ background: "#6FB8D3" }} />
                    revenue bench: each week's revenue shares, held with foresight
                  </span>
                </div>
              </div>
              <div className="panel">
                <div className="panel-head">
                  <p className="placard">Allocation over time{viewSuffix(heatmapView)}</p>
                  <ViewToggle view={heatmapView} onChange={setHeatmapView} />
                </div>
                <AllocationHeatmap result={live.result} view={heatmapView} />
              </div>
              <div className="panel">
                <div className="panel-head">
                  <p className="placard">Earned revenue per pool{viewSuffix(heatmapView)}</p>
                  <ViewToggle view={heatmapView} onChange={setHeatmapView} />
                </div>
                <EarningsHeatmap result={live.result} view={heatmapView} />
              </div>
            </>
          ) : (
            !live.error && (
              <div className="panel">
                <div className="empty">
                  {live.running ? "Replaying the market in a worker; the panel stays live." : "Warming up…"}
                </div>
              </div>
            )
          )}
        </section>
      </main>
      )}
    </>
  );
}
