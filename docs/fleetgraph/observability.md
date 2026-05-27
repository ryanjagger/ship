# Fleet observability (LangSmith)

Fleet (the FleetGraph service, `api/src/services/fleetgraph/`) traces every AI run
to [LangSmith](https://docs.smith.langchain.com/) when configured. Traces appear in
the LangSmith project named by `LANGSMITH_PROJECT` (default for this repo: `fleet`).

## Environment contract

| Variable | Purpose | Where it lives |
|---|---|---|
| `LANGSMITH_TRACING` | `true` enables tracing; anything else disables it | `.env.local` (dev), `.ebextensions/01-env.config` (prod, default `false`) |
| `LANGSMITH_ENDPOINT` | LangSmith API base URL | same as above (`https://api.smith.langchain.com`) |
| `LANGSMITH_API_KEY` | secret API key | `.env.local` (dev, gitignored); SSM `/ship/{env}/LANGSMITH_API_KEY` (prod) |
| `LANGSMITH_PROJECT` | project traces land in | same; this repo uses `fleet` |

Tracing activates only when `LANGSMITH_TRACING=true` **and** a key is present. With
the key absent or tracing off, Fleet runs exactly as before — instrumentation is a
no-op. Nothing about tracing can break a Fleet run (best-effort by design).

## Environment metadata on every trace

Every trace carries `metadata.environment` so you can filter and sort runs by
deployment tier in the LangSmith UI:

| `ENVIRONMENT` value | Where it comes from | LangSmith metadata value |
|---|---|---|
| unset | local dev (`.env.local` only sets `LANGSMITH_*`) | `development` (fallback) |
| `shadow` | terraform EB module (`terraform/modules/elastic-beanstalk/main.tf`) | `shadow` |
| `prod` | `api/.ebextensions/01-env.config` | `prod` |

**To filter in LangSmith:** open the project → Runs → Metadata filter → key `environment` → value `prod` (or `shadow`, `development`).

The field is set via `RunnableConfig.metadata` in `chatConfig()` in
`api/src/services/fleetgraph/index.ts`. `streamChatTurn` spreads `chatConfig()`
(`{ ...chatConfig(...), signal }`), so metadata propagates automatically to that
path too. Any future refactor of that spread must preserve the `metadata` field.

---

## What gets traced — two paths

Fleet has two AI tiers, instrumented differently because they use different clients:

1. **Chat path** (`POST /api/fleetgraph/chat` → compiled LangGraph →
   `ChatAnthropic`/`ChatOpenAI`). LangChain/LangGraph **auto-trace** from the
   `LANGSMITH_*` env vars — no code wiring. Each chat turn appears as one trace with
   the `scope → fetch → reason → action/output` nodes nested.

2. **Proactive plan-review path** (`runPlanReview` → `reason.ts` →
   `evaluateStructured` in `api/src/services/fleet-ai.ts`). This tier uses the *raw*
   `openai` / `@anthropic-ai/sdk` clients, which LangChain auto-tracing does not see.
   They are wrapped with `wrapOpenAI` / `wrapAnthropic` from `langsmith/wrappers` so
   `responses.parse` / `messages.create` calls are traced too. The wrapping is gated
   on `LANGSMITH_TRACING` and falls back to the unwrapped client if it ever fails.

## Local setup

Add to `api/.env.local` (gitignored):

```
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_API_KEY=lsv2_pt_...
LANGSMITH_PROJECT=fleet
```

Fleet AI must also be configured (`FLEET_AI_PROVIDER=anthropic|openai` + the matching
key) for there to be any runs to trace. Then exercise a chat turn and/or a plan
review and confirm traces land in the `fleet` project.

## Tests never trace

`api/vitest.config.ts` forces `LANGSMITH_TRACING=false` and clears
`LANGSMITH_API_KEY` for the suite, so a developer's local tracing config cannot leak
into tests or cause network egress.

## Production

- Non-secret toggles (`LANGSMITH_TRACING`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`)
  are set in `api/.ebextensions/01-env.config`. `LANGSMITH_TRACING` ships as `false`;
  flip it to `true` to enable.
- The secret `LANGSMITH_API_KEY` is loaded from SSM Parameter Store at
  `/ship/{env}/LANGSMITH_API_KEY` by `loadProductionSecrets()` in
  `api/src/config/ssm.ts` (best-effort: a missing parameter does not block startup).
  Create it with:

  ```
  aws ssm put-parameter --name /ship/prod/LANGSMITH_API_KEY --type SecureString --value lsv2_pt_...
  ```

> Note: Fleet AI itself (`FLEET_AI_PROVIDER` + provider key) is not yet configured in
> production. Until it is, there are no Fleet runs in prod and therefore no traces,
> regardless of the LangSmith settings above.
