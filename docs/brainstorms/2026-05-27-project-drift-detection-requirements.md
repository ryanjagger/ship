---
date: 2026-05-27
topic: project-drift-detection
---

# Project Drift Detection

## Summary

A per-project **drift badge**: computed state any workspace member sees when viewing an eligible (`active` or `planned`) project. It lights up when one or more of three project-scoped signals trip — *idle / no movement*, *stale plan*, *rising incomplete work* — naming which fired and how many.

---

## Problem Frame

Ship tracks everything needed to tell when a project is quietly slipping — issue state and timestamps, project plans and their edit history, document history — but nothing surfaces that judgment. A project can go a week without a single issue moving, sit on a plan nobody has touched in a month, or accumulate incomplete work faster than it closes, and none of it is visible until someone goes looking project by project.

There is no role that owns this watching today (Ship has no PM/Director role; accountability is RACI plus a `reports_to` chain), and there is no proactive surface — no inbox, no feed, no digest. The cost is late discovery: drift is noticed when a deadline is already at risk rather than when the trend first appears.

---

## Requirements

**Eligibility & computation**
- R1. Drift is computed only for projects inferred as `active` or `planned` (via `computeInferredProjectStatus`). Projects inferred `completed`, `backlog`, or `archived` never show a drift badge — their idleness/staleness is expected, not drift.
- R2. Drift is computed on-read as derived state, the same way inferred project status is. No drift state is stored, no background sweep runs, and nothing is pushed to a user. A member sees current drift whenever they load the project (or a project list).

**Signals**
- R3. *Idle / no movement* fires when an eligible project has ≥1 open issue (`state` in `todo`/`in_progress`) and no associated issue has changed state or been created within the last 7 days. Both state changes and new issues count as movement. A project with no open issues does not trip idle (nothing to move).
- R4. *Stale plan* fires when the project's `plan` was last edited more than 21 days ago. A project with no plan at all also trips this signal, distinguished by label ("no plan" vs "plan stale 24d") — on an active/planned project a missing plan is a stronger form of the same problem, not a separate signal.
- R5. *Rising incomplete work* fires when the count of incomplete issues (not `done`, not `cancelled`) is at least 2 higher now than the count as of 7 days ago — scope accumulating faster than it closes, which is distinct from idle because work can pile up while issues are still moving.

**Badge presentation**
- R6. The badge appears when ≥1 signal fires. It lists each fired signal with a human-readable reason (e.g., "idle 9 days", "plan stale 24d", "incomplete work +3 in 7d") and shows a severity equal to the number of signals fired.
- R7. The badge is display-only in this version — no acknowledge, snooze, ask-FleetGraph, or create-follow-up actions.

---

## Acceptance Examples

- AE1. **Covers R1.** Given a project inferred `backlog` that has had no issue movement in 40 days and no plan, when a member views it, no drift badge appears.
- AE2. **Covers R3.** Given an `active` project with 4 open issues where the most recent issue state change and most recent issue creation are both 9 days ago, when a member views it, the badge fires with an "idle 9 days" reason.
- AE3. **Covers R3.** Given an `active` project whose only issues are all `done`, when a member views it, *idle* does not fire (no open issues to move).
- AE4. **Covers R4.** Given an `active` project whose `plan` was last edited 24 days ago, when a member views it, *stale plan* fires labeled "plan stale 24d"; given an `active` project with an empty plan, the same signal fires labeled "no plan".
- AE5. **Covers R5.** Given a project with 5 incomplete issues now versus 3 incomplete 7 days ago (net +2), when a member views it, *rising incomplete work* fires; given net +1, it does not.
- AE6. **Covers R6.** Given a project where *idle* and *stale plan* both fire but *rising incomplete work* does not, when a member views it, the badge shows severity 2 and lists both reasons.

---

## Success Criteria

- The badge correlates with genuine drift: a healthy, actively-progressing project shows no badge, and a terminal/backlog project never shows one (zero false positives on ineligible projects).
- A member glancing at a project can tell *whether* it is drifting and *why* (which signals) without opening anything else.
- A downstream planner can implement all three detectors and the eligibility gate from this doc without having to invent thresholds, signal definitions, or what counts as "movement".

---

## Scope Boundaries

- The four human actions (acknowledge, snooze, ask FleetGraph for root cause, create follow-up work) are deferred — this version is detection + display only.
- A fleet-wide aggregate drift view / dashboard is out — per-project badge only.
- Person-scoped signals (*no recent standups*, *slipping week docs*) are excluded: standups and weekly plan/retro docs are per-person, not project-associated, and the person→project mapping was judged too fuzzy to trust.
- Workspace-configurable thresholds are out — the balanced constants (7d / 21d / +2) are fixed for v1.
- FleetGraph root-cause integration is out (it belongs to the deferred actions).

---

## Key Decisions

- **Project-scoped signals only.** Dropped *standups* and *week docs* because they attach to people, not projects; mixing them in would make the badge fire on an ambiguous "whose standups" mapping and erode trust.
- **Computed on-read, not pushed.** Drift is derived live rather than swept-and-stored, which sidesteps Ship's absent notification-inbox and cron infrastructure and keeps drift consistent with how inferred status already works. Aligns with "everything is a document / no new content tables".
- **Eligibility = active + planned.** A `planned` project sitting on a stale or empty plan is exactly the stalled-before-start case worth flagging; it simply won't trip *idle* until it has open issues.
- **"No plan" folds into the stale-plan signal** rather than being its own signal, to keep the badge to three signals with one distinct label.
- **Balanced thresholds (7d / 21d / +2) fixed.** Sensitive enough to read a week of silence as drift, tolerant of +1 noise on incomplete-work counts.

---

## Dependencies / Assumptions

- Relies on `computeInferredProjectStatus` for the eligibility gate.
- Relies on issue timestamps (`started_at`, `completed_at`, `reopened_at`, `cancelled_at`, `created_at`) and/or `document_history` to determine "movement" and to reconstruct the incomplete count as of 7 days ago.
- Assumes the plan's last-edit time is recoverable from `plan_history` and/or `document_history` — to be confirmed during planning.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] Authoritative source for "plan last edited" — `plan_history` entries vs `document_history` field-level edits — and how to reconcile if they disagree.
- [Affects R5][Technical] Method for reconstructing the as-of-7-days-ago incomplete count from issue timestamps (which states existed then), and whether that reconstruction is correct across reopened/cancelled transitions.
- [Affects R2][Needs research] Cost of computing all three signals on-read across a project *list* response, and whether any batching/caching is warranted if list pages get large.
