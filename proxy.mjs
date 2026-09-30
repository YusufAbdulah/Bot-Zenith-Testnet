import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProxyAgent } from 'undici';

function quotaKey(proxy) {
  return createHash('sha256').update(proxy.key).digest('hex');
}

export function parseProxy(line) {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) return null;
  let input = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    const parts = input.split(':');
    if (parts.length === 4 && /^\d+$/.test(parts[1])) {
      const [host, port, username, password] = parts;
      input = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    } else input = `http://${input}`;
  }
  let url;
  try { url = new URL(input); }
  catch { throw new Error('format proxy tidak valid'); }
  if (!['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol) || !url.hostname ||
      !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new Error('format proxy tidak valid');
  }
  const label = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  return { raw, key: url.toString(), uri: url.toString(), label };
}

export class ProxyPool {
  constructor(file, addresses, quotaFile = null) {
    this.file = file;
    this.quotaFile = quotaFile;
    this.addresses = addresses;
    this.mode = null;
    this.proxies = [];
    this.assigned = new Map();
    this.agents = new Map();
    this.claimTimes = new Map();
    this.blockedUntil = new Map();
    this.globalBlockedUntil = 0;
    this.savedQuota = null;
  }

  async loadQuota() {
    if (this.savedQuota !== null) return;
    if (!this.quotaFile) { this.savedQuota = {}; return; }
    try { this.savedQuota = JSON.parse(await fs.readFile(this.quotaFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') this.savedQuota = {};
      else throw error;
    }
    if (!this.savedQuota || typeof this.savedQuota !== 'object' || Array.isArray(this.savedQuota)) {
      throw new Error('State rate limit proxy tidak valid.');
    }
    if (this.savedQuota.__version !== 2) {
      for (const [key, value] of Object.entries(this.savedQuota)) {
        if (key === '__global') delete this.savedQuota[key];
        else if (value && typeof value === 'object') value.blocked = 0;
      }
      this.savedQuota.__version = 2;
    }
    this.globalBlockedUntil = Number(this.savedQuota.__global?.blocked) || 0;
  }

  async saveQuota() {
    if (!this.quotaFile) return;
    const now = Date.now();
    for (const proxy of this.proxies) {
      const key = quotaKey(proxy);
      const times = (this.claimTimes.get(proxy.key) || []).filter(at => at > now - 180000);
      const blocked = this.blockedUntil.get(proxy.key) || 0;
      if (times.length || blocked > now) this.savedQuota[key] = { times, blocked };
      else delete this.savedQuota[key];
    }
    if (this.globalBlockedUntil > now) this.savedQuota.__global = { times: [], blocked: this.globalBlockedUntil };
    else delete this.savedQuota.__global;
    for (const [key, value] of Object.entries(this.savedQuota)) {
      if (key === '__version') continue;
      if (!value?.times?.some(at => at > now - 180000) && !(value?.blocked > now)) delete this.savedQuota[key];
    }
    this.savedQuota.__version = 2;
    await fs.mkdir(path.dirname(this.quotaFile), { recursive: true });
    const temp = `${this.quotaFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(this.savedQuota)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.quotaFile);
  }

  async readLines() {
    try { return (await fs.readFile(this.file, 'utf8')).split(/\r?\n/); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeLines(lines) {
    const temp = `${this.file}.${process.pid}.tmp`;
    const body = lines.join('\n').replace(/\n+$/, '');
    await fs.writeFile(temp, body ? `${body}\n` : '', { mode: 0o600 });
    await fs.rename(temp, this.file);
  }

  async refresh() {
    if (this.mode === 'direct') return;
    const lines = await this.readLines();
    if (this.mode === null) {
      this.mode = lines.some(line => line.trim() && !line.trim().startsWith('#')) ? 'proxy' : 'direct';
      if (this.mode === 'direct') return;
    }
    await this.loadQuota();
    const proxies = [];
    const kept = [];
    const seen = new Set();
    let discarded = 0;
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) {
        kept.push(line);
        continue;
      }
      try {
        const proxy = parseProxy(line);
        if (seen.has(proxy.key)) { discarded++; continue; }
        proxies.push(proxy);
        seen.add(proxy.key);
        kept.push(line);
      } catch { discarded++; }
    }
    if (discarded) await this.writeLines(kept);
    this.proxies = proxies;
    for (const proxy of proxies) {
      if (this.claimTimes.has(proxy.key)) continue;
      const saved = this.savedQuota[quotaKey(proxy)];
      if (saved) {
        this.claimTimes.set(proxy.key, Array.isArray(saved.times) ? saved.times : []);
        this.blockedUntil.set(proxy.key, Number(saved.blocked) || 0);
      }
    }
    for (const [address, key] of this.assigned) {
      if (!seen.has(key)) this.assigned.delete(address);
    }
    const counts = new Map(proxies.map(proxy => [proxy.key, 0]));
    for (const key of this.assigned.values()) counts.set(key, (counts.get(key) || 0) + 1);
    for (const address of this.addresses) {
      if (this.assigned.has(address)) continue;
      const candidate = proxies.reduce((best, proxy) =>
        !best || counts.get(proxy.key) < counts.get(best.key) ? proxy : best, null);
      if (candidate) {
        this.assigned.set(address, candidate.key);
        counts.set(candidate.key, counts.get(candidate.key) + 1);
      }
    }
    return discarded;
  }

  availableAt(proxy, now = Date.now()) {
    const recent = (this.claimTimes.get(proxy.key) || []).filter(at => at > now - 180000);
    this.claimTimes.set(proxy.key, recent);
    const quotaUntil = recent.length >= 10 ? recent[0] + 180000 : 0;
    return Math.max(this.blockedUntil.get(proxy.key) || 0, quotaUntil);
  }

  async recordClaim(proxy, now = Date.now()) {
    if (!proxy) return;
    const recent = (this.claimTimes.get(proxy.key) || []).filter(at => at > now - 180000);
    recent.push(now);
    this.claimTimes.set(proxy.key, recent);
    await this.saveQuota();
  }

  async cooldown(proxy, seconds, now = Date.now()) {
    this.blockedUntil.set(proxy.key, Math.max(this.blockedUntil.get(proxy.key) || 0, now + Math.max(180, seconds) * 1000));
    await this.saveQuota();
  }

  async setGlobalCooldown(until) {
    this.globalBlockedUntil = Math.max(this.globalBlockedUntil, until);
    await this.saveQuota();
  }

  async routeFor(address, { forClaim = true, now = Date.now() } = {}) {
    await this.refresh();
    if (this.mode === 'direct') return { proxy: null, dispatcher: undefined };
    if (forClaim && this.globalBlockedUntil > now) return { waitUntil: this.globalBlockedUntil, global: true };
    if (!this.proxies.length) return { waitUntil: now + 5 * 60 * 1000, empty: true };
    const preferred = this.assigned.get(address);
    const start = Math.max(0, this.proxies.findIndex(proxy => proxy.key === preferred));
    let earliest = Infinity;
    for (let offset = 0; offset < this.proxies.length; offset++) {
      const proxy = this.proxies[(start + offset) % this.proxies.length];
      const available = forClaim ? this.availableAt(proxy, now) : 0;
      if (available > now) { earliest = Math.min(earliest, available); continue; }
      if (!this.agents.has(proxy.key)) this.agents.set(proxy.key, new ProxyAgent(proxy.uri));
      return { proxy, dispatcher: this.agents.get(proxy.key) };
    }
    return { waitUntil: earliest, empty: false };
  }

  async retire(proxy) {
    const kept = [];
    for (const line of await this.readLines()) {
      if (!line.trim() || line.trim().startsWith('#')) {
        kept.push(line);
        continue;
      }
      try {
        const item = parseProxy(line);
        if (item.key !== proxy.key) kept.push(line);
      } catch { /* Invalid entries are also removed. */ }
    }
    await this.writeLines(kept);
    const agent = this.agents.get(proxy.key);
    this.agents.delete(proxy.key);
    this.claimTimes.delete(proxy.key);
    this.blockedUntil.delete(proxy.key);
    delete this.savedQuota[quotaKey(proxy)];
    if (agent) agent.destroy();
    await this.refresh();
    await this.saveQuota();
  }

  async close() {
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.allSettled(agents.map(agent => agent.close()));
  }
}
