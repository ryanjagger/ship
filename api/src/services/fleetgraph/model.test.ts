import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

// Mock the LangChain chat-model constructors so NO real client is built and NO
// network call / API key is needed. We capture the constructor args to assert
// provider selection + model resolution. (Mirrors fleet-ai.test.ts's vi.hoisted
// + vi.mock of the SDKs.)
const { openaiCtor, anthropicCtor } = vi.hoisted(() => ({
  openaiCtor: vi.fn(),
  anthropicCtor: vi.fn(),
}));

class FakeStructured {
  // a runnable returned by withStructuredOutput; the test scripts .invoke
  constructor(public invokeImpl: (..._a: unknown[]) => unknown) {}
  async invoke(...args: unknown[]) {
    return this.invokeImpl(...args);
  }
}

// A scripted fake chat model shared by mocked classes and direct injection.
function makeFakeModel(structuredInvoke: (..._a: unknown[]) => unknown) {
  return {
    __fake: true,
    bindTools: vi.fn(function (this: unknown, tools: unknown[]) {
      return { bound: true, tools };
    }),
    withStructuredOutput: vi.fn((_schema: unknown, _cfg: unknown) => new FakeStructured(structuredInvoke)),
  };
}

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    kind = 'openai' as const;
    bindTools(tools: unknown[]) {
      return { bound: true, kind: 'openai', tools };
    }
    withStructuredOutput(_s: unknown, _c: unknown) {
      return new FakeStructured(() => ({ score: 6 }));
    }
    constructor(opts: unknown) {
      openaiCtor(opts);
    }
  },
}));
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    kind = 'anthropic' as const;
    bindTools(tools: unknown[]) {
      return { bound: true, kind: 'anthropic', tools };
    }
    withStructuredOutput(_s: unknown, _c: unknown) {
      return new FakeStructured(() => ({ score: 6 }));
    }
    constructor(opts: unknown) {
      anthropicCtor(opts);
    }
  },
}));

import {
  getChatModel,
  getBoundChatModel,
  isFleetGraphAvailable,
  isFleetGraphError,
  evaluateStructured,
  sanitizeSchemaForProvider,
  setChatModelFactoryForTests,
  __resetFleetGraphModelForTests,
} from './model.js';

const ENV_KEYS = ['FLEET_AI_PROVIDER', 'FLEET_AI_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.clearAllMocks();
  __resetFleetGraphModelForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ── R18: availability gate ─────────────────────────────────────────────────

describe('isFleetGraphAvailable / construction gate (Covers R18)', () => {
  it('provider=none → unavailable and NO model constructed', () => {
    process.env.FLEET_AI_PROVIDER = 'none';
    expect(isFleetGraphAvailable()).toBe(false);
    expect(getChatModel()).toBeNull();
    expect(openaiCtor).not.toHaveBeenCalled();
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it('unset provider defaults to none → unavailable, no model', () => {
    expect(isFleetGraphAvailable()).toBe(false);
    expect(getChatModel()).toBeNull();
    expect(openaiCtor).not.toHaveBeenCalled();
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it('provider set but key missing → unavailable, no model constructed', () => {
    process.env.FLEET_AI_PROVIDER = 'openai';
    expect(isFleetGraphAvailable()).toBe(false);
    expect(getChatModel()).toBeNull();
    expect(openaiCtor).not.toHaveBeenCalled();
  });

  it('unrecognized provider value falls back to none', () => {
    process.env.FLEET_AI_PROVIDER = 'gemini';
    process.env.OPENAI_API_KEY = 'sk-x';
    expect(isFleetGraphAvailable()).toBe(false);
    expect(getChatModel()).toBeNull();
  });
});

// ── provider selection + model resolution ───────────────────────────────────

describe('chat-model provider selection + FLEET_AI_MODEL', () => {
  it('openai → ChatOpenAI with default model', () => {
    process.env.FLEET_AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    const m = getChatModel();
    expect(m).not.toBeNull();
    expect((m as unknown as { kind: string }).kind).toBe('openai');
    expect(openaiCtor).toHaveBeenCalledTimes(1);
    expect(openaiCtor.mock.calls[0]?.[0]).toMatchObject({ model: 'gpt-5.2', apiKey: 'sk-test' });
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it('anthropic → ChatAnthropic with default model', () => {
    process.env.FLEET_AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const m = getChatModel();
    expect((m as unknown as { kind: string }).kind).toBe('anthropic');
    expect(anthropicCtor).toHaveBeenCalledTimes(1);
    expect(anthropicCtor.mock.calls[0]?.[0]).toMatchObject({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-test' });
    expect(openaiCtor).not.toHaveBeenCalled();
  });

  it('FLEET_AI_MODEL overrides the default for the selected provider', () => {
    process.env.FLEET_AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.FLEET_AI_MODEL = 'gpt-custom';
    getChatModel();
    expect(openaiCtor.mock.calls[0]?.[0]).toMatchObject({ model: 'gpt-custom' });
  });

  it('getBoundChatModel binds tools onto the constructed model', () => {
    process.env.FLEET_AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    const tools = [{ name: 't1' }] as never;
    const bound = getBoundChatModel(tools);
    expect(bound).toMatchObject({ bound: true, kind: 'openai' });
  });

  it('getBoundChatModel returns null when unavailable', () => {
    process.env.FLEET_AI_PROVIDER = 'none';
    expect(getBoundChatModel([] as never)).toBeNull();
  });
});

// ── tool-schema sanitizer (zod v3 discipline) ────────────────────────────────

describe('sanitizeSchemaForProvider (Anthropic keyword stripping)', () => {
  const schema = z.object({
    score: z.number().min(0).max(10),
    label: z.string().min(1).max(50).regex(/^[a-z]+$/),
    email: z.string().email(),
    count: z.number().multipleOf(2),
  });

  it('strips unsupported keywords + $schema for the anthropic path', () => {
    const out = sanitizeSchemaForProvider(schema, 'anthropic');
    const json = JSON.stringify(out);
    expect(out.$schema).toBeUndefined();
    for (const kw of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'multipleOf', 'format']) {
      expect(json).not.toContain(`"${kw}"`);
    }
    // shape is preserved — still a valid object schema with the properties
    const props = (out.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['count', 'email', 'label', 'score']);
    expect(out.type).toBe('object');
  });

  it('always drops $schema even for the openai path, keeping bounds', () => {
    const out = sanitizeSchemaForProvider(schema, 'openai');
    expect(out.$schema).toBeUndefined();
    // openai grammar tolerates bounds; they are NOT stripped
    expect(JSON.stringify(out)).toContain('minimum');
  });

  it('produces JSON Schema parseable as a valid grammar object (no $ref)', () => {
    const out = sanitizeSchemaForProvider(schema, 'anthropic');
    expect(JSON.stringify(out)).not.toContain('$ref');
  });
});

// ── structured-output helper: never throws ───────────────────────────────────

describe('evaluateStructured — never throws (neutral degradation)', () => {
  const schema = z.object({ score: z.number() });
  const req = (over?: Partial<Parameters<typeof evaluateStructured>[0]>) => ({
    system: 'sys',
    user: 'usr',
    schema,
    schemaName: 'fleet_test',
    ...over,
  });

  it('provider=none → ai_unavailable, no throw', async () => {
    process.env.FLEET_AI_PROVIDER = 'none';
    const r = await evaluateStructured(req());
    expect(isFleetGraphError(r) && r.error).toBe('ai_unavailable');
  });

  it('a model that throws maps to ai_unavailable (never propagated)', async () => {
    const fake = makeFakeModel(() => {
      throw new Error('429 rate limit');
    });
    const r = await evaluateStructured(req({ modelOverride: fake as never }));
    expect(isFleetGraphError(r) && r.error).toBe('ai_unavailable');
  });

  it('malformed / schema-invalid output maps to ai_parse_error', async () => {
    const fake = makeFakeModel(() => ({ not_score: 'nope' }));
    const r = await evaluateStructured(req({ modelOverride: fake as never }));
    expect(isFleetGraphError(r) && r.error).toBe('ai_parse_error');
  });

  it('schema-valid output is returned, validated by safeParse', async () => {
    const fake = makeFakeModel(() => ({ score: 7 }));
    const r = await evaluateStructured(req({ modelOverride: fake as never }));
    expect(r).toEqual({ score: 7 });
  });
});

// ── R20: scripted fake chat model injection ──────────────────────────────────

describe('test seam — scripted fake chat model (Covers R20)', () => {
  it('modelOverride bypasses provider/key entirely', () => {
    // No provider, no key set.
    const fake = makeFakeModel(() => ({ score: 1 }));
    const m = getChatModel({ modelOverride: fake as never });
    expect(m).toBe(fake);
    expect(openaiCtor).not.toHaveBeenCalled();
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it('getBoundChatModel uses the injected fake and binds tools', () => {
    const fake = makeFakeModel(() => ({}));
    const tools = [{ name: 'read_project' }] as never;
    const bound = getBoundChatModel(tools, { modelOverride: fake as never });
    expect(fake.bindTools).toHaveBeenCalledWith(tools);
    expect(bound).toMatchObject({ bound: true });
  });

  it('setChatModelFactoryForTests replaces the module-wide factory', () => {
    process.env.FLEET_AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    const fake = makeFakeModel(() => ({}));
    setChatModelFactoryForTests(() => fake as never);
    const m = getChatModel();
    expect(m).toBe(fake);
    // real ctor not used because the factory was replaced
    expect(openaiCtor).not.toHaveBeenCalled();
  });
});
