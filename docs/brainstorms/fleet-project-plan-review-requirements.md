---
date: 2026-05-25
topic: fleet-project-plan-review
---

# Fleet: Project Plan Review (MVP)

## Summary

Fleet is an on-demand project-intelligence helper that reviews a project's Plan for testability against a 7-point rubric and, at retro time, recommends — never decides — whether the plan looks validated, invalidated, or lacks evidence. It appears as a compact card in Project Details and a recommendation panel in the Project Retro, returns free deterministic checks always, and uses an optional direct OpenAI/Anthropic provider for quality scoring.

---

## Problem Frame

Ship's philosophy treats every project as a scientific experiment: it starts with a hypothesis (the Plan), executes work, and ends with a retro that validates or invalidates that hypothesis (`docs/ship-philosophy.md`). But nothing in Ship checks whether the Plan is *testable* in the first place. A Plan like "improve onboarding" can't be validated or invalidated — there's no measurable outcome, no target, no timeframe — yet today it flows all the way to a retro where a human is asked to make a binary Validated/Invalidated call against it.

Two moments of pain result:

- **At planning time**, the person writing the Plan gets no signal that their bet isn't falsifiable. The weakness is invisible until retro, when it's too late to instrument.
- **At retro time**, the owner faces a binary Validated/Invalidated decision with no synthesis of the evidence — issues completed/cancelled, success criteria, actual vs. expected impact — and no read on whether the evidence is even sufficient to make the call honestly. The philosophy forbids "partial success," which makes an under-evidenced or premature call costly.

Fleet is also the first concrete step of a much larger FleetGraph project-intelligence vision (`fleetgraph/background.md`). This MVP deliberately proves value on one narrow, high-frequency surface before any agent framework is built.

---

## Actors

- A1. Project Owner / Engineer: Writes the Plan via the `/plan` editor block; reads the Fleet card in Project Details to improve testability before work starts.
- A2. Accountable / PM: Closes the project retro, weighs Fleet's recommendation, and makes the final Validated/Invalidated call (which remains a human action).
- A3. Fleet analysis service: Backend service that gathers project signals, runs deterministic checks, optionally calls a model, and returns a structured review + retro recommendation.
- A4. AI provider (optional): Direct OpenAI or Anthropic SDK, selected by env config; absent/unconfigured is a first-class state, not an error.

---

## Key Flows

- F1. Plan review in Project Details
  - **Trigger:** Owner opens a project; the Fleet card mounts and requests the review.
  - **Actors:** A1, A3, A4
  - **Steps:** Fleet reads `properties.plan` and related signals → runs deterministic checks → if a provider is configured and the input hash changed (or no cache exists), runs one model call and caches by hash, else serves the cached result → returns score, status, findings, and an optional suggested rewrite.
  - **Outcome:** Card shows one of No Plan / Needs Work / Looks Testable, a score (n/7), top findings, a suggested rewrite when useful, and a `/plan` hint when no plan exists.
  - **Covered by:** R1, R2, R3, R4, R5, R8, R9, R10

- F2. Retro recommendation in Project Retro
  - **Trigger:** Owner opens the retro; the recommendation panel requests the analysis.
  - **Actors:** A2, A3, A4
  - **Steps:** Fleet compares Plan, success criteria, completed/cancelled/active issues, expected vs. actual impact, and retro content → returns one of `validated_recommended` / `invalidated_recommended` / `insufficient_evidence` with explanation, evidence found, and evidence missing.
  - **Outcome:** Panel renders the recommendation near the existing Validated/Invalidated controls; the human still selects the outcome. Fleet never auto-selects.
  - **Covered by:** R6, R7, R11, R12, R15

---

## Requirements

**Plan analysis (backend)**
- R1. Given a project id, Fleet fetches the project, `properties.plan`, project `content`, success criteria, associated issues, weeks, and any existing retro data.
- R2. Fleet determines whether a Project Plan exists, treating `properties.plan` (already kept in sync from the `/plan` block and the create-wizard string) as the source of truth for plan text.
- R3. Fleet always produces deterministic checks independent of any AI provider: missing Project Plan, missing success criteria, missing measurable language, and missing timeframe-like language where detectable.
- R4. When a provider is configured, Fleet evaluates Plan quality against a 7-criterion rubric: measurable outcome, quantifiable target, baseline/current state, timeframe, clear user/system/business scope, causal claim, and success-criteria alignment.
- R5. The analysis result includes: score (count of rubric criteria met, 0–7), status, findings (one per failed criterion), an optional suggested rewrite, and evidence references.
- R5a. Status is derived as: no plan text → `No Plan`; fewer than 5 criteria met → `Needs Work`; 5 or more met → `Looks Testable`. The same thresholds apply to deterministic-only and AI-scored results.

**Retro recommendation (backend)**
- R6. Fleet compares Plan, success criteria, completed/cancelled/active issues, expected vs. actual monetary impact, and retro content to produce a recommendation.
- R7. The recommendation is exactly one of `validated_recommended`, `invalidated_recommended`, or `insufficient_evidence`, plus a concise explanation, evidence found, and evidence missing.
- R7a. Fleet must never write `plan_validated` or otherwise auto-select Validated/Invalidated; it returns advisory output only.

**AI provider abstraction**
- R8. A small provider abstraction (`api/src/services/fleet-ai.ts` or equivalent) supports providers `openai`, `anthropic`, and `none`, configured via `FLEET_AI_PROVIDER`, `FLEET_AI_MODEL`, and the matching `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.
- R8a. Fleet must not use AWS Bedrock and must not couple to the existing `api/src/services/ai-analysis.ts`.
- R9. The model is required to return structured JSON matching a provider-neutral response schema; prompts and schema are written so switching providers is low-cost.
- R9a. When no provider is configured (or a provider call fails), Fleet returns deterministic findings only, and the response clearly indicates AI was unavailable rather than erroring.

**API + caching**
- R10. Expose `GET /api/projects/:id/fleet/plan-review` returning both the plan review and the retro recommendation in one response, registered with OpenAPI per the project's endpoint convention.
- R10a. Expose `POST /api/projects/:id/fleet/plan-review/refresh` that forces a fresh AI evaluation.
- R11. Cache the last analysis on the project document (no new table). Plan-review and retro-recommendation results are cached as separate sub-results, each keyed by a hash of only the inputs relevant to it.
- R12. On GET, deterministic checks are always recomputed; cached AI results are served when their input hash is unchanged, and a single AI call is run (then cached) on a hash miss or absent cache.

**Frontend — Project Details card**
- R13. Add a compact Fleet card in Project Details showing the status (No Plan / Needs Work / Looks Testable), the score, top findings, a suggested rewrite when useful, and a hint to use `/plan` when no plan exists.
- R13a. Where it fits the existing UI, include helper text: "Use /plan to write the project plan as a testable bet: what will change, for whom, by how much, and by when."

**Frontend — Project Retro panel**
- R14. Add a Fleet recommendation panel in Project Retro, positioned near the existing Validated/Invalidated controls, showing the recommended outcome, evidence found, evidence missing, and a short suggested retro conclusion.
- R15. The panel never changes the Validated/Invalidated selection; the human control remains the only way to set the outcome.

**Wiring**
- R16. Pass through only the project fields the Fleet card and retro panel need (e.g. plan, approval/retro state) via `ProjectDetailsTab`, keeping changes narrowly scoped.

---

## Acceptance Examples

- AE1. **Covers R2, R3, R13.** Given a project with empty `properties.plan`, when the Fleet card loads, the status is `No Plan` and the `/plan` hint is shown.
- AE2. **Covers R3, R4, R5, R5a.** Given a plan reading "make onboarding better" with no target or timeframe, when reviewed, the status is `Needs Work` with a score below 5 and findings naming the missing measurable outcome, target, and timeframe.
- AE3. **Covers R4, R5a.** Given a plan reading "cut new-user activation time from 6 minutes to under 3 minutes for self-serve signups by end of Q3," when reviewed with a provider configured, the status is `Looks Testable` with a score of 5 or more.
- AE4. **Covers R9a.** Given `FLEET_AI_PROVIDER=none`, when the Fleet card loads, deterministic findings are returned, the response indicates AI is unavailable, and the endpoint does not error.
- AE5. **Covers R7, R7a, R15.** Given a project where success criteria are unmet and no actual impact is recorded, when the retro panel loads, the recommendation is `insufficient_evidence` (or `invalidated_recommended`) and `plan_validated` remains unchanged in the project's data.
- AE6. **Covers R11, R12.** Given an unchanged plan, when GET is called twice, the second call serves the cached AI result without a new model call; when the plan text then changes, the next GET triggers exactly one new model call.

---

## Success Criteria

- A project owner can tell at a glance, before work starts, whether their Plan is testable, and what specifically to add to make it so.
- At retro, the owner sees a synthesized recommendation with explicit evidence-found / evidence-missing, and still makes the binary call themselves.
- Fleet runs usefully with no AI provider configured (deterministic checks) and upgrades transparently when a provider is set.
- `ce-plan` can implement without inventing product behavior: status thresholds, the rubric, the cache/trigger model, endpoint shape, and the no-auto-validate constraint are all specified here.
- Switching between OpenAI and Anthropic later requires only config and provider-adapter changes, not prompt or schema rewrites.

---

## Scope Boundaries

- No proactive monitoring, scheduling, webhooks, or background runs — Fleet is on-demand only in this MVP.
- No chat/conversational interface and no generic agent framework.
- No separate Project Plan form field in Project Details; the `/plan` editor block remains the entry workflow.
- No redesign of project creation; the existing optional Plan field in the create wizard stays as-is.
- No use of AWS Bedrock or the existing `ai-analysis.ts` service.
- Fleet does not block project creation, and does not autonomously set Validated/Invalidated.
- No broad rename of internal "hypothesis" naming (extraction utilities, legacy compatibility) beyond what this feature strictly requires.

---

## Key Decisions

- Single source of plan text is `properties.plan`: Verified that the collaboration server and document PATCH route already extract the `/plan` hypothesis block (and the wizard string) into `properties.plan`, so reading it needs no new sync work.
- Rubric-count score (0–7) over a weighted 0–100 score: Same result shape for deterministic and AI paths, integer thresholds are trivially testable, and users see exactly which criteria failed.
- Lazy AI on cache miss, keyed by input hash: Deterministic checks are free and always fresh; the model runs at most once per distinct plan version; explicit refresh forces a re-run. Accepted consequence: the first GET after a plan edit blocks briefly on the model call.
- One endpoint returns both plan review and retro recommendation, with separate hash-keyed sub-results: Avoids a second round trip and a second cache while keeping the cheap plan-card review from being invalidated when only issues change.
- Cache stored on the project document (e.g. `properties.fleet`), no new table: Aligns with Ship's "everything is a document, no new content tables" rule.
- Provider abstraction with `none` as a first-class state: Keeps Fleet swappable and lets the feature ship and demo without any API key.

---

## Dependencies / Assumptions

- Assumes `properties.plan` continues to be kept in sync from editor content; if that sync regresses, Fleet's plan detection degrades with it.
- Assumes success criteria, issue states (done/cancelled/active), and expected/actual monetary impact remain available on the project/retro as they are today (`properties.success_criteria`, issue associations, `monetary_impact_expected/actual`).
- Requires an OpenAI or Anthropic API key in environments where AI scoring is expected; otherwise the deterministic path is the only output.
- New endpoints follow the project's OpenAPI registration pattern (`/ship-openapi-endpoints`).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3] [Technical] Exact heuristics for "measurable language" and "timeframe-like language" in the deterministic path (keyword/regex lists, number detection) — settle during implementation against real plan examples.
- [Affects R9] [Technical] Concrete provider-neutral JSON response schema and prompt text, including how findings/rewrite are bounded in length.
- [Affects R11, R12] [Technical] Precise definition of which inputs feed the plan-review hash vs. the retro-recommendation hash, and the stored shape under `properties.fleet`.
- [Affects R4] [Needs research] Whether the rubric needs per-criterion guidance/examples in the prompt to keep model scoring stable across providers.
- [Affects R5] [Technical] When AI is unavailable, how (or whether) to derive a 0–7 score from the four deterministic checks, or present score as "n/a" with findings only.
