---
title: "feat: Add LangSmith observability to the Fleet app"
type: feat
status: active
created: 2026-05-26
branch: feature/fleet-mvp-langsmith
depth: standard
---

# feat: Add LangSmith observability to the Fleet app

## Summary

Wire [LangSmith](https://docs.smith.langchain.com/) tracing into the FleetGraph
service (`api/src/services/fleetgraph/`) so every Fleet AI run is observable in
the LangSmith UI under the `fleet` project. FleetGraph runs on `@langchain/langgraph`
with `ChatAnthropic`/`ChatOpenAI` models, so the **chat path auto-traces from the
standard `LANGSMITH_*` environment variables with zero code changes**. The one gap
is the **proactive plan-review path**, which goes through `fleet-ai.ts` using the
*raw* `openai` / `@anthropic-ai/sdk` clients — those are not auto-instrumented and
must be wrapped with LangSmith's SDK wrappers to appear as traces.

This plan covers: local-dev env discoverability, a test-suite tracing kill-switch,
wrapping the raw-SDK proactive path, and production env wiring (Elastic Beanstalk +
SSM), plus verification.

**Target env values (provided by the requester):**

```
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_API_KEY=lsv2_pt_...   # real key goes only in api/.env.local (gitignored) and SSM — never committed
LANGSMITH_PROJECT="fleet"
```

---

## Problem Frame

FleetGraph is the repo's first and only LLM feature, and it has **no LLM
observability** today — logging is ad-hoc `console.*` and there is no APM/tracing
layer. Without tracing, debugging a bad Fleet answer, a stuck paused write, a
latency regression, or a prompt/cost problem means reading code and guessing.
LangSmith gives per-run traces (the `scope → fetch → reason → action/output` graph
nested under one trace) plus token/latency/cost telemetry, keyed to the `fleet`
project.

The work is overwhelmingly **configuration, not code**: LangChain/LangGraph read
`LANGSMITH_*` directly from `process.env` and auto-trace. The only code change is
wrapping the two raw-SDK clients in `fleet-ai.ts` so the proactive tier is not a
blind spot.

---

## Scope Boundaries

**In scope:**
- Local-dev env-var discoverability (`api/.env.example`) and the actual values in
  `api/.env.local` (gitignored).
- A test-suite kill-switch so tracing never emits from `pnpm test`.
- Instrumenting the raw-SDK proactive path in `fleet-ai.ts` with LangSmith wrappers,
  best-effort and never-throwing.
- Adding the `langsmith` package (needed only for the SDK wrappers).
- Production env wiring: non-secret toggles via Terraform EB settings, the API key
  via SSM SecureString loaded in `loadProductionSecrets()`.
- Verification that traces land in the `fleet` LangSmith project.

**Out of scope / non-goals:**
- No changes to graph topology, prompts, model selection, or node logic.
- No custom spans, run metadata enrichment, feedback capture, or evaluation
  datasets (LangSmith eval/datasets are a separate future track).
- No structured-logger or OpenTelemetry migration.
- The chat path needs **no** code — do not add manual `traceable` wrappers to the
  LangChain path; auto-tracing already covers it.

### Deferred to Follow-Up Work
- Pre-existing prod gap: `FLEET_AI_PROVIDER` / `ANTHROPIC_API_KEY` are not set in
  EB/SSM today, so the Fleet feature (and therefore any prod traces) does not run
  in production yet. This plan adds the LangSmith wiring alongside, but actually
  enabling Fleet in prod (setting the provider + model key) is a separate decision
  the deployer owns. Called out in U4 so the two land together if desired.
- LangSmith run metadata (tagging traces with `conversationDocId`, entity, user) —
  valuable but additive; deferred.

---

## Key Technical Decisions

1. **Env-var-only for the chat path.** The compiled LangGraph + LangChain chat
   models auto-trace when `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` are
   present in `process.env`. dotenv loads `.env.local`/`.env` at the very top of
   `api/src/index.ts:9-11` before any graph module runs, so the vars are present
   before the first invoke. No init code, no central config module (the repo has
   none by design — env is read directly).

2. **Wrap only the raw-SDK proactive path.** `fleet-ai.ts` constructs `new OpenAI`
   and `new Anthropic` directly (`fleet-ai.ts:66-67`) and calls `oa.responses.parse`
   / `an.messages.create`. These are invisible to LangChain auto-tracing. Wrap the
   constructed clients with `wrapOpenAI` / `wrapAnthropicSDK` from `langsmith/wrappers`
   so the proactive plan-review tier (`runPlanReview` → `reason.ts` →
   `evaluateStructured`) produces traces. Wrapping is transparent and tracing-gated:
   when `LANGSMITH_TRACING` is off, the wrappers are pass-throughs.

3. **Best-effort, never-throwing.** Consistent with `fleet-ai.ts`'s "never throws —
   neutral error union" contract (see learning
   `docs/solutions/integration-issues/anthropic-sdk-zod-v3-v4-structured-output-mismatch.md`)
   and the session-cookie env-gate convention. Wrapping must not break the client if
   LangSmith is unreachable or misconfigured; LangSmith's wrappers are designed to
   degrade silently, and we add nothing that could throw on the hot path.

4. **Test suite must never emit traces.** Models are always mocked in tests, but a
   developer's `.env.local` carrying `LANGSMITH_TRACING=true` could leak into any
   unmocked path. Force `LANGSMITH_TRACING=false` in the `test.env` block of
   `api/vitest.config.ts` so the suite is deterministic and offline.

5. **Prod via the two existing channels.** Non-secret toggles (`LANGSMITH_TRACING`,
   `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`) as Terraform EB `setting` blocks; the
   secret `LANGSMITH_API_KEY` as an SSM SecureString loaded in
   `loadProductionSecrets()` (`api/src/config/ssm.ts`), which runs before `app.js`
   import. Mirrors how `DATABASE_URL`/`SESSION_SECRET` are already handled.

6. **Never commit the real key.** The live `lsv2_pt_...` key goes only in
   `api/.env.local` (gitignored, confirmed) and SSM. `.env.example` gets a
   placeholder.

---

## High-Level Technical Design

*Directional guidance for review, not implementation specification.*

```
                         LANGSMITH_* in process.env
                                   │
        ┌──────────────────────────┴───────────────────────────┐
        │                                                        │
  CHAT PATH (auto-traced)                       PROACTIVE PATH (needs wrap)
  /api/fleetgraph/chat                          runPlanReview()
   → getCompiledGraph().stream                   → reason.ts
   → scope→fetch→reason→action/output            → evaluateStructured (fleet-ai.ts)
   → ChatAnthropic / ChatOpenAI                  → new OpenAI / new Anthropic   ← RAW SDK
        │                                              │
   LangChain auto-instrumentation            wrapOpenAI() / wrapAnthropicSDK()
        │                                              │
        └──────────────► LangSmith project "fleet" ◄──┘
```

The chat path requires no code. The only code touch is inserting the LangSmith
wrappers around the two raw clients constructed in `fleet-ai.ts`.

---

## Implementation Units

### U1. Add `langsmith` dependency and env-var discoverability

**Goal:** Install the `langsmith` package (for SDK wrappers) and document all
`LANGSMITH_*` vars for local dev; place the real values in the gitignored
`api/.env.local`.

**Requirements:** Enables U3 (wrappers) and local verification.

**Dependencies:** none.

**Files:**
- `api/package.json` (add `langsmith` to `dependencies`; pin a version compatible
  with the installed `@langchain/core` 1.1.48 — verify against the registry, not docs)
- `pnpm-lock.yaml` (lockfile update from install)
- `api/.env.example` (add a documented `LANGSMITH_*` block near the Fleet AI block,
  lines ~23-26 / ~56-62, with placeholder key)
- `api/.env.local` (gitignored — add the four provided values incl. the real key)

**Approach:** Run the workspace-aware install (`pnpm --filter ./api add langsmith`).
Add a commented, self-describing block to `.env.example`:
```
# LangSmith tracing for Fleet (FleetGraph). Auto-traces LangChain/LangGraph runs.
# LANGSMITH_TRACING=true
# LANGSMITH_ENDPOINT=https://api.smith.langchain.com
# LANGSMITH_API_KEY=lsv2_pt_...
# LANGSMITH_PROJECT=fleet
```
Put the live values (uncommented, real key) only in `api/.env.local`.

**Patterns to follow:** The existing Fleet AI env block in `.env.example`
(commented, with inline guidance). The env-reads-from-`process.env`-directly
convention (no config module).

**Test scenarios:** `Test expectation: none -- dependency add + env documentation,
no behavioral code. Verified by U1 verification (install resolves, no peer conflict
with zod v3 pin) and the suite still passing.`

**Verification:** `pnpm --filter ./api install` resolves with no peer-dependency
conflict against the `zod ^3.24.1` pin or `@langchain/*`; `langsmith` appears in
`api/node_modules`; `.env.example` documents all four vars; `.env.local` has the
real values and is still gitignored (`git check-ignore api/.env.local` succeeds).

---

### U2. Disable tracing in the test environment

**Goal:** Guarantee the vitest suite never emits LangSmith traces, regardless of a
developer's `.env.local`.

**Requirements:** Determinism / offline tests (supports the repo's test convention).

**Dependencies:** none (independent of U1).

**Files:**
- `api/vitest.config.ts` (extend the `test.env` block at lines 13-18)

**Approach:** Add `LANGSMITH_TRACING: 'false'` (and, defensively, `LANGSMITH_API_KEY:
''`) to the existing `test.env` object alongside `DATABASE_URL` / `NODE_ENV`.
vitest's `env` injection overrides any inherited shell/.env value for the suite.

**Patterns to follow:** The existing `test.env` overrides in `api/vitest.config.ts`.

**Test scenarios:**
- Happy path: with `LANGSMITH_TRACING=true` exported in the shell, running the
  fleetgraph suite produces no outbound LangSmith calls (models are mocked; the env
  override neutralizes any unmocked path). Verified by the suite running fully
  offline.
- `Test expectation: none for new assertions -- this is a test-harness config
  change; correctness is that the existing suites still pass with no network egress.`

**Verification:** `pnpm test` (api) passes; no LangSmith network activity during the
run even when `LANGSMITH_TRACING=true` is present in the ambient shell.

---

### U3. Instrument the raw-SDK proactive path in `fleet-ai.ts`

**Goal:** Wrap the `OpenAI` and `Anthropic` clients constructed in `fleet-ai.ts` so
the proactive plan-review tier (`runPlanReview` → `reason.ts` → `evaluateStructured`)
produces LangSmith traces. Best-effort, never-throwing, no behavior change when
tracing is off.

**Requirements:** Closes the only auto-tracing blind spot; makes Fleet observability
complete across both tiers.

**Dependencies:** U1 (the `langsmith` package).

**Files:**
- `api/src/services/fleet-ai.ts` (wrap the client construction at ~lines 66-67)
- `api/src/services/fleet-ai.test.ts` (or the nearest existing fleet-ai test file —
  confirm path during implementation; add wrap-related assertions there)

**Approach:** Import `wrapOpenAI` and `wrapAnthropicSDK` from `langsmith/wrappers`
(confirm exact export names against the installed package — the OpenAI wrapper is
`wrapOpenAI`; the Anthropic wrapper export name has varied across langsmith versions,
verify in `node_modules`). Wrap the constructed client before returning it from the
lazy init:
```
// directional, not literal
const client = provider === 'openai'
  ? wrapOpenAI(new OpenAI({ apiKey, timeout, maxRetries }))
  : wrapAnthropicSDK(new Anthropic({ apiKey, timeout, maxRetries }));
```
The wrappers are transparent pass-throughs when `LANGSMITH_TRACING` is unset/false,
so the existing `responses.parse` / `messages.create` calls (lines 152, 167) need no
change. Preserve the existing lazy-init-with-cached-failure and never-throws
contract — wrapping happens inside the same try path and must not introduce a throw.

**Execution note:** Verify wrapper export names and call signatures against the
installed `langsmith` version before wiring (per the zod-v3/v4 learning: trust
`node_modules`, not the README).

**Patterns to follow:** `fleet-ai.ts`'s lazy client init + cached failure + neutral
error union; do not let instrumentation alter the `FleetAiError` contract.

**Test scenarios:**
- Happy path (provider=openai): the lazily-constructed client is the wrapped
  instance; `evaluateStructured` still returns schema-validated JSON for a mocked
  successful response. Mock the SDK so no real call/trace occurs.
- Happy path (provider=anthropic): same, via the Anthropic branch.
- Error path: a thrown SDK error (auth/timeout) still maps to
  `{ error: 'ai_unavailable' }` — wrapping does not change the never-throws
  behavior. Covers the neutral-degradation contract.
- Edge: `FLEET_AI_PROVIDER=none` → no client constructed, no wrapper invoked,
  `isFleetAiError`/availability behavior unchanged.
- Tracing-off invariant: with `LANGSMITH_TRACING` unset (the test default per U2),
  wrapped clients behave identically to unwrapped — existing fleet-ai assertions
  still pass unchanged.

**Verification:** Existing `fleet-ai` tests pass; new assertions confirm the wrapped
client is returned and the error/`none` paths are unchanged; manual run (U5) shows a
proactive plan-review trace in the `fleet` project.

---

### U4. Production env wiring (Elastic Beanstalk + SSM)

**Goal:** Make the `LANGSMITH_*` vars available in production via the repo's two
existing channels, so Fleet traces appear in prod when the feature is enabled.

**Requirements:** Prod observability parity with local.

**Dependencies:** U1 (var names finalized).

**Files:**
- `terraform/elastic-beanstalk.tf` (add `LANGSMITH_TRACING`, `LANGSMITH_ENDPOINT`,
  `LANGSMITH_PROJECT` as `aws:elasticbeanstalk:application:environment` `setting`
  blocks near lines 221-244)
- `terraform/ssm.tf` (add `aws_ssm_parameter` for `LANGSMITH_API_KEY`, type
  `SecureString`, path `/ship/{env}/...`)
- `api/src/config/ssm.ts` (extend `loadProductionSecrets()` ~lines 48-60 to fetch the
  new parameter and assign `process.env.LANGSMITH_API_KEY`)
- `scripts/deploy-api.sh` (only if EB env vars are also re-applied via
  `--option-settings` on environment creation, lines ~184-186 — keep in sync)

**Approach:** Mirror the existing `DATABASE_URL`/`SESSION_SECRET` SSM pattern: declare
the SecureString parameter in Terraform, fetch it in the `Promise.all` block of
`loadProductionSecrets()`, assign to `process.env`. Because that function runs before
`app.js` import (`index.ts:15-18`), the key is present before any graph invoke. The
non-secret toggles go as plain EB settings. **Call out in the PR** that
`FLEET_AI_PROVIDER` + `ANTHROPIC_API_KEY` are still absent in prod (pre-existing gap),
so the deployer can decide whether to set them in the same change to actually turn on
Fleet (and thus traces) in prod.

**Patterns to follow:** Existing SSM parameters in `terraform/ssm.tf` and the
`loadProductionSecrets()` fetch/assign block in `api/src/config/ssm.ts`; the IAM role
already grants `ssm:GetParameter*` on `/ship/{env}/*`.

**Test scenarios:**
- `Test expectation: none -- infrastructure-as-code and prod secret loading; not
  unit-testable without AWS. Verified by Terraform plan review and a prod/shadow
  deploy smoke check (U5).`
- If `loadProductionSecrets()` has existing unit coverage that mocks the SSM client,
  add an assertion that `LANGSMITH_API_KEY` is read and assigned alongside the
  existing parameters (confirm whether such a test exists during implementation).

**Verification:** `terraform plan` shows the new EB settings + SSM parameter with no
unintended diffs; after a shadow/prod deploy, `loadProductionSecrets()` populates
`LANGSMITH_API_KEY` (log line or a one-shot check) and a Fleet run appears in the
`fleet` project. Gated on Fleet provider being configured in that environment.

---

### U5. Verify traces land and document the integration

**Goal:** Confirm end-to-end that both Fleet tiers emit traces to the `fleet`
project locally, and capture the env contract for the team.

**Requirements:** Closes the loop; institutional knowledge capture.

**Dependencies:** U1, U2, U3.

**Files:**
- `docs/fleetgraph/` (add a short `observability.md` or a section in `README.md`
  documenting the `LANGSMITH_*` env contract, what each tier traces, and how to view
  traces) — repo-relative, concise.

**Approach:** With `api/.env.local` carrying the real values and
`FLEET_AI_PROVIDER=anthropic` + key already present locally, run the API and exercise
both paths: (1) a `POST /api/fleetgraph/chat` turn (chat path — auto-traced), and
(2) a proactive `runPlanReview` (raw-SDK path — wrapped in U3). Confirm both appear
as traces in the LangSmith `fleet` project. Document the env contract and the two-tier
tracing model.

**Patterns to follow:** Existing `docs/fleetgraph/*.md` design-doc style.

**Test scenarios:** `Test expectation: none -- manual verification + docs. The
automated guarantee is U2 (tests never trace) and U3 (wrapper unit assertions).`

**Verification:** Both a chat turn and a plan-review run show up as traces under the
`fleet` project in the LangSmith UI; the doc accurately states which vars are required
and what each tier traces. Capture this as a `/ce-compound` learning afterward (the
env contract is new ground for the team).

---

## System-Wide Impact

- **No runtime behavior change when tracing is off** — wrappers are pass-throughs and
  the chat path is untouched.
- **Performance:** LangSmith tracing is asynchronous/batched and best-effort; negligible
  added latency on the hot path. No blocking on trace export.
- **Security:** The API key is a secret — only in gitignored `.env.local` and SSM
  SecureString, never committed, never logged. Trace payloads will include prompts and
  Fleet snapshot data sent to LangSmith's SaaS endpoint — acceptable for this
  observability goal, but note that Fleet inputs (entity data) leave the trust boundary
  when tracing is enabled in a given environment.
- **Tests:** Forced offline via U2.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `langsmith` peer-dep conflict with the `zod ^3.24.1` pin / `@langchain/*` versions | U1 verifies install resolves cleanly against `node_modules`; pin a compatible version (trust the registry, not docs — per the zod-v3/v4 learning) |
| Anthropic wrapper export name differs across `langsmith` versions | U3 execution note: confirm export names/signatures in the installed package before wiring |
| Developer `.env.local` tracing leaks into CI/tests | U2 forces `LANGSMITH_TRACING=false` in `test.env` |
| Real key accidentally committed | Key only in gitignored `.env.local` + SSM; `.env.example` uses a placeholder; verified by `git check-ignore` |
| Prod traces silently absent because Fleet provider isn't set in prod | U4 explicitly calls out the pre-existing `FLEET_AI_PROVIDER`/key gap so the deployer decides |

---

## Verification Strategy (overall)

1. `pnpm --filter ./api install` resolves; `pnpm build` / `pnpm type-check` clean.
2. `pnpm test` (api) passes with no LangSmith egress.
3. Local manual run: chat turn + plan-review both appear as traces in the `fleet`
   project.
4. `terraform plan` shows expected, minimal infra diff.
