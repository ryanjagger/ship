---
title: LangSmith two-tier tracing for Fleet (auto-trace LangGraph, wrap the raw-SDK path)
date: 2026-05-26
category: docs/solutions/tooling-decisions
module: fleetgraph
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Adding LangSmith (or any LangChain-callback-based) observability to Fleet
  - Touching api/src/services/fleet-ai.ts or the fleetgraph reason node
  - "Wondering why a Fleet plan-review run does not appear in LangSmith while chat turns do"
  - Bumping the langsmith or @langchain/* package versions
tags: [langsmith, langchain, langgraph, tracing, observability, fleet-ai, fleetgraph, env-config, ssm]
---

# LangSmith two-tier tracing for Fleet (auto-trace LangGraph, wrap the raw-SDK path)

## Context

Fleet has **two** AI tiers that reach LLMs through **different clients**, and LangSmith
instruments them differently. Getting tracing "working" by setting env vars covers only
one of the two — the other stays an invisible black box unless you wrap it explicitly.

- **Chat path** (`POST /api/fleetgraph/chat` → compiled LangGraph → `ChatAnthropic` /
  `ChatOpenAI`): pure LangChain/LangGraph. **Auto-traces** from the standard `LANGSMITH_*`
  env vars with zero code changes — each turn appears as one trace with the
  `scope → fetch → reason → action/output` nodes nested.
- **Proactive plan-review path** (`runPlanReview` → `nodes/reason.ts` →
  `evaluateStructured` in `api/src/services/fleet-ai.ts`): uses the **raw** `openai` /
  `@anthropic-ai/sdk` clients (`responses.parse` / `messages.create`). LangChain
  auto-tracing **does not see these** — they produce no traces until wrapped.

(For *why* `fleet-ai.ts` uses raw SDK clients rather than LangChain models, see the sibling
learning `../integration-issues/anthropic-sdk-zod-v3-v4-structured-output-mismatch.md` —
the zod-v3/v4 incompatibility is the reason that path bypasses the LangChain helpers.)

## Guidance

**1. Chat / LangGraph path: env vars only — do not add manual `traceable` wrappers.**
Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`
in the environment. dotenv loads them at the top of `api/src/index.ts` before any graph
module runs, so they are present before the first invoke. Nothing else is required.

**2. Raw-SDK path: wrap the constructed client, gated and best-effort.** In
`fleet-ai.ts`, wrap the lazily-constructed client with `wrapOpenAI` / `wrapAnthropic` from
`langsmith/wrappers` — they patch `responses.parse` / `messages.create` transparently:

```ts
import { wrapOpenAI } from 'langsmith/wrappers/openai';
import { wrapAnthropic } from 'langsmith/wrappers/anthropic';

function tracingEnabled(): boolean {
  // Match LangSmith's own isTracingEnabled exactly: only literal "true".
  return (process.env.LANGSMITH_TRACING || '').trim().toLowerCase() === 'true';
}

function maybeTrace(provider, client) {
  if (!tracingEnabled()) return client;          // pure pass-through when off
  try {
    return provider === 'openai'
      ? (wrapOpenAI(client as OpenAI) as OpenAI)   // PatchedClient<T> is a supertype of T
      : (wrapAnthropic(client as Anthropic) as Anthropic);
  } catch (err) {
    console.warn('[fleet-ai] LangSmith wrap failed; tracing disabled for this client:', err);
    return client;                               // never break the AI path
  }
}
```

Two non-obvious correctness rules baked in above:
- **Gate on the literal `"true"`** — *do not* also accept `"1"`. If `maybeTrace` wraps on
  `"1"` but LangSmith's internal `isTracingEnabled` only honors `"true"`, the client is
  wrapped yet emits no traces — a silent "why are there no traces" footgun.
- **Wrap inside a try/catch and fall back to the unwrapped client.** This preserves
  `fleet-ai.ts`'s never-throws contract: a wrapper failure (or unreachable LangSmith)
  must degrade silently, not break a Fleet run.

**3. Tests must never emit traces.** Force it off in `api/vitest.config.ts` `test.env`
(`LANGSMITH_TRACING: 'false'`, `LANGSMITH_API_KEY: ''`) so a developer's local
`.env.local` can't leak tracing/network egress into the suite. Same discipline as the
`DATABASE_URL`/`NODE_ENV` overrides (see `../test-failures/test-suite-truncates-shared-dev-database.md`).

**4. Production secret loads optionally — never block startup.** Non-secret toggles
(`LANGSMITH_TRACING`/`ENDPOINT`/`PROJECT`) go in `.ebextensions/01-env.config` (default
`false`); the secret key is fetched best-effort in `loadProductionSecrets()`:

```ts
export async function getSSMSecretOptional(name: string): Promise<string | undefined> {
  try {
    const r = await getClient().send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return r.Parameter?.Value || undefined;
  } catch (err) {
    const n = (err as { name?: string })?.name;
    if (n !== 'ParameterNotFound' && n !== 'ParameterVersionNotFound') {
      console.warn(`[ssm] optional parameter ${name} could not be read (${n}); continuing without it`);
    }
    return undefined; // fail open — a missing optional secret must not block boot
  }
}
```
Note the asymmetry: an *absent* parameter is silent (expected), but an IAM/network error
warns (otherwise a misconfigured prod role silently disables tracing with no signal).

## Why This Matters

The naive mental model — "set the env vars and everything traces" — is true for LangChain
code and false for raw SDK calls in the same app. A mixed codebase will show you a
confident, partial picture: chat turns trace, proactive runs vanish, and you debug the
wrong layer. Knowing *which client a path uses* is the deciding factor for whether
auto-tracing covers it.

This investment paid off immediately: a real logic bug (Fleet chat couldn't resolve
"assign to me") was caught by reading a LangSmith chat trace — see
`../logic-errors/fleet-chat-cannot-resolve-assign-to-me.md`.

## When to Apply

- Adding observability to any app that mixes LangChain/LangGraph with direct provider SDKs.
- Reviewing why some LLM calls trace and others don't.
- Before bumping `langsmith` or `@langchain/*` — verify wrapper export names
  (`wrapOpenAI`, `wrapAnthropic`) and that the OpenAI wrapper still patches `responses.parse`
  against the *installed* package, not the README (same version-coupling discipline as the
  zod-v3/v4 learning).

## Examples

| Path | Client | Traced by |
|------|--------|-----------|
| `/api/fleetgraph/chat` | LangChain `ChatAnthropic`/`ChatOpenAI` | Auto, from `LANGSMITH_*` env vars |
| Proactive plan review | Raw `openai` / `@anthropic-ai/sdk` | `wrapOpenAI` / `wrapAnthropic` in `fleet-ai.ts` |

Verify a thread end-to-end via the REST API (no CLI needed):
```bash
# resolve the project's tracer-session id, then query root runs grouped by thread_id metadata
curl -s -G "$LANGSMITH_ENDPOINT/api/v1/sessions" --data-urlencode "name=$LANGSMITH_PROJECT" \
  -H "x-api-key: $LANGSMITH_API_KEY"
curl -s -X POST "$LANGSMITH_ENDPOINT/api/v1/runs/query" -H "x-api-key: $LANGSMITH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"session":["<session-id>"],"is_root":true,"filter":"and(eq(metadata_key, \"thread_id\"), eq(metadata_value, \"<thread-uuid>\"))"}'
```
A HITL `Command` resume (write-confirmation) correctly traces with **0 tokens** — the
"resume never re-bills" design is visible in the trace.

## Related

- `../integration-issues/anthropic-sdk-zod-v3-v4-structured-output-mismatch.md` — why `fleet-ai.ts` uses raw SDK clients (the path that needs manual wrapping)
- `../logic-errors/fleet-chat-cannot-resolve-assign-to-me.md` — a bug this observability surfaced
- GitHub #29 — enabling Fleet AI in production via the SSM loader + `.ebextensions` (the prod mechanism this learning uses)
