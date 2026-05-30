# FleetGraph Cost Analysis

**Analyzed:** 2026-05-29 · **Source:** LangSmith project `fleet` · **Model:** `claude-haiku-4-5` (only model in the data)

This consolidates the per-trace cost anecdotes scattered across the sibling
[`whats-next.md`](./whats-next.md), [`drift-sweep.md`](./drift-sweep.md),
[`issue-dedupe.md`](./issue-dedupe.md), and [`plan-review-drift.md`](./plan-review-drift.md)
reports into **aggregate, measured per-mode costs** plus a **projection model** for spend at
scale. It's the cost half of the `presearch.md` "Phase 3" the [README](../README.md) promises.

---

## TL;DR

- **Real per-run cost is tiny** — every mode is **$0.001–$0.006 per call** on Haiku. Total
  measured spend over the ~3-day sample (269 billable LLM runs) was **≈ $0.60**.
- **The drift sweep is the only thing that scales with the product.** It fires up to
  **15 LLM calls/hour/project forever** (cron `*/4 * * * *`). At 100 projects this is
  **~$290–$1,170/month** depending on how often projects trip the model — vs. tens of dollars
  for everything else combined.
- **The single biggest lever is the drift *duty cycle*** — how often a project actually invokes
  the model per tick. SUPPRESS-memoization + a deterministic pre-gate (both already identified
  in `drift-sweep.md`) cut it ~5–20×. **Prompt caching is a second-order lever** that today only
  helps `related` and (potentially) `chat`.
- **HITL write-confirms are free**: 15 resume invocations in the sample used **0 tokens / $0** —
  the U7 "resume never re-bills" contract holds in production data.

---

## Scope & method

- **Pull:** all 1,695 runs (284 root traces) in the `fleet` project over a 120-day window;
  the data actually present spans **2026-05-26 → 2026-05-29**. Queried via the `langsmith`
  JS SDK (`Client.listRuns`) — see [Reproducing](#reproducing) (the `langsmith` CLI the
  skill prefers wasn't installable in this environment, but the SDK returns identical fields).
- **Cost source:** LangSmith's own `total_cost` per root run (it aggregates child LLM usage
  against its price map). **100% of billable traces had a measured cost** — nothing is
  back-of-envelope. As a sanity anchor, `claude-haiku-4-5` prices at **$1.00 / 1M input,
  $5.00 / 1M output** (verified: 2,120 in + 344 out ⇒ $0.0038, matching `whats-next.md`).
- **Segmentation:** by the graph's `inputs.mode` on each root (`chat`, `plan_review`, `dedup`,
  `drift`, `related`, `retro`), with `fleet.retro_recommendation` / `fleet.related_groups`
  run-names mapped to `retro` / `related`. Zero-token resume/in-flight roots are excluded from
  billable stats.

**Caveats — read before trusting the projections:**

1. **Not real-user-scale yet.** Traces come from **local dev** (`development`) and a **Railway
   dev deployment** (`dev-railway`), with a handful from `local`/`railway-prod`. There is **no
   AWS-prod Fleet traffic** ([observability.md](../observability.md) notes Fleet AI isn't
   configured in AWS prod — still true; the Railway env is newer than that note). Per-run costs
   are production-representative; **frequencies are not** and drive the projection's assumptions.
2. **Sample sizes are small** for `related` (10) and `dedup` (14) — treat their tails as
   indicative, not firm.
3. **All Haiku.** If a mode is moved to a larger model (e.g. Opus for plan-review), multiply its
   per-run cost accordingly — these numbers do not transfer across models.

---

## Measured per-mode cost (the headline)

Per-run cost from real traces. `claude-haiku-4-5`, LangSmith-reported cost, billable runs only.

| Mode | Runs | Tokens (median, in→out) | **Cost/run (median)** | Cost/run (p90) | When it fires |
|---|---:|---|---:|---:|---|
| `related` | 10 | 3,152 (2,316→686) | **$0.0060** | $0.0073 | On-demand: open the "Related" view (5-min cached) |
| `chat` | 62 | 2,241 (2,028→260) | **$0.0029** | $0.0044 | On-demand: "Ask Fleet" turn |
| `retro` | 15 | 1,193 (743→399) | **$0.0028** | $0.0033 | Proactive: retro recommendation |
| `plan_review` | 66 | 912 (683→238) | **$0.0018** | $0.0022 | Plan edit / manual refresh |
| `dedup` | 14 | 813 (695→115) | **$0.0012** | $0.0015 | Draft-time, when pg_trgm candidates exist |
| `drift` | 31 | 740 (600→88) | **$0.0011** | $0.0012 | **Proactive sweep, every 4 min/project** |
| `resume` (HITL confirm) | 15 | 0 | **$0.0000** | — | Write-confirm — re-runs `action`, no LLM call |

Total measured spend over the window: **≈ $0.602** (chat $0.206, deployed-chat $0.124,
plan_review $0.124, related $0.057, retro $0.041, drift $0.032, dedup $0.018).

> **Note — a second chat trace shape.** 69 deployed chat turns appear as bare `ChatAnthropic`
> LLM roots (not nested under a `LangGraph` root) at a median **$0.0018 / 771 tokens** — the
> graph-callback nesting didn't propagate in that deploy, so they're un-grouped but real. Their
> smaller prompt suggests context assembly differs in that path; folded into "chat" for
> projection but worth confirming the deployed chat prompt matches dev.

These aggregates **confirm the single-trace reports**: drift median $0.0011 vs `drift-sweep.md`'s
$0.00112; dedup median $0.0012 vs `issue-dedupe.md`'s $0.0012; chat mean $0.0033 vs
`whats-next.md`'s $0.0038. The anecdotes were representative, not outliers.

---

## Cost drivers, ranked

1. **Drift sweep — dominant, and the only driver that scales with product size.** Cron
   `*/4 * * * *` ⇒ **15 ticks/hr**; `runSweepLoop` (`sweep.ts`) issues one Haiku call per
   *drift-eligible project that trips the model* each tick. A persistently-signaling project
   re-pays **every tick, forever** (the SUPPRESS re-pay documented in `drift-sweep.md` §1).
2. **Chat — scales with active users**, bounded by the 60-turn/user/hr limit (`rate-limit.ts`).
3. **Related — most expensive per call** (largest input: it clusters all open issues) but
   infrequent and 5-min cached (`RELATED_CACHE_TTL_MS`, `index.ts`).
4. **dedup / plan_review / retro — rounding error** at any realistic scale.

---

## Projection model

Projected monthly spend = `cost/run (median)` × `runs/month` derived from code + stated
assumptions. **Assumptions are explicit and tunable** — swap in real frequencies as they land.

### Driver 1 — Drift sweep (the one that matters)

Per sweep-enabled project: `15 calls/hr × 720 hr/mo × d × $0.00108`, where **`d` = duty cycle**
= fraction of the 10,800 monthly ticks on which the project actually invokes the model.

- `d = 1.0` — worst case: a persistent weak signal re-paying SUPPRESS every tick (today's bug).
- `d = 0.25` — a project that trips the model ~1 tick in 4.
- `d = 0.05` — mostly-quiet project, or the **memoized** end-state (only pays when the input
  fingerprint changes).

**Drift cost/project/month = $11.66 × d.** At scale (all projects sweep-enabled):

| Projects | `d=1.0` (re-pay bug) | `d=0.25` | `d=0.05` (memoized/quiet) |
|---:|---:|---:|---:|
| 10 | $117/mo | $29/mo | $6/mo |
| 100 | **$1,166/mo** | **$292/mo** | $58/mo |
| 1,000 | $11,664/mo | $2,916/mo | $583/mo |

This table **is** the cost story. The spread between columns — i.e. the duty cycle — dwarfs
every other mode and every other lever.

### Driver 2 — Chat (scales with users, not projects)

Per active user/month at `$0.003/turn`:

| Active users | Typical (10 turns/day) | Heavy (50/day) | Rate-limit ceiling (60/hr abuse) |
|---:|---:|---:|---:|
| 10 | $7/mo | $33/mo | $317/mo |
| 100 | $66/mo | $330/mo | $3,168/mo |
| 1,000 | $660/mo | $3,300/mo | $31,680/mo |

The 60-turn/hr limiter caps worst-case abuse; typical usage is negligible.

### Drivers 3–5 — minor (per workspace/project, realistic assumptions)

| Mode | Assumption | Monthly |
|---|---|---:|
| `related` | 20 cold (uncached) opens/day/workspace × $0.006 | ~$3.6/workspace |
| `dedup` | 25 candidate-bearing drafts/day/workspace × $0.0012 | ~$0.9/workspace |
| `plan_review` | 5 reviews/day/project × $0.0018 | ~$0.27/project |
| `retro` | a few per sprint × $0.0028 | <$0.1/project |

### Illustrative blended bill — 100 projects, 100 typical users, `d=0.25`, ~10 workspaces

`drift $292 + chat $66 + plan_review $27 + related $36 + dedup $9 + retro $5 ≈ **$435/mo**`,
of which **drift is ~67%**. With the drift re-pay bug unfixed (`d→1.0`), drift alone is
**$1,166/mo (≈90% of the bill)**. Fix the duty cycle and the whole thing drops to ~$200/mo.

---

## Levers (quantified)

1. **SUPPRESS memoization** (`drift-sweep.md` §1) — **biggest lever.** Most drift calls re-derive
   the same verdict on an unchanged input. Storing a `suppressed@inputHash` marker collapses `d`
   for stable signals. If ~80% of drift calls are repeat-SUPPRESS, this is a **~5× cut** to the
   dominant driver (100 projects worst-case: $1,166 → ~$230/mo).
2. **Deterministic pre-gate** (`drift-sweep.md` §2) — auto-SUPPRESS sub-threshold signals
   without the model. Stacks with #1 to push `d` lower; reserves Haiku for ambiguous/strong
   signals.
3. **`temperature: 0` on classifier modes** (`issue-dedupe.md` §1, `drift-sweep.md` §3) — not a
   direct cost cut, but it *protects* the memoization in #1: at the default temp ~1.0 the same
   input can flip verdict, defeating the input-hash short-circuit. Required for #1 to hold.
4. **Prompt caching** (`whats-next.md` §2, `issue-dedupe.md` §4) — Haiku's **2,048-token cache
   minimum** gates this. Measured input sizes: `related` 2,316 (**eligible** — ~75% static,
   the clear win), `chat` 2,028 (**just under** — gain ~90% on the cached portion *if* the
   static prefix is reordered above the line), `plan_review`/`dedup`/`drift` 600–700 (no-op).
   Second-order vs. #1–#2.

---

## Notable findings & follow-ups

- **HITL resume is free** — 15 write-confirm resumes used 0 tokens / $0. Good: confirming a
  proposed write never re-invokes the model.
- **Tags still aren't wired** (`issue-dedupe.md` §3). Segmentation here had to infer mode from
  graph-state input keys. Adding `tags: ['fleetgraph', <mode>]` + `metadata` (e.g.
  `decision`, `candidate_count`) would make every future cost query a one-line
  `--tags`/`--filter`, and let us chart SURFACE-vs-SUPPRESS rate (the real proxy for `d`).
- **Two chat trace shapes** (graph-rooted vs bare `ChatAnthropic`) and **mixed env labels**
  (`environment` vs `LANGSMITH_ENV`) across deploys — worth normalizing so deployed traffic
  aggregates cleanly.
- **observability.md is now stale** on "no deployed traces" — a Railway env (`dev-railway`) is
  tracing. AWS-prod Fleet AI remains unconfigured.

**Open questions:** What's the real drift duty cycle `d` on representative projects? (Answer it
by tagging SUPPRESS verdicts and charting the SURFACE:SUPPRESS ratio.) How many projects will
have `sweep_enabled`? Is the deployed chat prompt (771 tokens) intentionally lighter than dev
(2,288)?

---

## Reproducing

The `langsmith` JS SDK is already a dependency (`api/node_modules/langsmith`, used by
`wrapOpenAI`/`wrapAnthropic`). To regenerate:

```js
import { Client } from 'langsmith';
const client = new Client({ apiKey: LANGSMITH_API_KEY, apiUrl: LANGSMITH_ENDPOINT });
for await (const r of client.listRuns({ projectName: 'fleet', startTime })) { /* root runs carry
  total_tokens / total_cost; inputs.mode segments by mode */ }
```

Creds live in `api/.env.local` (`LANGSMITH_API_KEY`, `LANGSMITH_PROJECT=fleet`). Equivalent
with the skill's CLI once installed: `langsmith trace list --project fleet --include-metadata`.
