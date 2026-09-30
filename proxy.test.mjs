import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fetch } from 'undici';
import { parseProxy, ProxyPool } from './proxy.mjs';
import { withProxyRotation } from './bot.mjs';

const addresses = ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'];

test('format proxy umum dan URL berautentikasi', () => {
  assert.equal(parseProxy('127.0.0.1:8080').key, 'http://127.0.0.1:8080/');
  assert.equal(parseProxy('127.0.0.1:8080:user:pass').key, 'http://user:pass@127.0.0.1:8080/');
  assert.equal(parseProxy('socks5://user:pass@localhost:1080').label, 'socks5://localhost:1080');
  assert.throws(() => parseProxy('ftp://localhost:21'), /tidak valid/);
});

test('mode langsung bila proxy.txt tidak ada', async () => {
  const pool = new ProxyPool(path.join(os.tmpdir(), `zenith-no-proxy-${process.pid}.txt`), addresses);
  try {
    assert.equal((await pool.routeFor(addresses[0])).proxy, null);
    assert.equal(pool.mode, 'direct');
  } finally { await pool.close(); }
});

test('satu address satu proxy; proxy rusak dihapus dan diganti cadangan', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-proxy-test-'));
  const file = path.join(folder, 'proxy.txt');
  const list = ['http://127.0.0.1:1001', 'http://127.0.0.1:1002', 'http://127.0.0.1:1003'];
  await fs.writeFile(file, `# daftar proxy\n${list.join('\n')}\n`);
  const pool = new ProxyPool(file, addresses);
  try {
    const first = await pool.routeFor(addresses[0]);
    const second = await pool.routeFor(addresses[1]);
    assert.equal(first.proxy.label, 'http://127.0.0.1:1001');
    assert.equal(second.proxy.label, 'http://127.0.0.1:1002');
    await pool.retire(first.proxy);
    assert.equal((await pool.routeFor(addresses[0])).proxy.label, 'http://127.0.0.1:1003');
    assert.equal((await pool.routeFor(addresses[1])).proxy.label, 'http://127.0.0.1:1002');
    assert.equal((await fs.readFile(file, 'utf8')).trim(), `# daftar proxy\n${list[1]}\n${list[2]}`);
  } finally {
    await pool.close();
    await fs.unlink(file);
    await fs.rmdir(folder);
  }
});

test('proxy boleh dipakai banyak address, maksimum 10 klaim per 3 menit', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-proxy-limit-'));
  const file = path.join(folder, 'proxy.txt');
  await fs.writeFile(file, 'http://127.0.0.1:1001\n');
  const pool = new ProxyPool(file, addresses);
  const start = Date.parse('2026-09-29T00:00:00Z');
  try {
    const first = await pool.routeFor(addresses[0], { now: start });
    const second = await pool.routeFor(addresses[1], { now: start });
    assert.equal(first.proxy.key, second.proxy.key);
    for (let i = 0; i < 10; i++) await pool.recordClaim(first.proxy, start + i * 1000);
    assert.equal((await pool.routeFor(addresses[1], { now: start + 10000 })).waitUntil, start + 180000);
    assert.ok((await pool.routeFor(addresses[1], { now: start + 180000 })).proxy);
  } finally {
    await pool.close();
    await fs.unlink(file);
    await fs.rmdir(folder);
  }
});

test('HTTP 429 memberi cooldown proxy lalu memilih proxy lain', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-proxy-429-'));
  const file = path.join(folder, 'proxy.txt');
  await fs.writeFile(file, 'http://127.0.0.1:1001\nhttp://127.0.0.1:1002\n');
  const pool = new ProxyPool(file, addresses);
  const start = Date.parse('2026-09-29T00:00:00Z');
  try {
    const first = await pool.routeFor(addresses[0], { now: start });
    await pool.cooldown(first.proxy, 30, start);
    assert.equal((await pool.routeFor(addresses[0], { now: start + 1000 })).proxy.label, 'http://127.0.0.1:1002');
    assert.equal((await pool.routeFor(addresses[0], { now: start + 180000 })).proxy.label, 'http://127.0.0.1:1001');
    assert.match(await fs.readFile(file, 'utf8'), /1001/);
  } finally {
    await pool.close();
    await fs.unlink(file);
    await fs.rmdir(folder);
  }
});

test('kuota proxy tetap berlaku setelah proses dimulai ulang', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-proxy-state-'));
  const file = path.join(folder, 'proxy.txt');
  const quotaFile = path.join(folder, 'proxy-rate.json');
  await fs.writeFile(file, 'http://user:pass@127.0.0.1:1001\n');
  const start = Date.now();
  const first = new ProxyPool(file, addresses, quotaFile);
  try {
    const route = await first.routeFor(addresses[0]);
    for (let i = 0; i < 10; i++) await first.recordClaim(route.proxy, start - 9000 + i * 1000);
    assert.doesNotMatch(await fs.readFile(quotaFile, 'utf8'), /user:pass|127\.0\.0\.1/);
  } finally { await first.close(); }
  const restarted = new ProxyPool(file, addresses, quotaFile);
  try {
    assert.equal((await restarted.routeFor(addresses[1], { now: start + 1000 })).waitUntil, start - 9000 + 180000);
  } finally {
    await restarted.close();
    await fs.unlink(file);
    await fs.unlink(quotaFile);
    await fs.rmdir(folder);
  }
});

test('state lama menghapus cooldown proxy keliru dan mempertahankan hitungan klaim', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-proxy-migrate-'));
  const file = path.join(folder, 'proxy.txt');
  const quotaFile = path.join(folder, 'proxy-rate.json');
  const proxy = 'http://127.0.0.1:1001/';
  const key = createHash('sha256').update(proxy).digest('hex');
  const start = Date.now();
  await fs.writeFile(file, `${proxy}\n`);
  await fs.writeFile(quotaFile, JSON.stringify({
    [key]: { times: [start - 1000], blocked: start + 600000 },
    __global: { times: [], blocked: start + 600000 },
  }));
  const pool = new ProxyPool(file, addresses, quotaFile);
  try {
    assert.ok((await pool.routeFor(addresses[0], { now: start })).proxy);
    assert.equal(pool.globalBlockedUntil, 0);
    assert.equal(pool.claimTimes.get(proxy).length, 1);
    await pool.saveQuota();
    const migrated = JSON.parse(await fs.readFile(quotaFile, 'utf8'));
    assert.equal(migrated.__version, 2);
    assert.equal(migrated[key].blocked, 0);
  } finally {
    await pool.close();
    await fs.unlink(file);
    await fs.unlink(quotaFile);
    await fs.rmdir(folder);
  }
});

test('request benar-benar dikirim melalui proxy HTTP', async () => {
  let requested = '';
  let authorization = '';
  const server = http.createServer((request, response) => {
    requested = request.url;
    authorization = request.headers['proxy-authorization'];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-proxy-http-'));
  const file = path.join(folder, 'proxy.txt');
  await fs.writeFile(file, `http://user:pass@127.0.0.1:${server.address().port}\n`);
  const pool = new ProxyPool(file, addresses);
  try {
    const route = await pool.routeFor(addresses[0]);
    const response = await fetch('http://example.invalid/faucet', { dispatcher: route.dispatcher });
    assert.equal((await response.json()).ok, true);
    assert.equal(requested, 'http://example.invalid/faucet');
    assert.equal(authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
  } finally {
    await pool.close();
    server.close();
    await once(server, 'close');
    await fs.unlink(file);
    await fs.rmdir(folder);
  }
});

test('429 merotasi tanpa menghapus; koneksi rusak merotasi dan menghapus', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-proxy-rotate-'));
  const file = path.join(folder, 'proxy.txt');
  await fs.writeFile(file, 'http://127.0.0.1:1001\nhttp://127.0.0.1:1002\nhttp://127.0.0.1:1003\n');
  const pool = new ProxyPool(file, addresses);
  try {
    let calls = 0;
    const after429 = await withProxyRotation(pool, addresses[0], undefined, async (_dispatcher, proxy) => {
      if (++calls === 1) {
        const error = new Error('429');
        error.proxyRateLimit = true;
        error.waitSeconds = 180;
        throw error;
      }
      return proxy.label;
    });
    assert.equal(after429, 'http://127.0.0.1:1002');
    assert.match(await fs.readFile(file, 'utf8'), /1001/);
    const afterFailure = await withProxyRotation(pool, addresses[1], undefined, async (_dispatcher, proxy) => {
      if (proxy.label.endsWith(':1002')) {
        const error = new Error('failed');
        error.proxyFailure = true;
        throw error;
      }
      return proxy.label;
    });
    assert.equal(afterFailure, 'http://127.0.0.1:1003');
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /1002/);
    await pool.retire((await pool.routeFor(addresses[1], { forClaim: false })).proxy);
    await pool.retire(pool.proxies[0]);
    const unavailable = await pool.routeFor(addresses[0]);
    assert.equal(unavailable.empty, true);
    assert.equal(pool.mode, 'proxy');
  } finally {
    await pool.close();
    await fs.unlink(file);
    await fs.rmdir(folder);
  }
});
