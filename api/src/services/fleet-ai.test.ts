import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

// Mock the SDKs so no real client is constructed and no network call fires.
const { openaiParse, anthropicCreate, wrapOpenAIMock, wrapAnthropicMock } = vi.hoisted(() => ({
  openaiParse: vi.fn(),
  anthropicCreate: vi.fn(),
  // Pass-through spies so wrapped clients still route to the mocked SDK methods.
  wrapOpenAIMock: vi.fn((c: unknown) => c),
  wrapAnthropicMock: vi.fn((c: unknown) => c),
}));

vi.mock('openai', () => ({
  default: class {
    responses = { parse: openaiParse };
    constructor(_opts: unknown) {}
  },
}));
vi.mock('openai/helpers/zod', () => ({
  zodTextFormat: (schema: unknown, name: string) => ({ schema, name }),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
    constructor(_opts: unknown) {}
  },
}));
vi.mock('langsmith/wrappers/openai', () => ({ wrapOpenAI: wrapOpenAIMock }));
vi.mock('langsmith/wrappers/anthropic', () => ({ wrapAnthropic: wrapAnthropicMock }));

import {
  evaluateStructured,
  isFleetAiAvailable,
  isFleetAiError,
  checkFleetRefreshRateLimit,
  __resetFleetAiForTests,
} from './fleet-ai.js';

const schema = z.object({ score: z.number() });

const ENV_KEYS = ['FLEET_AI_PROVIDER', 'FLEET_AI_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'LANGSMITH_TRACING', 'LANGSMITH_API_KEY'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.clearAllMocks();
  __resetFleetAiForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function req() {
  return { system: 'sys', user: 'usr', schema, schemaName: 'fleet_test' };
}

describe('isFleetAiAvailable / evaluateStructured — degradation (AE4)', () => {
  it('provider=none → unavailable, no client call, no throw', async () => {
    process.env.FLEET_AI_PROVIDER = 'none';
    expect(isFleetAiAvailable()).toBe(false);
    const result = await evaluateStructured(req());
    expect(isFleetAiError(result) && result.error).toBe('ai_unavailable');
    expect(openaiParse).not.toHaveBeenCalled();
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('provider set but API key missing → unavailable', async () => {
    process.env.FLEET_AI_PROVIDER = 'openai';
    expect(isFleetAiAvailable()).toBe(false);
    const result = await evaluateStructured(req());
    expect(isFleetAiError(result) && result.error).toBe('ai_unavailable');
    expect(openaiParse).not.toHaveBeenCalled();
  });

  it('unrecognized provider value falls back to none', () => {
    process.env.FLEET_AI_PROVIDER = 'gemini';
    process.env.OPENAI_API_KEY = 'sk-x';
    expect(isFleetAiAvailable()).toBe(false);
  });
});

describe('evaluateStructured — OpenAI adapter', () => {
  beforeEach(() => {
    process.env.FLEET_AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  it('returns the parsed object on a schema-valid response', async () => {
    openaiParse.mockResolvedValueOnce({ output_parsed: { score: 6 } });
    const result = await evaluateStructured(req());
    expect(result).toEqual({ score: 6 });
    expect(openaiParse).toHaveBeenCalledTimes(1);
  });

  it('returns ai_parse_error when output_parsed is null (refusal/invalid)', async () => {
    openaiParse.mockResolvedValueOnce({ output_parsed: null });
    const result = await evaluateStructured(req());
    expect(isFleetAiError(result) && result.error).toBe('ai_parse_error');
  });

  it('returns ai_unavailable when the SDK throws (rate limit / connection)', async () => {
    openaiParse.mockRejectedValueOnce(new Error('429 rate limit'));
    const result = await evaluateStructured(req());
    expect(isFleetAiError(result) && result.error).toBe('ai_unavailable');
  });
});

describe('evaluateStructured — Anthropic adapter', () => {
  beforeEach(() => {
    process.env.FLEET_AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  });

  it('returns the parsed object on a complete response', async () => {
    anthropicCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ score: 5 }) }],
    });
    const result = await evaluateStructured(req());
    expect(result).toEqual({ score: 5 });
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('treats stop_reason=max_tokens (truncation) as degraded, not a partial parse', async () => {
    anthropicCreate.mockResolvedValueOnce({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"score":' }],
    });
    const result = await evaluateStructured(req());
    expect(isFleetAiError(result) && result.error).toBe('ai_unavailable');
  });

  it('returns ai_parse_error when the response fails schema validation', async () => {
    anthropicCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ not_score: 1 }) }],
    });
    const result = await evaluateStructured(req());
    expect(isFleetAiError(result) && result.error).toBe('ai_parse_error');
  });

  it('returns ai_parse_error on non-JSON content', async () => {
    anthropicCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'sorry, I cannot' }],
    });
    const result = await evaluateStructured(req());
    expect(isFleetAiError(result) && result.error).toBe('ai_parse_error');
  });
});

describe('LangSmith tracing — raw-SDK proactive path instrumentation', () => {
  it('wraps the OpenAI client when LANGSMITH_TRACING=true', async () => {
    process.env.FLEET_AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.LANGSMITH_TRACING = 'true';
    openaiParse.mockResolvedValueOnce({ output_parsed: { score: 6 } });
    const result = await evaluateStructured(req());
    expect(result).toEqual({ score: 6 });
    expect(wrapOpenAIMock).toHaveBeenCalledTimes(1);
    // Pin that the RAW SDK client (not some other object) was handed to the wrapper.
    expect(wrapOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ responses: expect.any(Object) }),
    );
    expect(wrapAnthropicMock).not.toHaveBeenCalled();
  });

  it('wraps the Anthropic client when LANGSMITH_TRACING=true', async () => {
    process.env.FLEET_AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.LANGSMITH_TRACING = 'true';
    anthropicCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ score: 5 }) }],
    });
    const result = await evaluateStructured(req());
    expect(result).toEqual({ score: 5 });
    expect(wrapAnthropicMock).toHaveBeenCalledTimes(1);
    expect(wrapAnthropicMock).toHaveBeenCalledWith(
      expect.objectContaining({ messages: expect.any(Object) }),
    );
    expect(wrapOpenAIMock).not.toHaveBeenCalled();
  });

  it('does NOT wrap when tracing is off (pass-through, identical behavior)', async () => {
    process.env.FLEET_AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    // LANGSMITH_TRACING unset (suite default is 'false')
    openaiParse.mockResolvedValueOnce({ output_parsed: { score: 6 } });
    const result = await evaluateStructured(req());
    expect(result).toEqual({ score: 6 });
    expect(wrapOpenAIMock).not.toHaveBeenCalled();
    expect(wrapAnthropicMock).not.toHaveBeenCalled();
  });

  it('does not wrap when provider=none (no client constructed)', async () => {
    process.env.FLEET_AI_PROVIDER = 'none';
    process.env.LANGSMITH_TRACING = 'true';
    await evaluateStructured(req());
    expect(wrapOpenAIMock).not.toHaveBeenCalled();
    expect(wrapAnthropicMock).not.toHaveBeenCalled();
  });

  it('falls back to the unwrapped client and still works if wrapping throws', async () => {
    process.env.FLEET_AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.LANGSMITH_TRACING = 'true';
    wrapOpenAIMock.mockImplementationOnce(() => {
      throw new Error('langsmith wrap boom');
    });
    openaiParse.mockResolvedValueOnce({ output_parsed: { score: 7 } });
    const result = await evaluateStructured(req());
    // never-throws contract preserved; unwrapped client still routes the call
    expect(result).toEqual({ score: 7 });
    expect(openaiParse).toHaveBeenCalledTimes(1);
  });

  it('falls back to the unwrapped Anthropic client if wrapping throws', async () => {
    process.env.FLEET_AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.LANGSMITH_TRACING = 'true';
    wrapAnthropicMock.mockImplementationOnce(() => {
      throw new Error('langsmith wrap boom');
    });
    anthropicCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ score: 8 }) }],
    });
    const result = await evaluateStructured(req());
    expect(result).toEqual({ score: 8 });
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });
});

describe('checkFleetRefreshRateLimit', () => {
  it('allows up to the limit then rejects within the window', () => {
    const user = 'user-rate-1';
    let allowed = 0;
    for (let i = 0; i < 35; i++) {
      if (checkFleetRefreshRateLimit(user)) allowed++;
    }
    expect(allowed).toBe(30);
    expect(checkFleetRefreshRateLimit(user)).toBe(false);
  });

  it('tracks limits per user independently', () => {
    expect(checkFleetRefreshRateLimit('user-a')).toBe(true);
    expect(checkFleetRefreshRateLimit('user-b')).toBe(true);
  });
});
