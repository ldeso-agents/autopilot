/** The flight plan: strategy, model, data, crowd, run sizing. Every control
 *  writes into one RunConfig object. Nothing here computes; the worker does.
 *  ModelPanel and MarketDataPanel are exported separately so the arena page
 *  can reuse them for its shared scenario controls. */
import { probeStrategy, STRATEGY_LABELS } from "../lib/strategyCatalog.js";
import type { RunConfig, StrategyKind } from "../lib/runConfig.js";
import { SchemaForm } from "./SchemaForm.js";

const COOLDOWNS: { sec: number; label: string }[] = [
  { sec: 604_800, label: "7 d (v2 epoch)" },
  { sec: 172_800, label: "48 h (v3 launch plan)" },
  { sec: 86_400, label: "24 h" },
  { sec: 3_600, label: "1 h" },
  { sec: 2, label: "1 block (2 s)" },
];

/** Protocol-model panel (economy, cooldown, caps, decay, emissions).
 *  `showGranularity: false` hides the cooldown-scope control for surfaces
 *  that must pin per-position gating (the arena's fairness contract). */
export function ModelPanel({
  model,
  onChange,
  showGranularity = true,
}: {
  model: RunConfig["model"];
  onChange: (next: RunConfig["model"]) => void;
  showGranularity?: boolean;
}) {
  return (
    <div className="panel">
      <p className="placard">Protocol model</p>
      <div className="field">
        <label htmlFor="model">economy</label>
        <select
          id="model"
          value={model.kind}
          onChange={(e) => onChange({ ...model, kind: e.target.value as "epoch" | "continuous" })}
        >
          <option value="continuous">Aero v3 (continuous)</option>
          <option value="epoch">Aerodrome v2 (weekly epochs)</option>
        </select>
      </div>
      {model.kind === "continuous" && (
        <>
          <div className="field">
            <label htmlFor="cooldown">allocation cooldown</label>
            <select
              id="cooldown"
              value={model.cooldownSec}
              onChange={(e) => onChange({ ...model, cooldownSec: Number(e.target.value) })}
            >
              {COOLDOWNS.map((c) => (
                <option key={c.sec} value={c.sec}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          {showGranularity && (
            <div className="field">
              <label htmlFor="granularity">
                cooldown scope
                <span className="hint">per-position is the published plan (F2)</span>
              </label>
              <select
                id="granularity"
                value={model.cooldownGranularity}
                onChange={(e) =>
                  onChange({ ...model, cooldownGranularity: e.target.value as "position" | "global" })
                }
              >
                <option value="position">per position</option>
                <option value="global">global</option>
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="caps">gauge caps</label>
            <input
              id="caps"
              type="checkbox"
              checked={model.caps.enabled}
              onChange={(e) => onChange({ ...model, caps: { ...model.caps, enabled: e.target.checked } })}
            />
          </div>
          {model.caps.enabled && (
            <div className="field">
              <label htmlFor="kappa">
                cap multiplier κ ×1000
                <span className="hint">1200 = 1.2×, a placeholder, not a published value (F14)</span>
              </label>
              <input
                id="kappa"
                type="number"
                min={100}
                step={50}
                value={model.caps.kappaMilli}
                onChange={(e) =>
                  onChange({
                    ...model,
                    caps: { ...model.caps, kappaMilli: Math.round(e.target.valueAsNumber) },
                  })
                }
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="decay">
              allocation decay
              <span className="hint">stale allocations lose influence (F5)</span>
            </label>
            <input
              id="decay"
              type="checkbox"
              checked={model.decay.enabled}
              onChange={(e) => onChange({ ...model, decay: { ...model.decay, enabled: e.target.checked } })}
            />
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="emissions">emissions / day</label>
        <input
          id="emissions"
          type="number"
          min={0}
          value={model.emissionPerDay}
          onChange={(e) => onChange({ ...model, emissionPerDay: Math.round(e.target.valueAsNumber) })}
        />
      </div>
    </div>
  );
}

/** Market-data panel (dataset source + crowd). */
export function MarketDataPanel({
  data,
  crowd,
  onChange,
}: {
  data: RunConfig["data"];
  crowd: RunConfig["crowd"];
  onChange: (patch: { data?: RunConfig["data"]; crowd?: RunConfig["crowd"] }) => void;
}) {
  const syn = data.kind === "synthetic" ? data : null;
  return (
    <div className="panel">
      <p className="placard">Market data</p>
      <div className="field">
        <label htmlFor="datakind">source</label>
        <select
          id="datakind"
          value={data.kind}
          onChange={(e) =>
            onChange({
              data:
                e.target.value === "historical"
                  ? { kind: "historical" }
                  : { kind: "synthetic", seed: "42", poolCount: 8, epochCount: 20, process: "persistent" },
            })
          }
        >
          <option value="synthetic">synthetic scenario (seeded)</option>
          <option value="historical">Aerodrome historical (top 30 pools)</option>
        </select>
      </div>
      {syn && (
        <>
          <div className="field">
            <label htmlFor="seed">seed</label>
            <input
              id="seed"
              value={syn.seed}
              onChange={(e) => onChange({ data: { ...syn, seed: e.target.value.replace(/\D/g, "") || "0" } })}
            />
          </div>
          <div className="field">
            <label htmlFor="process">fee process</label>
            <select
              id="process"
              value={syn.process}
              onChange={(e) =>
                onChange({ data: { ...syn, process: e.target.value as "persistent" | "bursty" | "regime" } })
              }
            >
              <option value="persistent">persistent</option>
              <option value="bursty">bursty</option>
              <option value="regime">regime-switching</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="pools">pools</label>
            <input
              id="pools"
              type="number"
              min={2}
              max={30}
              value={syn.poolCount}
              onChange={(e) => onChange({ data: { ...syn, poolCount: Math.round(e.target.valueAsNumber) } })}
            />
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="crowd">crowd</label>
        <select
          id="crowd"
          value={crowd.kind}
          onChange={(e) => onChange({ crowd: { ...crowd, kind: e.target.value as "none" | "static" | "herd" } })}
        >
          <option value="herd">reactive herd</option>
          <option value="static">static</option>
          <option value="none">none</option>
        </select>
      </div>
      {crowd.kind === "herd" && (
        <div className="field">
          <label htmlFor="lag">
            herd lag
            <span className="hint">seconds behind live revenue</span>
          </label>
          <input
            id="lag"
            type="number"
            min={0}
            step={3600}
            value={crowd.lagSec}
            onChange={(e) => onChange({ crowd: { ...crowd, lagSec: Math.round(e.target.valueAsNumber) } })}
          />
        </div>
      )}
      {crowd.kind !== "none" && (
        <div className="field">
          <label htmlFor="multiple">crowd ÷ portfolio</label>
          <input
            id="multiple"
            type="number"
            min={0}
            value={crowd.multiple}
            onChange={(e) => onChange({ crowd: { ...crowd, multiple: Math.round(e.target.valueAsNumber) } })}
          />
        </div>
      )}
    </div>
  );
}

interface Props {
  config: RunConfig;
  onChange: (next: RunConfig) => void;
}

export function ConfigPanel({ config, onChange }: Props) {
  const strategy = probeStrategy(config.strategy.kind);
  const patch = (p: Partial<RunConfig>) => onChange({ ...config, ...p });

  return (
    <>
      <div className="panel">
        <p className="placard">Strategy</p>
        <div className="field">
          <label htmlFor="strategy">engine</label>
          <select
            id="strategy"
            value={config.strategy.kind}
            onChange={(e) => patch({ strategy: { kind: e.target.value as StrategyKind, config: {} } })}
          >
            {STRATEGY_LABELS.map((s) => (
              <option key={s.kind} value={s.kind}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <SchemaForm
          schema={strategy.configSchema}
          value={config.strategy.config}
          onChange={(c) => patch({ strategy: { ...config.strategy, config: c } })}
        />
      </div>

      <ModelPanel model={config.model} onChange={(model) => patch({ model })} />
      <MarketDataPanel
        data={config.data}
        crowd={config.crowd}
        onChange={(p) => patch(p)}
      />

      <div className="panel">
        <p className="placard">Run</p>
        <div className="field">
          <label htmlFor="weeks">duration, weeks</label>
          <input
            id="weeks"
            type="number"
            min={1}
            max={52}
            value={config.run.durationWeeks}
            onChange={(e) => patch({ run: { ...config.run, durationWeeks: Math.round(e.target.valueAsNumber) } })}
          />
        </div>
        <div className="field">
          <label htmlFor="tranches">
            tranches
            <span className="hint">separate permanent stakes; staggered cooldowns</span>
          </label>
          <input
            id="tranches"
            type="number"
            min={1}
            max={16}
            value={config.run.trancheCount}
            onChange={(e) => patch({ run: { ...config.run, trancheCount: Math.round(e.target.valueAsNumber) } })}
          />
        </div>
        <div className="field">
          <label htmlFor="tokens">tokens / tranche</label>
          <input
            id="tokens"
            type="number"
            min={1}
            value={config.run.trancheTokens}
            onChange={(e) => patch({ run: { ...config.run, trancheTokens: Math.round(e.target.valueAsNumber) } })}
          />
        </div>
      </div>
    </>
  );
}
