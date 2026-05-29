---
title: "Anthropic SDK zod helper targets zod v4 while the repo uses zod v3"
date: 2026-05-25
category: integration-issues
module: fleet-ai
problem_type: integration_issue
component: service_object
symptoms:
  - "tsc error: Argument of type 'ZodType<T, ZodTypeDef, T>' is not assignable, missing properties def, type, check, clone"
  - "@anthropic-ai/sdk/helpers/zod zodOutputFormat rejects the project's zod v3 schemas"
  - "Cannot upgrade zod to v4 repo-wide: it breaks openai/helpers/zod (openai-node #1602/#1739/#1597)"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
related_components:
  - assistant
  - tooling
tags:
  - zod
  - anthropic-sdk
  - openai-sdk
  - structured-output
  - json-schema
  - provider-abstraction
---

# Anthropic SDK zod helper targets zod v4 while the repo uses zod v3

## Problem

Two AI SDKs ship zod helpers that target opposite zod majors: `@anthropic-ai/sdk`'s `zodOutputFormat` / `messages.parse` is typed against zod **v4**, while `openai/helpers/zod`'s `zodTextFormat` works on zod **v3** (and breaks on v4). On a repo pinned to `zod ^3.24.1`, the Anthropic auto-parse path fails to type-check, so a single neutral `evaluateStructured` interface (`api/src/services/fleet-ai.ts`) cannot naively reuse both SDKs' built-in zod helpers.

## Symptoms

`tsc` fails on the Anthropic adapter when feeding a zod v3 schema into `zodOutputFormat(schema)` / `client.messages.parse(...)`:

```
Argument of type 'ZodType<T, ZodTypeDef, T>' is not assignable to parameter of type '$ZodType<...>'
  Type 'ZodType<...>' is missing the following properties from type '...': def, type, check, clone
```

`def` / `type` / `check` / `clone` are zod **v4** internals (`$ZodTypeInternals`). The repo is on `zod ^3.24.1`, so its `ZodType` doesn't have them. Meanwhile `openai/helpers/zod` (`zodTextFormat`) accepts the same zod v3 schema fine — and is documented to break on zod v4 (openai-node issues #1602 / #1739 / #1597). The two helpers point at opposite zod majors.

## What Didn't Work

1. **Use Anthropic's auto-parse helper** (`zodOutputFormat` + `messages.parse`). Type-check failure above — the helper's parameter type is zod-v4-shaped and a zod v3 `ZodType` is structurally incompatible.
2. **Upgrade the repo to zod v4.** Would satisfy Anthropic's helper but break `openai/helpers/zod` (`zodTextFormat`) and every other zod v3 consumer in the repo — trading one broken adapter for another, plus collateral breakage.

## Solution

Keep one zod schema as the source of truth, but use a different output path per provider. OpenAI keeps its v3-compatible helper; Anthropic skips its v4-typed helper entirely — convert the schema to plain JSON Schema and validate the response ourselves with the same zod schema.

**OpenAI adapter** (zod v3 helper works as-is):

```ts
const oa = client as OpenAI;
const resp = await oa.responses.parse({
  model,
  max_output_tokens: maxTokens,
  input: [
    { role: 'system', content: req.system },
    { role: 'user', content: req.user },
  ],
  text: { format: zodTextFormat(req.schema, req.schemaName) },
});
const parsed = resp.output_parsed;        // truncation / refusal → null
return parsed ?? { error: 'ai_parse_error' };
```

**Anthropic adapter** — before (does not compile):

```ts
// import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
const resp = await an.messages.parse({
  model, max_tokens, system, messages,
  output_config: { format: zodOutputFormat(req.schema) },   // ❌ TS: zod-v4-typed param
});
```

After — convert zod v3 → JSON Schema, strip the keywords Anthropic's grammar rejects, then `safeParse` the response with the original schema:

```ts
import { zodToJsonSchema } from 'zod-to-json-schema';

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'multipleOf', 'format',
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;   // drop bounds / patterns / format
      out[k] = stripUnsupported(v);
    }
    return out;
  }
  return node;
}

function toProviderJsonSchema(schema: ZodType<unknown>): { [k: string]: unknown } {
  const js = zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  delete js.$schema;                       // Anthropic grammar rejects $schema
  return stripUnsupported(js) as { [k: string]: unknown };
}
```

```ts
const an = client as Anthropic;
const resp = await an.messages.create({
  model,
  max_tokens: maxTokens,
  system: req.system,
  messages: [{ role: 'user', content: req.user }],
  output_config: { format: { type: 'json_schema', schema: toProviderJsonSchema(req.schema) } },
});

if (resp.stop_reason === 'max_tokens') return { error: 'ai_unavailable' };   // truncated
const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();

let raw: unknown;
try { raw = JSON.parse(text); } catch { return { error: 'ai_parse_error' }; }

const parsed = req.schema.safeParse(raw);             // the real guarantee
return parsed.success ? parsed.data : { error: 'ai_parse_error' };
```

The whole call is wrapped so any SDK throw (auth, rate limit, timeout, content filter) becomes `{ error: 'ai_unavailable' }`. `evaluateStructured` never throws — the caller always has a deterministic fallback.

## Why This Works

- **The two SDK helpers target opposite zod majors.** `openai/helpers/zod` is zod v3; `@anthropic-ai/sdk/helpers/zod` is zod v4. You cannot satisfy both with one installed zod version, so only the v3-compatible helper (OpenAI) is used directly.
- **Converting to JSON Schema + `safeParse` decouples Anthropic from the helper's version expectation.** `zodToJsonSchema` produces a plain object the Anthropic SDK accepts regardless of zod major, and runtime validation is done by the original zod v3 schema via `safeParse` — no zod-v4-typed code touches the call.
- **One authoritative schema.** The same `req.schema` drives OpenAI's format, Anthropic's JSON Schema, and the post-parse validation. Provider grammar-constraint is best-effort hardening; `safeParse` is the actual contract, so both providers return identically-typed, validated data.

## Prevention

- **Verify the installed SDK's structured-output API against the actually-installed version, not the docs.** Helper type signatures track the SDK's expected peer zod major and shift across releases; inspect the types in `node_modules`, not the README.
- **Pin zod to v3 while `openai/helpers/zod` is v3-only** (openai-node #1602 / #1739 / #1597). Don't upgrade zod to satisfy one SDK without auditing every zod consumer in the repo.
- **Always `safeParse` model output** even when the provider claims schema-constrained generation. Grammar constraints are best-effort; runtime validation against your own schema is the only guarantee.
- **Make the provider abstraction return a neutral, never-throws error union** (`{ error: 'ai_unavailable' | 'ai_parse_error' }`) so callers get a deterministic fallback instead of exceptions. Map truncation (`stop_reason === 'max_tokens'`), JSON parse failure, refusal, and SDK throws all into that union.
- **Strip the unsupported JSON-Schema keyword subset for Anthropic** (`minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` / `minLength` / `maxLength` / `pattern` / `multipleOf` / `format`, plus `$schema`) and use `$refStrategy: 'none'`, so schemas carrying bounds/patterns still constrain shape without tripping the grammar.
- **Entity-escape user content in delimited prompts** (`<` → `&lt;`, `>` → `&gt;`) and instruct the model that delimited content is data, not instructions, to limit prompt injection through the `user` field.

## Related Issues

- [Claude Context API for AI-Powered Skills](./claude-context-api-for-ai-skills.md) — the other AI-integration learning in this repo (a context-supply HTTP endpoint for skills); different problem and solution, same "design AI integrations deliberately" theme.
- Implementation: `api/src/services/fleet-ai.ts` (the provider abstraction), consumed by `api/src/services/fleet-service.ts`.
- Upstream: openai-node zod-v4 breakage — issues #1602, #1739, #1597.
