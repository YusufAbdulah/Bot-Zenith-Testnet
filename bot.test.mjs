import assert from 'node:assert/strict';
import test from 'node:test';
import { claimOne, formatZth, rateLimitScope, retryAfterSeconds, waitSeconds } from './bot.mjs';

const reference = Date.parse('2026-09-29T00:00:00Z');

test('jadwal klaim dari waktu absolut', () => {
  assert.equal(waitSeconds({ nextClaimAt: '2026-09-29T00:30:00Z' }, reference), 1800);
});

test('cooldown dari status JSON', () => {
  assert.equal(waitSeconds({ cooldownMinutes: 30 }, reference), 1800);
});

test('pesan rate limit dan header', () => {
  assert.equal(waitSeconds({ error: 'Please wait 12 minutes' }, reference), 720);
  assert.equal(retryAfterSeconds('120', reference), 120);
});

test('saldo ZTH dari wei', () => {
  assert.equal(formatZth('0x56bc75e2d63100000'), '100');
  assert.equal(formatZth('0xde0b6b3a7640000'), '1');
});

test('429 address tidak dianggap pembatasan proxy', () => {
  const response = { error: 'This address already claimed. Try again in 9 min.', retryAfterSeconds: 511 };
  assert.equal(rateLimitScope(response), 'address');
  assert.equal(waitSeconds(response, reference), 511);
  assert.equal(rateLimitScope({ code: 'ADDRESS_ALREADY_CLAIMED' }), 'address');
  assert.equal(rateLimitScope({ error: 'IP rate limit exceeded' }), 'proxy');
  assert.equal(rateLimitScope({ code: 'IP_RATE_LIMIT' }), 'proxy');
  assert.equal(rateLimitScope({ error: 'Too many requests' }), 'unknown');
});

test('klaim 429 already claimed hanya menjadwalkan address', async () => {
  const address = '0x0000000000000000000000000000000000000001';
  let posts = 0;
  const pool = { recordClaim: async () => { posts++; } };
  const request = async method => method === 'GET'
    ? { status: 200, data: { enabled: true, cooldownMinutes: 30 }, retryAfter: null }
    : { status: 429, data: { error: 'This address already claimed. Try again in 9 min.', retryAfterSeconds: 511 }, retryAfter: null };
  const started = Date.now();
  const next = await claimOne(address, undefined, {}, { key: 'proxy-one' }, pool, request);
  assert.equal(posts, 1);
  assert.ok(next >= started + 511000 && next < started + 515000);
});

test('klaim 429 IP menandai proxy untuk cooldown dan rotasi', async () => {
  const pool = { recordClaim: async () => {} };
  const request = async method => method === 'GET'
    ? { status: 200, data: { enabled: true, cooldownMinutes: 30 }, retryAfter: null }
    : { status: 429, data: { error: 'IP rate limit exceeded', retryAfterSeconds: 180 }, retryAfter: null };
  await assert.rejects(
    claimOne('0x0000000000000000000000000000000000000001', undefined, {}, { key: 'proxy-one' }, pool, request),
    error => error.proxyRateLimit === true && error.waitSeconds === 180,
  );
});
