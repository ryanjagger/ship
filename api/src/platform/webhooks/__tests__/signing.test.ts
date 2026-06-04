import { describe, it, expect } from 'vitest';
import {
  signPayload,
  buildSignatureHeader,
  parseSignatureHeader,
  verifySignature,
} from '../signing.js';

describe('webhook signing', () => {
  const secret = 'whsec_test_secret_value';
  const rawBody = JSON.stringify({ id: 'evt_1', type: 'issue.created', data: { object: { id: 'x' } } });
  const now = 1_780_500_000;
  const header = buildSignatureHeader(secret, now, rawBody);

  it('verifies a valid signature (positive)', () => {
    expect(verifySignature({ header, rawBody, secret, now })).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifySignature({ header, rawBody, secret: 'whsec_other', now })).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(verifySignature({ header: 'garbage', rawBody, secret, now })).toBe(false);
    expect(verifySignature({ header: 't=,v1=', rawBody, secret, now })).toBe(false);
    expect(verifySignature({ header: `v1=${signPayload(secret, now, rawBody)}`, rawBody, secret, now })).toBe(false);
    expect(verifySignature({ header: `t=${now}`, rawBody, secret, now })).toBe(false);
    expect(verifySignature({ header: undefined, rawBody, secret, now })).toBe(false);
  });

  it('rejects a stale timestamp (replay)', () => {
    const stale = now - 301;
    const staleHeader = buildSignatureHeader(secret, stale, rawBody);
    expect(verifySignature({ header: staleHeader, rawBody, secret, now })).toBe(false);
    // also rejects far-future timestamps
    const future = now + 301;
    const futureHeader = buildSignatureHeader(secret, future, rawBody);
    expect(verifySignature({ header: futureHeader, rawBody, secret, now })).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const tampered = rawBody.replace('issue.created', 'issue.deleted');
    expect(verifySignature({ header, rawBody: tampered, secret, now })).toBe(false);
  });

  it('rejects re-serialized (whitespace-differing) raw body', () => {
    const reserialized = JSON.stringify(JSON.parse(rawBody), null, 2);
    expect(reserialized).not.toBe(rawBody);
    expect(verifySignature({ header, rawBody: reserialized, secret, now })).toBe(false);
  });

  it('honors a configurable tolerance', () => {
    const old = now - 1000;
    const oldHeader = buildSignatureHeader(secret, old, rawBody);
    expect(verifySignature({ header: oldHeader, rawBody, secret, now })).toBe(false);
    expect(verifySignature({ header: oldHeader, rawBody, secret, now, toleranceSec: 2000 })).toBe(true);
  });

  it('parses t/v1 order-independently', () => {
    const sig = signPayload(secret, now, rawBody);
    expect(parseSignatureHeader(`v1=${sig},t=${now}`)).toEqual({ timestamp: now, v1: sig });
  });
});
