import { describe, it, expect } from 'vitest';
import { verifyWebhook, signWebhookPayload } from '../webhooks.js';

describe('verifyWebhook', () => {
  const secret = 'whsec_sdk_test_secret';
  const rawBody = JSON.stringify({ id: 'evt_1', type: 'issue.created', data: { object: { id: 'i1' } } });
  const now = 1_780_500_000;
  const sig = signWebhookPayload(secret, now, rawBody);
  const header = `t=${now},v1=${sig}`;

  it('accepts a valid signature (Express-style header object)', () => {
    expect(verifyWebhook({ 'ship-signature': header }, rawBody, secret, { now })).toBe(true);
  });

  it('accepts a Fetch Headers-style object via .get()', () => {
    const headers = new Headers({ 'Ship-Signature': header });
    expect(verifyWebhook(headers, rawBody, secret, { now })).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifyWebhook({ 'ship-signature': header }, rawBody, 'whsec_other', { now })).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const tampered = rawBody.replace('issue.created', 'issue.deleted');
    expect(verifyWebhook({ 'ship-signature': header }, tampered, secret, { now })).toBe(false);
  });

  it('rejects re-serialized body (whitespace differs)', () => {
    const reserialized = JSON.stringify(JSON.parse(rawBody), null, 2);
    expect(verifyWebhook({ 'ship-signature': header }, reserialized, secret, { now })).toBe(false);
  });

  it('rejects a malformed or missing header', () => {
    expect(verifyWebhook({ 'ship-signature': 'nope' }, rawBody, secret, { now })).toBe(false);
    expect(verifyWebhook({}, rawBody, secret, { now })).toBe(false);
    expect(verifyWebhook({ 'ship-signature': `t=${now}` }, rawBody, secret, { now })).toBe(false);
  });

  it('rejects a stale timestamp beyond the default tolerance', () => {
    const stale = now - 301;
    const staleHeader = `t=${stale},v1=${signWebhookPayload(secret, stale, rawBody)}`;
    expect(verifyWebhook({ 'ship-signature': staleHeader }, rawBody, secret, { now })).toBe(false);
  });

  it('honors a configurable tolerance', () => {
    const old = now - 1000;
    const oldHeader = `t=${old},v1=${signWebhookPayload(secret, old, rawBody)}`;
    expect(verifyWebhook({ 'ship-signature': oldHeader }, rawBody, secret, { now })).toBe(false);
    expect(verifyWebhook({ 'ship-signature': oldHeader }, rawBody, secret, { now, toleranceSec: 2000 })).toBe(true);
  });
});
