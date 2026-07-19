/** The arena standings, ranked by return vs the market benchmark (the
 *  zero-sum-ish score: everyone shares one revenue pot, so beating the
 *  market per unit weight means taking revenue from someone else). The
 *  table doubles as the chart's accessible data view. */
import type { DisplayArenaResult } from "../lib/serialize.js";
import { agentColor } from "../lib/agentColors.js";

function fmt(n: number): string {
  return n.toPrecision(4);
}
function fmtSigned(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toPrecision(4)}`;
}

export function Leaderboard({ result }: { result: DisplayArenaResult }) {
  const ranked = result.agents
    .map((agent, rosterIndex) => ({ agent, rosterIndex }))
    .sort((a, b) => b.agent.returnVsMarket - a.agent.returnVsMarket);

  return (
    <div className="leaderboard-wrap">
      <table className="leaderboard">
        <thead>
          <tr>
            <th>#</th>
            <th>agent</th>
            <th>strategy</th>
            <th className="num">return / wt</th>
            <th className="num">vs market</th>
            <th className="num">capture</th>
            <th className="num">turnover</th>
            <th className="num">rotations</th>
            <th className="num">blocked</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map(({ agent, rosterIndex }, rank) => (
            <tr key={agent.id}>
              <td>{rank + 1}</td>
              <td>
                <span className="chip" style={{ background: agentColor(rosterIndex) }} />
                {agent.label}
              </td>
              <td className="dim">{agent.strategyName}</td>
              <td className="num">{fmt(agent.totalReturn)}</td>
              <td className="num">{fmtSigned(agent.returnVsMarket)}</td>
              <td className="num">{agent.capture === null ? "—" : `${(agent.capture * 100).toFixed(1)}%`}</td>
              <td className="num">{fmt(agent.turnover)}</td>
              <td className="num">{agent.rotations}</td>
              <td className="num">{agent.blockedSubmissions}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        market benchmark {fmt(result.marketBenchmarkReturn)} / wt
        {result.oracleReturn !== null ? ` · foresight ceiling ${fmt(result.oracleReturn)} / wt` : ""} · capture =
        (agent − market) ÷ (foresight − market)
      </p>
    </div>
  );
}
