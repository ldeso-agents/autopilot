/**
 * Categorical agent palette: 8 fixed slots assigned by roster position and
 * never cycled (MAX_AGENTS === AGENT_COLORS.length). Validated for the app's
 * dark surface (#12171E): lightness band, chroma floor, adjacent-pair CVD
 * separation ΔE ≥ 8, normal-vision floor, ≥3:1 contrast. The two benchmark
 * lines keep the console's amber/cyan and are dashed, so agent identity is
 * never carried by color alone against them.
 */
export const AGENT_COLORS = [
  "#3987e5", // blue
  "#008300", // green
  "#d55181", // magenta
  "#c98500", // yellow
  "#199e70", // aqua
  "#d95926", // orange
  "#9085e9", // violet
  "#e66767", // red
] as const;

/** Color for the agent at `rosterIndex` (its position in config.agents). */
export function agentColor(rosterIndex: number): string {
  return AGENT_COLORS[rosterIndex % AGENT_COLORS.length]!;
}
