---
title: "feat: Add environment metadata to LangSmith traces"
type: feat
status: active
created: 2026-05-26
---

# feat: Add environment metadata to LangSmith traces

## Problem Frame

LangSmith traces from the fleet application come from multiple environments (local development, shadow/UAT, production) but are all tagged to the same `LANGSMITH_PROJECT=fleet`. There is no way to filter or sort runs by environment in the LangSmith UI.

The `ENVIRONMENT` env var already exists — it is set to `prod` in Elastic Beanstalk (`api/.ebextensions/01-env.config`) and to `shadow` in the UAT environment. It is unset locally, where `NODE_ENV=development` is the only discriminator.

---

## Scope Boundaries

**In scope:**
- Add `metadata.environment` to the `RunnableConfig` for chat turns and proactive plan review runs
- Update `docs/fleetgraph/observability.md` to document the new metadata field

**Out of scope:**
- Separate `LANGSMITH_PROJECT` values per environment (would split trace data across projects)
- Adding `ENVIRONMENT` to `.env.local` template in `dev.sh` (the fallback in code is sufficient)

---

## Key Technical Decisions

**Metadata vs. tags:** LangSmith supports both `metadata` (key-value pairs, filterable) and `tags` (string array). Metadata is preferable here because it names the field explicitly (`environment: "prod"`) rather than using a convention-dependent string (`env:prod`). LangGraph forwards `RunnableConfig.metadata` to LangSmith automatically.

**Environment resolution:** `process.env.ENVIRONMENT ?? 'development'` — uses the existing deployment discriminator (`prod` / `shadow`) when set, falls back to `'development'` for local work. Does not use `NODE_ENV` to avoid conflating `test` runs, which already have tracing disabled via `vitest.config.ts`.

**Single injection point:** `chatConfig()` is the sole builder for chat-turn `RunnableConfig` objects. Adding metadata there covers all three call sites (`runChatTurn`, `resumeChatTurn`, `streamChatTurn`). The proactive `runPlanReview` config is a separate literal that also needs the same metadata.

---

## Implementation Units

### U1. Add environment metadata to `RunnableConfig`

**Goal:** Tag every LangSmith trace with the deployment environment via `RunnableConfig.metadata`.

**Files:**
- `api/src/services/fleetgraph/index.ts`

**Approach:**
- In `chatConfig()` (line 189), add `metadata: { environment: process.env.ENVIRONMENT ?? 'development' }` alongside the existing `configurable` field.
- In `runPlanReview()`'s inline `config` literal (line 114), add the same `metadata` field.
- No new imports needed — `process.env` is always available.

**Patterns to follow:**
- `api/src/services/fleetgraph/index.ts` — existing `RunnableConfig` shape at line 189.
- `api/.ebextensions/01-env.config` — confirms `ENVIRONMENT=prod` for the production EB deployment.
- Shadow/UAT sets `ENVIRONMENT=shadow` via the terraform EB module (`terraform/modules/elastic-beanstalk/main.tf`).

**Test scenarios:**
- `chatConfig()` returned object includes `metadata.environment === 'development'` when `ENVIRONMENT` is unset.
- `chatConfig()` returned object includes `metadata.environment === 'prod'` when `ENVIRONMENT=prod`.
- The `runPlanReview` config has the same `metadata.environment` field.

**Verification:** Run `pnpm type-check` with no errors. In local dev with `LANGSMITH_TRACING=true`, trigger a chat turn and confirm the run appears in LangSmith with `environment: development` in the metadata panel.

---

### U2. Update observability documentation

**Goal:** Document the `metadata.environment` field so future maintainers know it exists and how to use it in LangSmith.

**Files:**
- `docs/fleetgraph/observability.md`

**Approach:**
- Add a section or note describing that all traces carry `metadata.environment` matching the `ENVIRONMENT` env var (defaulting to `development` locally).
- Mention how to filter by environment in the LangSmith UI (Metadata filter by key `environment`).
- Note that `streamChatTurn` spreads `chatConfig()` (`{ ...chatConfig(...), signal }`); any future refactor of that spread must preserve the `metadata` field.

**Test scenarios:**
- Test expectation: none — documentation-only unit.

**Verification:** Doc is updated and internally consistent with the implementation.

---

## Deferred to Follow-Up Work

- Adding a `userId` or `projectId` to trace metadata for per-user or per-project filtering (separate initiative).
- Creating separate LangSmith datasets per environment for eval runs.
