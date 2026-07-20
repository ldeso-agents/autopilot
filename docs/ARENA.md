# ARENA.md: the multi-agent strategy arena

The arena is a battle-test harness for the strategy engine: N strategy agents allocate
inside **one shared protocol model** (the Aero v3 `ContinuousModel` by default, the v2
`EpochModel` works identically) and split the **same revenue pot pro-rata by weight**.
Where a normal backtest measures a strategy against a scripted crowd, the arena measures
strategies against each other: one agent's capture is, mechanically, the others'
dilution. Crowding, cadence races, and cooldown contention — the effects a solo backtest
cannot exhibit — are the point.

Engine: [`packages/core/src/arena/run.ts`](../packages/core/src/arena/run.ts)
(`runArena`). Interactive surface: the [/arena/ page](../apps/web) of the simulator
site, sharing the console's worker, scenario builder, and URL-hash exact-replay
contract (`#arena=…` links).

## 1. Mechanics

**Agents.** An `ArenaAgentSpec` is `{id, label, strategy, trancheCount, trancheWeight}`.
The runner registers `trancheCount` positions per agent in the model (ids
`{agentId}/tranche-NN`) and drives them through the same scheduler
(`plan`/`applyRotation`) the single-strategy backtester and the keeper use. Each agent's
`Portfolio` contains only its own tranches; the shared `MarketState` is where the agents
see each other — `poolWeight(p)` includes every agent plus the crowd, which is exactly
what makes competitor-aware strategies (CrowdingAvoider, WaterFilling,
ContinuousGreedy) meaningful in an arena.

**Simultaneous moves.** The model's `marketState()` is a live view, so naively letting
agents propose in sequence at the same instant would leak same-instant competitor moves
to later-ordered agents. The arena therefore freezes one materialized weight snapshot
per firing instant; every due agent proposes against that identical snapshot, and only
then do rotations execute, in agents-array order. Intra-instant execution order is
**economically neutral**: weights are piecewise constant and every rotation lands before
the next `advance`, so revenue over the following step is split by post-rotation weights
regardless of submission order. The fixed order exists only to make blocked-submission
accounting deterministic. Identical twin agents (same strategy, config, weight) produce
bigint-identical outcomes regardless of roster position; a test asserts this.

**One cooldown for everyone.** `createContinuousModel` gates all positions with a single
model-level `cooldownSec`, so per-agent cooldowns are not expressible in v1 — a shorter
per-agent scheduler cooldown would only manufacture blocked submissions. Agents differ
on the more interesting axis anyway: `strategy.cadenceSec` (how often they look) versus
the shared cooldown (how often they may act). The neutrality argument additionally
requires **per-position** cooldown *granularity*: under the model's `"global"` scope the
first successful rotation at a tick starts the shared cooldown and locks every later
agent out, making roster order economically decisive. The web builder therefore forces
`cooldownGranularity: "position"` for arena runs (the control is hidden on the arena
page), and the engine documents the assumption.

**Benchmarks.**

- *Market benchmark* — global revenue per unit of global weight, accrued per step. Per
  unit weight this is agent-independent, so it is one shared series; "the market" here
  includes all agents and the crowd. `returnVsMarket` is the leaderboard score: with
  everyone splitting one pot, beating the market per unit weight means taking revenue
  from someone else.
- *Foresight (oracle) benchmark* — a cheap **non-displacing** variant of the console's
  revenue benchmark: an infinitesimal portfolio holding each weekly epoch's pools in
  proportion to that epoch's realized revenue, earning `Δrevenue·share/poolWeight` per
  step without adding its own weight to any denominator. It is slightly optimistic
  versus the console's displacing oracle, and when the crowd is already well-aligned
  the (foresight − market) gap is small, which makes the derived *capture* ratio
  `(agent − market)/(foresight − market)` large in magnitude — read capture as a
  direction-and-rough-scale indicator, not a percentage of a hard ceiling. Pools that
  carried no weight at any step of an epoch are excluded from that epoch's revenue
  shares entirely (their revenue reaches nobody — the model books it as dust — so it
  must not dilute the held pools' shares); zero-weight steps of an otherwise-held pool
  are skipped.
- The single-run F21 on/off-target methodology is deliberately **not** computed per
  agent: it is a one-portfolio diagnostic and adds noise in a shared market.

**Conservation.** At the end of a run,
`Σ agents.earnedTotal + totals.crowdRevenue + totals.revenueDust === totals.revenueTotal`
exactly (bigint). Tests assert this on fixed rosters and under fast-check-generated
ones; emissions conservation (`streamed + burned === emitted`) is the model's own
invariant and unchanged.

**Determinism.** Fixed agent order, frozen snapshots, seeded PRNGs inside strategy
closures (`math/prng.ts` — never `Math.random`, and no floats on decision paths), and
integer-only accounting make `runArena` a pure function of its inputs. Two runs from
freshly built models and strategies are `===`-equal on every bigint; `#arena=` links
replay exactly, node or browser.

## 2. Reading the leaderboard

| Column | Meaning |
| --- | --- |
| return / wt | Cumulative revenue per unit of the agent's weight (Wad → float) |
| vs market | return − market benchmark: the competitive score (≈ zero-sum across the roster + crowd) |
| capture | (agent − market) ÷ (foresight − market); see the oracle caveat above |
| turnover | Σ L1(Δallocation)/2 across executed rotations — the cost proxy for churn |
| rotations / blocked | Executed vs cooldown-refused submissions — cadence pressure vs the shared cooldown |

Expected shape of results (and what the battle-royale golden pins): the informed
allocators (WaterFilling, ContinuousGreedy, EwmaForecast, FixedGrid, PersistenceCarry)
sit above the market line; the deliberately weak baselines (UniformStatic,
RandomRotator, MomentumChaser) sit below it, funding the winners. An agent everyone
should beat is as diagnostic as one nobody can.

## 3. The roster: why these strategies exist

The original five strategies were built to *run the vault*; the arena added six more to
*stress it* (all in [`packages/core/src/strategies/`](../packages/core/src/strategies)):

- **UniformStatic** — equal split, holds forever. The floor: any strategy that cannot
  beat it has negative information content.
- **RandomRotator** — seeded random pool subsets each cadence. Separates "skill" from
  "activity": it rotates as much as the smart strategies and earns like the uniform one.
- **MomentumChaser** — allocates to pool-weight *inflow*, i.e. follows the crowd one
  cadence late. The canonical reflexive loser; it buys crowding, not revenue.
- **EwmaForecast** — exponentially smoothed trailing revenue. A smarter mirror:
  faster than a long lookback, calmer than a short one.
- **CrowdingAvoider** — trailing revenue divided by *external* weight (marginal revenue
  per competing token). The first-order arena-aware policy; needs no engine changes
  because `MarketState.poolWeight` already exposes the competition.
- **BanditAllocator** — ε-greedy over pools with EWMA value estimates from partial
  feedback (only held pools update). ε-greedy rather than UCB on purpose: UCB needs
  `ln`/`sqrt` floats and `Math.log` is implementation-defined across JS engines, which
  would break the node-golden ↔ browser-replay determinism contract.

## 4. Could the arena run on a blockchain fork / testnet?

Short answer: **not usefully today; worth revisiting as an *integration* arena once real
Aero v3 code exists.**

**Today there is no v3 to fork.** Aero v3 is not on-chain; this repo holds only
provisional interfaces
([`IAeroV3Draft.sol`](../contracts/src/interfaces/external/IAeroV3Draft.sol)) and a
protocol facet explicitly marked DRAFT
([`AeroFacet.sol`](../contracts/src/facets/protocol/AeroFacet.sol), to be rewritten
against published code before any funds move). A Base mainnet fork can only host
Aerodrome v2 — a weekly-epoch arena, which the `EpochModel` already simulates at ~10⁶×
the speed.

**An anvil + MockAeroFacet arena would re-prove what is already proven.**
[`MockAeroFacet.sol`](../contracts/src/facets/protocol/MockAeroFacet.sol) implements the
v3 semantics (per-position cooldown, streaming revenue, gauge caps with burn) and is
**differential-tested** against this same TypeScript engine: `packages/core` emits
fixture vectors (`src/fixtures/emit.ts`), Foundry replays them and asserts exact
equality (`contracts/test/differential/`). Deploying the diamond on a local anvil chain
and driving N keeper processes through it would therefore exercise the *identical
accounting the TS arena already runs*, at three to four orders of magnitude more cost:
block-granularity time instead of exact 1-second integration, an oracle-feeder contract
to inject the revenue process, RPC orchestration per agent, and gas metering as noise.
The one thing it would newly measure — rotation gas under contention — does not need an
arena to measure.

**What changes when the real code drops (spec-delta window opens Aug 3,
[ARCHITECTURE.md §4](ARCHITECTURE.md#4-spec-delta-log-append-only-from-aug-3)).** Against
published v3 contracts on a fork or testnet, an on-chain arena starts answering
questions the TS engine *cannot*: real selector shapes and claim composition, actual
cooldown granularity (the §3 item 1 breakage probe), reward accounting quirks, and the
gas profile of full rotation pipelines. The incremental path is deliberately small: the
keeper ([`apps/keeper`](../apps/keeper)) already implements watch → compute → submit for
one strategy against the diamond; an integration arena is one keeper process per agent,
each with its own tranche set, replaying an `ArenaRunConfig` roster against a forked
node — an operational rehearsal (M4-adjacent), not an economics experiment. The
economics stay in the deterministic TS arena, where they are exact, free, and
reproducible from a URL.

## 5. Limitations / future work

- Per-agent cooldowns need model support (per-position `cooldownSec` override) — v2 of
  the arena, if the published v3 code even allows heterogeneous cooldowns.
- The foresight benchmark is non-displacing (see §1); a per-agent displacing oracle is
  possible but O(agents × pools) of extra buffering per step.
- The web page charts per-agent equity and the leaderboard; per-agent allocation
  heat-maps are already in the result payload (`allocationWeights`) but not yet
  rendered.
- Historical-data arenas replay the *recorded* crowd as ambient weight; the recorded
  voters could not react to the agents, so treat historical arena results as
  weight-perturbation studies, not counterfactual history.
