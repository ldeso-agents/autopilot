/** The arena flight plan: the roster of competitors (strategy + config +
 *  stake per agent) plus the shared scenario (model, data, crowd) and run
 *  length. Scenario panels are the console's own, reused; the roster editor
 *  is arena-specific. Every control writes into one ArenaRunConfig. */
import { MAX_AGENTS, type ArenaAgentConfig, type ArenaRunConfig } from "../lib/arenaConfig.js";
import { agentColor } from "../lib/agentColors.js";
import { probeStrategy, STRATEGY_LABELS } from "../lib/strategyCatalog.js";
import type { StrategyKind } from "../lib/runConfig.js";
import { MarketDataPanel, ModelPanel } from "./ConfigPanel.js";
import { SchemaForm } from "./SchemaForm.js";

interface Props {
  config: ArenaRunConfig;
  onChange: (next: ArenaRunConfig) => void;
}

/** Smallest positive integer n such that "agent-n" is unused. */
function nextAgentId(agents: readonly ArenaAgentConfig[]): string {
  const used = new Set(agents.map((a) => a.id));
  for (let n = 1; ; n += 1) {
    if (!used.has(`agent-${n}`)) return `agent-${n}`;
  }
}

export function ArenaPanel({ config, onChange }: Props) {
  const patch = (p: Partial<ArenaRunConfig>) => onChange({ ...config, ...p });
  const patchAgent = (index: number, next: ArenaAgentConfig) =>
    patch({ agents: config.agents.with(index, next) });

  const addAgent = () => {
    const id = nextAgentId(config.agents);
    const kind: StrategyKind = "fixedGrid48h";
    patch({
      agents: [
        ...config.agents,
        {
          id,
          label: STRATEGY_LABELS.find((s) => s.kind === kind)?.label ?? kind,
          strategy: { kind, config: {} },
          trancheCount: 2,
          trancheTokens: 250_000,
        },
      ],
    });
  };
  const duplicateAgent = (index: number) => {
    const source = config.agents[index]!;
    const copy: ArenaAgentConfig = {
      ...source,
      id: nextAgentId(config.agents),
      label: `${source.label} (copy)`,
      strategy: { kind: source.strategy.kind, config: { ...source.strategy.config } },
    };
    patch({ agents: [...config.agents, copy] });
  };
  const removeAgent = (index: number) =>
    patch({ agents: config.agents.filter((_, i) => i !== index) });

  return (
    <>
      <div className="panel">
        <p className="placard">
          Competitors <span className="unit">· {config.agents.length}/{MAX_AGENTS}</span>
        </p>
        {config.agents.map((agent, index) => {
          const probe = probeStrategy(agent.strategy.kind);
          return (
            <div className="agent-card" key={agent.id}>
              <div className="agent-head">
                <span className="chip" style={{ background: agentColor(index) }} />
                <input
                  aria-label={`${agent.id} label`}
                  className="agent-label"
                  value={agent.label}
                  onChange={(e) => patchAgent(index, { ...agent, label: e.target.value })}
                />
                <button
                  title="duplicate this competitor"
                  onClick={() => duplicateAgent(index)}
                  disabled={config.agents.length >= MAX_AGENTS}
                >
                  ⧉
                </button>
                <button
                  title="remove this competitor"
                  onClick={() => removeAgent(index)}
                  disabled={config.agents.length <= 1}
                >
                  ✕
                </button>
              </div>
              <div className="field">
                <label htmlFor={`${agent.id}-strategy`}>engine</label>
                <select
                  id={`${agent.id}-strategy`}
                  value={agent.strategy.kind}
                  onChange={(e) =>
                    patchAgent(index, {
                      ...agent,
                      strategy: { kind: e.target.value as StrategyKind, config: {} },
                    })
                  }
                >
                  {STRATEGY_LABELS.map((s) => (
                    <option key={s.kind} value={s.kind}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <SchemaForm
                schema={probe.configSchema}
                value={agent.strategy.config}
                onChange={(c) => patchAgent(index, { ...agent, strategy: { ...agent.strategy, config: c } })}
              />
              <div className="field">
                <label htmlFor={`${agent.id}-tranches`}>tranches</label>
                <input
                  id={`${agent.id}-tranches`}
                  type="number"
                  min={1}
                  max={8}
                  value={agent.trancheCount}
                  onChange={(e) =>
                    patchAgent(index, { ...agent, trancheCount: Math.round(e.target.valueAsNumber) })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor={`${agent.id}-tokens`}>tokens / tranche</label>
                <input
                  id={`${agent.id}-tokens`}
                  type="number"
                  min={1}
                  value={agent.trancheTokens}
                  onChange={(e) =>
                    patchAgent(index, { ...agent, trancheTokens: Math.round(e.target.valueAsNumber) })
                  }
                />
              </div>
            </div>
          );
        })}
        <button className="add-agent" onClick={addAgent} disabled={config.agents.length >= MAX_AGENTS}>
          + add competitor
        </button>
      </div>

      <ModelPanel model={config.model} onChange={(model) => patch({ model })} />
      <MarketDataPanel data={config.data} crowd={config.crowd} onChange={(p) => patch(p)} />

      <div className="panel">
        <p className="placard">Run</p>
        <div className="field">
          <label htmlFor="arena-weeks">duration, weeks</label>
          <input
            id="arena-weeks"
            type="number"
            min={1}
            max={52}
            value={config.run.durationWeeks}
            onChange={(e) => patch({ run: { ...config.run, durationWeeks: Math.round(e.target.valueAsNumber) } })}
          />
        </div>
      </div>
    </>
  );
}
