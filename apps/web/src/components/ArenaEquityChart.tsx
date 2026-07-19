/** Every agent's equity per unit weight on one axis, plus the two dashed
 *  benchmark references (amber market, cyan foresight) in the console's
 *  color language. Agent colors come from the fixed categorical palette,
 *  assigned by roster position so a color always follows its agent. */
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DisplayArenaResult } from "../lib/serialize.js";
import { agentColor } from "../lib/agentColors.js";
import { timeAxisFor } from "../lib/timeAxis.js";
import { TIME_AXIS_LEFT, TIME_AXIS_RIGHT_PAD, Y_AXIS_WIDTH } from "../lib/chartGeometry.js";

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export function ArenaEquityChart({ result }: { result: DisplayArenaResult }) {
  const axis = timeAxisFor(result);
  const data = result.times.map((ts, i) => {
    const row: Record<string, number> = { ts };
    for (const agent of result.agents) row[agent.id] = agent.equity[i]!;
    row["marketBenchmark"] = result.marketBenchmark[i]!;
    if (result.oracleBenchmark) row["oracleBenchmark"] = result.oracleBenchmark[i]!;
    return row;
  });
  const labelById = new Map(result.agents.map((a) => [a.id, a.label]));

  return (
    <div className="chart-wrap">
      <ResponsiveContainer>
        <LineChart
          data={data}
          margin={{ top: 8, right: TIME_AXIS_RIGHT_PAD, bottom: 4, left: TIME_AXIS_LEFT - Y_AXIS_WIDTH }}
        >
          <CartesianGrid stroke="#26303B" strokeDasharray="2 4" />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            stroke="#7C8A96"
            tick={{ fontSize: 10, fontFamily: MONO }}
            tickFormatter={(ts: number) => axis.tick(ts)}
            ticks={axis.epochTicks(result.times[0] ?? 0, result.times.at(-1) ?? 0)}
          />
          <YAxis
            stroke="#7C8A96"
            tick={{ fontSize: 10, fontFamily: MONO }}
            tickFormatter={(v: number) => v.toPrecision(3)}
            width={Y_AXIS_WIDTH}
          />
          <Tooltip
            contentStyle={{
              background: "#12171E",
              border: "1px solid #26303B",
              fontFamily: MONO,
              fontSize: 11,
            }}
            labelFormatter={(ts) => axis.label(Number(ts))}
            formatter={(value, name) => [
              typeof value === "number" ? value.toPrecision(6) : String(value),
              labelById.get(String(name)) ?? String(name),
            ]}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            formatter={(id: string) => labelById.get(id) ?? id}
          />
          {result.agents.map((agent, i) => (
            <Line
              key={agent.id}
              type="monotone"
              dataKey={agent.id}
              name={agent.id}
              stroke={agentColor(i)}
              strokeWidth={1.6}
              dot={false}
              isAnimationActive={false}
            />
          ))}
          <Line
            type="monotone"
            dataKey="marketBenchmark"
            name="market benchmark"
            stroke="#E8B44F"
            strokeWidth={1.4}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
          {result.oracleBenchmark && (
            <Line
              type="monotone"
              dataKey="oracleBenchmark"
              name="revenue benchmark (foresight)"
              stroke="#6FB8D3"
              strokeWidth={1.4}
              strokeDasharray="2 3"
              dot={false}
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
