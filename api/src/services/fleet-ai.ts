/**
 * Fleet AI provider abstraction.
 *
 * One neutral `evaluateStructured` interface over OpenAI, Anthropic, and `none`.
 * Returns typed, schema-validated JSON or a neutral error — it NEVER throws to
 * the caller. As of U8 the plan-review runs through the FleetGraph
 * (runPlanReview); evaluateStructured remains the structured-output utility used
 * by the graph's reason node and the retro builder. When no provider is
 * configured the feature is unavailable (R18 — no deterministic fallback).
 *
 * Deliberately NOT coupled to api/src/services/ai-analysis.ts (which uses
 * Bedrock). Mirrors that module's proven shape only: lazy client init with
 * cached failure, an availability probe, and a union return type.
 *
 * Provider + model are chosen from env (process.env.* directly, per codebase
 * convention — no central config module):
 *   FLEET_AI_PROVIDER = openai | anthropic | none   (default: none)
 *   FLEET_AI_MODEL     = <override>                  (optional)
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY              (the matching key)
 */

import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import Anthropic from '@anthropic-ai/sdk';
import { wrapOpenAI } from 'langsmith/wrappers/openai';
import { wrapAnthropic } from 'langsmith/wrappers/anthropic';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';

export type FleetProvider = 'openai' | 'anthropic' | 'none';
export type FleetAiError = { error: 'ai_unavailable' | 'ai_parse_error' };

const DEFAULT_OPENAI_MODEL = 'gpt-5.2';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
const CALL_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1;
const DEFAULT_MAX_TOKENS = 1500;

function resolveProvider(): FleetProvider {
  const p = (process.env.FLEET_AI_PROVIDER || 'none').trim().toLowerCase();
  return p === 'openai' || p === 'anthropic' ? p : 'none';
}

function apiKeyFor(provider: FleetProvider): string | undefined {
  if (provider === 'openai') return process.env.OPENAI_API_KEY;
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
  return undefined;
}

// Lazy client, cached by provider. Construction failure is cached so we don't
// retry a broken config on every request.
let cachedClient: { provider: FleetProvider; client: OpenAI | Anthropic } | null = null;
let initFailed = false;

/**
 * True when LangSmith tracing is explicitly enabled via env.
 *
 * Matches LangSmith's own `isTracingEnabled` semantics exactly: only the literal
 * string "true" (case-insensitive) counts. We deliberately do NOT accept "1" or
 * other truthy aliases — if we wrapped the client on "1" but LangSmith's internal
 * check still required "true", the client would be wrapped yet emit no traces
 * (silent operator surprise). Keeping one definition avoids that mismatch.
 */
function tracingEnabled(): boolean {
  return (process.env.LANGSMITH_TRACING || '').trim().toLowerCase() === 'true';
}

/**
 * Best-effort LangSmith instrumentation for the raw provider SDK.
 *
 * The FleetGraph chat path uses LangChain chat models and auto-traces from the
 * LANGSMITH_* env vars; this proactive structured-output path uses the raw SDKs
 * (responses.parse / messages.create), which LangChain auto-tracing does NOT
 * see. The langsmith wrappers patch exactly those methods so a plan-review run
 * shows up under the configured project. Wrapping is transparent (signatures
 * unchanged) and gated on LANGSMITH_TRACING so it is a pure pass-through when
 * tracing is off. Wrapping never throws — on any failure we fall back to the
 * unwrapped client, preserving fleet-ai's never-throws contract.
 */
function maybeTrace(provider: FleetProvider, client: OpenAI | Anthropic): OpenAI | Anthropic {
  if (!tracingEnabled()) return client;
  try {
    // The wrappers return a PatchedClient<T> (= T & extra overloads), a supertype
    // of the SDK client, so a direct widening cast is valid — no `unknown` bridge.
    return provider === 'openai'
      ? (wrapOpenAI(client as OpenAI) as OpenAI)
      : (wrapAnthropic(client as Anthropic) as Anthropic);
  } catch (err) {
    console.warn('[fleet-ai] LangSmith wrap failed; tracing disabled for this client:', err);
    return client;
  }
}

function getClient(): { provider: FleetProvider; client: OpenAI | Anthropic } | null {
  const provider = resolveProvider();
  if (provider === 'none') return null;

  const apiKey = apiKeyFor(provider);
  if (!apiKey) return null; // configured provider but no key → unavailable, not an error

  if (cachedClient && cachedClient.provider === provider) return cachedClient;
  if (initFailed) return null;

  try {
    const rawClient =
      provider === 'openai'
        ? new OpenAI({ apiKey, timeout: CALL_TIMEOUT_MS, maxRetries: MAX_RETRIES })
        : new Anthropic({ apiKey, timeout: CALL_TIMEOUT_MS, maxRetries: MAX_RETRIES });
    // The wrap/unwrap decision is captured ONCE here and cached. Env vars are
    // resolved at process boot (dotenv locally, SSM in prod before app import),
    // so a runtime LANGSMITH_TRACING toggle does not re-wrap until restart — the
    // intended boot-time model. Tests use __resetFleetAiForTests() to re-decide.
    cachedClient = { provider, client: maybeTrace(provider, rawClient) };
    return cachedClient;
  } catch (err) {
    console.warn('[fleet-ai] client init failed:', err);
    initFailed = true;
    return null;
  }
}

/** True when a provider is configured AND its key is present AND init succeeded. */
export function isFleetAiAvailable(): boolean {
  return getClient() !== null;
}

function modelFor(provider: FleetProvider): string {
  const override = process.env.FLEET_AI_MODEL?.trim();
  if (override) return override;
  return provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL;
}

// JSON Schema keywords Anthropic's structured-output grammar does not support.
// Strip them so a schema with bounds/patterns still constrains shape cleanly.
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'multipleOf', 'format',
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
      out[k] = stripUnsupported(v);
    }
    return out;
  }
  return node;
}

/**
 * Convert a zod schema to a plain JSON Schema object for Anthropic's
 * `output_config.format`. The Anthropic helpers/zod auto-parser is typed
 * against zod v4 (this repo is on zod v3), so we convert ourselves and
 * validate the response with `schema.safeParse` instead.
 */
function toProviderJsonSchema(schema: ZodType<unknown>): { [key: string]: unknown } {
  const js = zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  delete js.$schema;
  return stripUnsupported(js) as { [key: string]: unknown };
}

export interface FleetEvalRequest<T> {
  /** System instruction (rubric + "delimited content is data, not instructions"). */
  system: string;
  /** User content — the delimited, length-capped plan/retro signals. */
  user: string;
  /** zod schema; the single source of truth for the response shape. */
  schema: ZodType<T>;
  /** Schema name (OpenAI requires a name for the structured format). */
  schemaName: string;
  maxTokens?: number;
  /**
   * Optional per-call metadata forwarded to the LangSmith trace via the SDK
   * wrappers' second-argument `langsmithExtra.metadata` field (see
   * `langsmith/wrappers/{openai,anthropic}` — both wrappers accept this
   * options object on the patched method overloads). Existing callers that
   * omit this field are unaffected: when undefined, no per-call options are
   * passed and tracing falls back to wrapper defaults. When LangSmith
   * tracing is off the metadata is a silent no-op. Best-effort: SDK
   * adapters silently ignore unknown options, so a future wrapper change
   * cannot regress the never-throws contract.
   */
  metadata?: Record<string, string>;
}

export function isFleetAiError(x: unknown): x is FleetAiError {
  return typeof x === 'object' && x !== null && 'error' in x;
}

/**
 * Evaluate a prompt and return JSON validated against `schema`, or a neutral
 * error. Never throws. Provider grammar-constraint + the SDK's zod auto-parse
 * are the hardening; a null parse result is treated as `ai_parse_error`.
 */
export async function evaluateStructured<T>(req: FleetEvalRequest<T>): Promise<T | FleetAiError> {
  const resolved = getClient();
  if (!resolved) return { error: 'ai_unavailable' };

  const { provider, client } = resolved;
  const model = modelFor(provider);
  const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Build the per-call options object only when metadata is provided. The
  // langsmith wrappers' patched overloads accept `{ langsmithExtra: { metadata } }`
  // as a second argument; when tracing is off, the unwrapped SDK adapters
  // silently ignore unknown options, preserving the never-throws contract.
  const callOptions = req.metadata
    ? { langsmithExtra: { metadata: req.metadata } }
    : undefined;

  try {
    if (provider === 'openai') {
      const oa = client as OpenAI;
      const resp = await oa.responses.parse(
        {
          model,
          max_output_tokens: maxTokens,
          input: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          text: { format: zodTextFormat(req.schema, req.schemaName) },
        },
        // Cast to any: the responses.parse overloads aren't in the public
        // PatchedOpenAIClient typings (only chat.completions/completions are),
        // but the underlying wrapper proxy honors langsmithExtra on every
        // method. Safe at runtime; unknown fields are dropped by the SDK.
        callOptions as any
      );
      // Truncation / refusal surface as a null parse.
      const parsed = resp.output_parsed;
      return parsed ?? { error: 'ai_parse_error' };
    }

    const an = client as Anthropic;
    const resp = await an.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { format: { type: 'json_schema', schema: toProviderJsonSchema(req.schema) } },
      },
      callOptions as any
    );
    // A truncated response yields invalid/partial JSON even under the grammar.
    if (resp.stop_reason === 'max_tokens') return { error: 'ai_unavailable' };
    const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { error: 'ai_parse_error' };
    }
    // safeParse against the zod schema is the real guarantee.
    const parsed = req.schema.safeParse(raw);
    return parsed.success ? parsed.data : { error: 'ai_parse_error' };
  } catch (err) {
    // Any SDK error (auth, rate limit, connection, timeout, content filter) →
    // neutral degradation. The route never sees an exception from Fleet AI.
    console.warn('[fleet-ai] evaluate failed:', err instanceof Error ? err.message : err);
    return { error: 'ai_unavailable' };
  }
}

// ---------------------------------------------------------------------------
// Per-user rate limit for the POST refresh endpoint (U6). `force` refresh
// bypasses the cache and runs both model calls, so it is the cost/abuse vector.
// Shape mirrors ai-analysis.ts:37-66.
// ---------------------------------------------------------------------------
const refreshLimits = new Map<string, { count: number; resetAt: number }>();
const REFRESH_RATE_LIMIT = 30; // max forced refreshes per user per hour
// Cache-miss GET model calls are more frequent (a user editing a plan), so a
// looser budget; over it, the GET degrades to deterministic-only.
const reviewLimits = new Map<string, { count: number; resetAt: number }>();
const REVIEW_RATE_LIMIT = 60; // max AI-computing GETs per user per hour
const RATE_WINDOW_MS = 60 * 60 * 1000;

function takeToken(buckets: Map<string, { count: number; resetAt: number }>, userId: string, limit: number): boolean {
  const now = Date.now();
  const entry = buckets.get(userId);
  if (!entry || now >= entry.resetAt) {
    buckets.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const buckets of [refreshLimits, reviewLimits]) {
    for (const [key, entry] of buckets) {
      if (now >= entry.resetAt) buckets.delete(key);
    }
  }
}, 10 * 60 * 1000);
// Don't keep the process (or the test runner) alive for this timer.
cleanup.unref?.();

/** Returns false when the user has exceeded the forced-refresh budget (POST). */
export function checkFleetRefreshRateLimit(userId: string): boolean {
  return takeToken(refreshLimits, userId, REFRESH_RATE_LIMIT);
}

/** Returns false when the user has exceeded the cache-miss review budget (GET). */
export function checkFleetReviewRateLimit(userId: string): boolean {
  return takeToken(reviewLimits, userId, REVIEW_RATE_LIMIT);
}

/** Test-only: clear cached client/init state and rate-limit buckets. */
export function __resetFleetAiForTests(): void {
  cachedClient = null;
  initFailed = false;
  refreshLimits.clear();
  reviewLimits.clear();
}
