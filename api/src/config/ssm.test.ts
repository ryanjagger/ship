import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the AWS SDK so no real SSM call fires. The mock send is controlled per-test.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = sendMock;
    constructor(_opts: unknown) {}
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { getSSMSecretOptional } from './ssm.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getSSMSecretOptional — never-throws optional secret loader', () => {
  it('returns the parameter value on success', async () => {
    sendMock.mockResolvedValueOnce({ Parameter: { Value: 'lsv2_pt_secret' } });
    await expect(getSSMSecretOptional('/ship/prod/LANGSMITH_API_KEY')).resolves.toBe('lsv2_pt_secret');
  });

  it('returns undefined (no throw) when the parameter is absent', async () => {
    const err = Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
    sendMock.mockRejectedValueOnce(err);
    await expect(getSSMSecretOptional('/ship/prod/MISSING')).resolves.toBeUndefined();
  });

  it('returns undefined (no throw) when SSM fails with an infrastructure error', async () => {
    const err = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    sendMock.mockRejectedValueOnce(err);
    await expect(getSSMSecretOptional('/ship/prod/LANGSMITH_API_KEY')).resolves.toBeUndefined();
  });

  it('logs a warning for non-not-found errors but still fails open', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMock.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    await expect(getSSMSecretOptional('/ship/prod/LANGSMITH_API_KEY')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('ThrottlingException');
    warnSpy.mockRestore();
  });

  it('does NOT warn for an expected ParameterNotFound', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMock.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'ParameterNotFound' }));
    await getSSMSecretOptional('/ship/prod/MISSING');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('treats an empty-string parameter value as undefined', async () => {
    sendMock.mockResolvedValueOnce({ Parameter: { Value: '' } });
    await expect(getSSMSecretOptional('/ship/prod/LANGSMITH_API_KEY')).resolves.toBeUndefined();
  });

  it('never leaks the secret value into the warning log', async () => {
    // A warning on infra error must reference the parameter NAME, never a value.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'InternalServerError' }));
    await getSSMSecretOptional('/ship/prod/LANGSMITH_API_KEY');
    const logged = String(warnSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('/ship/prod/LANGSMITH_API_KEY');
    warnSpy.mockRestore();
  });
});
