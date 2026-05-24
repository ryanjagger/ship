# AI Cost Analysis

## Summary

AI assistance during this 7-day window ran on two flat-rate monthly
subscriptions, **Claude Max ($200/mo)** and **ChatGPT Pro 5x ($100/mo)** —
$300/month combined. Neither plan meters or reports per-request usage, so a
precise "spend on this project" figure isn't recoverable. The estimate below
is a straight time-proration of the monthly fees over the 7 days of use.

## Spend estimate

Proration basis: 7 of 30 days ≈ **23.3%** of a monthly cycle.

| Tool | Plan | Monthly | Attributed (7/30 days) |
| --- | --- | ---: | ---: |
| Claude Max | subscription | $200.00 | $46.67 |
| ChatGPT Pro 5x | subscription | $100.00 | $23.33 |
| **Total** | | **$300.00** | **≈ $70.00** |

### How to read this number

- **~$70 is the prorated attribution** — the share of the monthly fee that
  corresponds to the 7 days of work. It is the fairest "cost of this project"
  figure.
- **$300 was the actual cash commitment.** Both subscriptions bill monthly
  regardless of how many days were used, so the real outlay for the billing
  cycle was the full $300. If the subscriptions were pre-existing (used for
  other work too), the *marginal* cost attributable to this project is closer
  to $0 — the seats were already paid for.
- **No usage-based component.** Neither plan charges per token or per request,
  so heavy days and light days cost the same. There is no metered log to
  reconcile against; the figures above are the only basis available.

### Caveats

- Flat-rate plans hide intensity. A day of near-continuous agent orchestration
  and a day of occasional single questions are billed identically, so the
  per-day proration ($300 ÷ 30 ≈ $10/day) over-attributes light days and
  under-attributes heavy ones.
- "ChatGPT Pro 5x" is recorded here at the $100/mo figure provided; if that
  reflects multiple seats or a non-standard plan, divide accordingly for a
  single-developer attribution.
- The 30-day month is a convenience denominator; using 30.44 (average month)
  changes the total by under a dollar.

## Reflection: where the tools helped, and where they didn't

This section is grounded in the actual work done during the window, not a
general product comparison.

### Claude (Claude Max / Claude Code) — workflow and comprehension

**Worked well:**

- **End-to-end feature delivery using the Compound Engineering workflow.** The
  bulk of the probe HTML-viewer + interactive-CLI feature was carried from idea
  to merged-ready PR through a single connected workflow (brainstorm → plan →
  implement → review → ship), with the agent navigating the monorepo, writing
  and running the test suite, and committing incrementally. Codebase
  comprehension was strong for "where does this live / what pattern does this
  follow" questions across the `probe/`, `api/`, and shared workspaces.

**Fell short:**

- **Self-review missed a security regression class.** The in-session Claude
  code review focused on the diff currently in front of it and did **not**
  catch that making `runId` a filename stem introduced a path-traversal /
  reserved-name vulnerability in `writeReports`. That whole cluster came from
  the external ChatGPT/Codex reviewer instead (see below). The lesson:
  a model reviewing its own work shares its own blind spots.
- **Environment/tooling friction.** Standing up the jsdom test environment
  took several iterations against a vitest v4 quirk (broken `Storage`
  prototype, non-`file://` `import.meta.url`); the model worked around it but
  didn't anticipate it.

### ChatGPT (Pro 5x / Codex connector) — adversarial diff review

**Worked well:**

- **Security-focused PR review.** Used as a reviewer after Claude Code commits
  and as an automated GitHub PR reviewer, it surfaced a series of real,
  distinct regressions on the `runId`-as-filename change that the Claude-side
  review had not: path traversal (`--run-id ../../outside`), reserved-name
  collisions (`index`,
  `security-report`), case-insensitive collisions on macOS/Windows, Windows
  reserved device names (`CON`, `NUL`, `COM1`, including the `con.json` /
  trailing-dot leading-segment subtlety), and a stored-XSS vector in
  `scanRuns` from tampered history JSON. Each was actionable and correct.
- **Independent vantage point.** Because it reviewed diffs cold — without the
  context or assumptions baked into the implementation session — it caught
  exactly the things the implementer's own model was primed to overlook.

**Fell short:**

- **Diff-scoped, not workflow-scoped.** It reviewed isolated hunks and emitted
  one finding per comment; it did not drive the build, run tests, or carry a
  change to completion. Its value was as a second set of eyes, not a second
  pair of hands.
- **No execution or verification.** Findings were reasoned from the code, not
  confirmed by running it; each still had to be reproduced and fixed in the
  implementation environment.

### Takeaway

The most valuable pattern this week was **using the two tools against each
other's weaknesses**: Claude for connected, execution-backed feature work, and
ChatGPT/Codex as an independent adversarial reviewer on the resulting diffs.
