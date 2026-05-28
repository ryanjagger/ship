---
title: Mock at the SUT's direct import boundary, not through langsmith-wrapped transitive modules
date: 2026-05-28
category: docs/solutions/conventions
module: testing-infrastructure
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing vitest tests that need to mock a function several modules deep in the import graph
  - The intervening module imports a langsmith SDK wrapper (langsmith/wrappers/openai, /anthropic) at top level
  - "vi.mock() of the transitive dependency appears configured correctly but mock fns never fire"
  - Tests pass on the mocked SQL/HTTP shape but the real LLM call signal never arrives at the mock
tags: [vitest, vi-mock, langsmith, langchain, testing-patterns, fleetgraph, module-mocking]
---

# Mock at the SUT's direct import boundary, not through langsmith-wrapped transitive modules

## Context

When writing tests for `sweepWorkspaceDrift` in `api/src/services/fleetgraph/sweep.test.ts` and `sweep.concurrency.test.ts`, the import chain was:

```
sweep.ts
  └── verdictGenerator.ts        ← imports evaluateStructured from fleet-ai.ts
        └── fleet-ai.ts          ← wraps OpenAI/Anthropic SDKs with langsmith wrappers at module load
              └── evaluateStructured  ← actual LLM call site
```

The natural test design was to mock the LLM call by intercepting `evaluateStructured` from `fleet-ai.ts`:

```typescript
// sweep.concurrency.test.ts (initial, broken attempt)
const { mockEvaluateStructured } = vi.hoisted(() => ({ mockEvaluateStructured: vi.fn() }));

vi.mock('../fleet-ai.js', async () => {
  const actual = await vi.importActual<typeof import('../fleet-ai.js')>('../fleet-ai.js');
  return { ...actual, evaluateStructured: mockEvaluateStructured };
});
```

The mock didn't fire. Sweep ran, `verdictGenerator` called `evaluateStructured`, but `mockEvaluateStructured.mock.calls.length === 0`. No vitest hoisting error, no warning, just silent pass-through to the real module.

The suspected cause: `fleet-ai.ts` imports `langsmith/wrappers/openai` and `langsmith/wrappers/anthropic` and wraps SDK client instances at top-level module evaluation. The interaction between vitest's module-mock resolution and the langsmith wrapper's module-graph manipulation produced a state where the SUT's transitive dependency on `evaluateStructured` resolved to the unmocked original.

## Guidance

**Mock at the SUT's direct import, not through a langsmith-wrapped intermediate module.**

Sweep.ts imports `generateDriftVerdict` directly from `'./verdictGenerator.js'`. Moving the mock to that boundary worked first try:

```typescript
// sweep.concurrency.test.ts (working pattern)
const { mockGenerateDriftVerdict } = vi.hoisted(() => ({ mockGenerateDriftVerdict: vi.fn() }));

vi.mock('./verdictGenerator.js', async () => {
  const actual = await vi.importActual<typeof import('./verdictGenerator.js')>('./verdictGenerator.js');
  return { ...actual, generateDriftVerdict: mockGenerateDriftVerdict };
});
```

The same rule applied later when `verdictGenerator.ts` was deleted and sweep started importing `runDriftReasoning` directly from `'./index.js'`: the mock moved to `vi.mock('./index.js', ...)` and worked first try.

**Rule of thumb:** identify the function the SUT *itself* imports — that's where the mock goes. If that function happens to be a thin re-export or pass-through, mock it anyway. The boundary you can reliably mock is the SUT's import surface, not deeper.

## Why This Matters

**Mocks that don't fire are silently catastrophic.** The mocked-pool unit tests in this PR series all passed because they asserted SQL/HTTP shape via `mockPoolQuery.mock.calls[0]` rather than the LLM call's behavior. The real-Postgres concurrency tests (`sweep.concurrency.test.ts` C5 and C6) — which DID depend on the mock firing to drive SUPPRESS / fallback scenarios — failed loudly:

```
AssertionError: expected 0 to be 1
  // suppressed counter never incremented because the mock never returned SUPPRESS
  // because the real evaluateStructured was called instead of the mock
```

The diagnostic signal that surfaces this class of bug:

```typescript
// Add this assertion to confirm the mock is even reachable:
expect(mockEvaluateStructured).toHaveBeenCalled();
```

If the assertion fails, the mock-boundary problem is the diagnosis — not test setup, not fixture state, not race conditions.

The cost of the wrong mock boundary is the test silently exercising the real code path. For an LLM-bound test, that means a real network call, a real API charge, and non-deterministic test output. None of those signal "mock misconfigured" — they signal "test is flaky" or "test is slow", which leads to the wrong fix.

## When to Apply

Apply when **all** of these are true:

- The SUT is a service module that calls an LLM through `fleet-ai.ts`'s `evaluateStructured` (or any future raw-SDK wrapper that uses langsmith wrappers at module load)
- The test needs deterministic LLM responses (SUPPRESS, specific decisions, error shapes)
- The natural mock target is several import-hops away from the SUT

Skip when:

- The SUT directly imports `evaluateStructured` itself — then mock that boundary; you don't need an intermediate
- You're writing an integration test that *should* call the real LLM (rare; requires opt-in env config)
- The intervening modules don't import langsmith wrappers (then the transitive mock works fine)

## Examples

### Mocking generateDriftVerdict (the verdictGenerator entry point sweep called directly)

```typescript
// sweep.test.ts — works
const { mockGenerateDriftVerdict } = vi.hoisted(() => ({
  mockGenerateDriftVerdict: vi.fn(),
}));

vi.mock('./verdictGenerator.js', async () => {
  const actual = await vi.importActual<typeof import('./verdictGenerator.js')>(
    './verdictGenerator.js'
  );
  return { ...actual, generateDriftVerdict: mockGenerateDriftVerdict };
});

// In tests:
mockGenerateDriftVerdict.mockResolvedValue({
  verdict: { decision: 'SUPPRESS', reasoning: 'noise' },
  degraded: false,
  source: 'llm',
});
```

### Mocking runDriftReasoning (the graph entry point sweep called after refactor)

```typescript
// sweep.concurrency.test.ts — current working pattern, mocks at index.js boundary
const { mockRunDriftReasoning } = vi.hoisted(() => ({
  mockRunDriftReasoning: vi.fn(),
}));

vi.mock('./index.js', async () => {
  const actual = await vi.importActual<typeof import('./index.js')>('./index.js');
  return { ...actual, runDriftReasoning: mockRunDriftReasoning };
});

// In tests:
mockRunDriftReasoning.mockResolvedValue({ available: false });   // forces fallback
```

### Anti-pattern: mocking evaluateStructured directly (mock doesn't fire when there's an intervening langsmith-wrapped module)

```typescript
// DON'T do this when sweep.ts → verdictGenerator.ts → evaluateStructured.
// The mock won't propagate.

vi.mock('../fleet-ai.js', async () => {
  const actual = await vi.importActual<typeof import('../fleet-ai.js')>('../fleet-ai.js');
  return { ...actual, evaluateStructured: mockEvaluateStructured };  // ← silently bypassed
});
```

The exception: if the SUT *directly* imports `evaluateStructured` from `fleet-ai.ts` (no intermediate), this pattern works because no langsmith-wrapped module sits between the SUT and the mock target.

### Diagnostic to confirm before adding more test setup

When a mock-driven test fails in a way that suggests the mock isn't firing, add one assertion:

```typescript
expect(mockEvaluateStructured).toHaveBeenCalled();
// or
expect(mockGenerateDriftVerdict).toHaveBeenCalled();
```

If the assertion fails, move the mock to a boundary closer to the SUT.
