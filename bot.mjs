import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import chalk from 'chalk';
import { fetch as undiciFetch } from 'undici';
import { ProxyPool } from './proxy.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT_FILE = path.join(ROOT, 'akun.json');
const ADDRESS_FILE = path.join(ROOT, 'address.txt');
const PROXY_FILE = path.join(ROOT, 'proxy.txt');
const STATE_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'zenith-faucet');
const PROXY_RATE_FILE = path.join(STATE_DIR, 'proxy-rate.json');
const FAUCET = 'https://explorer.testnet.zenith.network/api/faucet';
const RPC = 'https://rpc.testnet.zenith.network';
const CHAIN_ID = 936485;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const log = {
  info: message => console.log(`${chalk.cyan('i')}  ${message}`),
  ok: message => console.log(`${chalk.green('✓')}  ${message}`),
  warn: message => console.log(`${chalk.yellow('!')}  ${message}`),
  error: message => console.error(`${chalk.red('✗')}  ${chalk.red(message)}`),
  detail: (label, value) => console.log(`   ${chalk.dim(label.padEnd(10))} ${value}`),
};

function localTime(timestamp) {
  return new Date(timestamp).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' });
}

function shortAddress(address) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export function waitSeconds(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return null;
  for (const key of ['nextClaimAt', 'nextClaimTime', 'availableAt', 'retryAt', 'resetAt']) {
    if (data[key] == null) continue;
    let target = Number(data[key]);
    if (Number.isFinite(target)) {
      if (target < 1e11) target *= 1000;
    } else target = Date.parse(data[key]);
    if (Number.isFinite(target)) return Math.max(0, (target - now) / 1000);
  }
  for (const [key, factor] of Object.entries({
    retryAfterMs: 0.001, retryAfterSeconds: 1, remainingSeconds: 1,
    cooldownSeconds: 1, retryAfter: 1, remainingMinutes: 60, cooldownMinutes: 60,
  })) {
    if (data[key] == null) continue;
    const value = Number(data[key]);
    if (Number.isFinite(value)) return Math.max(0, value * factor);
  }
  const message = String(data.error || data.message || '');
  const match = message.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|h|m|s)\b/i);
  if (match) return Number(match[1]) * { h: 3600, m: 60, s: 1 }[match[2][0].toLowerCase()];
  return null;
}

export function retryAfterSeconds(header, now = Date.now()) {
  if (!header) return null;
  const numeric = Number(header);
  if (Number.isFinite(numeric)) return Math.max(0, numeric);
  const target = Date.parse(header);
  return Number.isFinite(target) ? Math.max(0, (target - now) / 1000) : null;
}

function stateFile(address) {
  return path.join(STATE_DIR, `${address.toLowerCase()}.json`);
}

async function readState(address) {
  let contents;
  try { contents = await fs.readFile(stateFile(address), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const due = Date.parse(JSON.parse(contents).next_attempt_at);
  if (!Number.isFinite(due)) throw new Error(`State klaim tidak valid untuk ${address}`);
  return due;
}

async function writeState(address, due) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const target = stateFile(address);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ next_attempt_at: new Date(due).toISOString() })}\n`, { mode: 0o600 });
  await fs.rename(temp, target);
}

async function readAddresses() {
  let contents;
  try { contents = await fs.readFile(ADDRESS_FILE, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('address.txt belum ada. Buat wallet lewat menu [1] atau isi file address.txt.');
    throw error;
  }
  const seen = new Set();
  const addresses = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const address = line.trim();
    if (!address || address.startsWith('#')) continue;
    if (!ADDRESS_RE.test(address)) throw new Error(`Alamat tidak valid di address.txt baris ${index + 1}: ${address}`);
    if (!seen.has(address.toLowerCase())) {
      addresses.push(address);
      seen.add(address.toLowerCase());
    }
  }
  if (!addresses.length) throw new Error('address.txt tidak berisi alamat EVM.');
  return addresses;
}

async function fetchJson(url, options = {}, signal, dispatcher) {
  const timeout = AbortSignal.timeout(25000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await undiciFetch(url, {
      ...options,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...options.headers },
      signal: combined,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (error) {
    if (dispatcher && !signal?.aborted) error.proxyFailure = true;
    throw error;
  }
  if (dispatcher && response.status === 407) {
    const error = new Error('Proxy menolak autentikasi (HTTP 407)');
    error.proxyFailure = true;
    throw error;
  }
  let data;
  try { data = await response.json(); }
  catch {
    const error = new Error(`HTTP ${response.status}: respons bukan JSON`);
    if (dispatcher && response.status === 403) error.proxyFailure = true;
    throw error;
  }
  return { status: response.status, data, retryAfter: response.headers.get('retry-after') };
}

function faucetRequest(method, address, signal, dispatcher) {
  const options = method === 'POST'
    ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) }
    : { method };
  return fetchJson(FAUCET, options, signal, dispatcher);
}

function nextTime(response, fallbackSeconds, now = Date.now()) {
  const seconds = waitSeconds(response.data, now) ?? retryAfterSeconds(response.retryAfter, now) ?? fallbackSeconds;
  return now + (Math.max(5, seconds) + 2) * 1000;
}

function rateLimitWait(response, minimum = 180) {
  return Math.max(minimum, waitSeconds(response.data) ?? 0, retryAfterSeconds(response.retryAfter) ?? 0);
}

function rateLimitDescription(response, minimum = 180) {
  const wait = rateLimitWait(response, minimum);
  const serverWait = Math.max(waitSeconds(response.data) ?? 0, retryAfterSeconds(response.retryAfter) ?? 0);
  const serverProvided = serverWait >= minimum && serverWait > 0;
  const detail = String(response.data?.error || response.data?.message || '').slice(0, 160);
  return `${Math.ceil(wait / 60)} menit (${serverProvided ? 'respons server' : 'batas minimum bot'})${detail ? `: ${detail}` : ''}`;
}

export function rateLimitScope(data) {
  const detail = [data?.error, data?.message, data?.code, data?.type]
    .filter(value => typeof value === 'string').join(' ').toLowerCase().replace(/[_-]/g, ' ');
  if (/\balready claimed\b|\baddress\b.{0,60}\b(claimed|cooldown|limit|wait)\b|\bper.address\b/.test(detail)) return 'address';
  if (/\b(ip|proxy)\b.{0,60}\b(rate.?limit|cooldown|too many|claim)\b|\b(rate.?limit|too many)\b.{0,60}\b(ip|proxy)\b/.test(detail)) return 'proxy';
  return 'unknown';
}

export async function claimOne(address, signal, dispatcher, proxy, pool, request = faucetRequest) {
  const status = await request('GET', undefined, signal, dispatcher);
  if (status.status === 429) {
    log.warn(`${shortAddress(address)}: HTTP 429 saat cek status faucet; jeda ${rateLimitDescription(status)}`);
    if (!proxy) return Date.now() + (rateLimitWait(status) + 2) * 1000;
    const error = new Error('HTTP 429');
    error.proxyRateLimit = true;
    error.waitSeconds = rateLimitWait(status);
    throw error;
  }
  if (status.status !== 200 || !status.data?.enabled) {
    const error = new Error(`Status faucet HTTP ${status.status}: ${JSON.stringify(status.data)}`);
    error.permanent = [400, 401, 403].includes(status.status) || status.data?.enabled === false;
    error.proxyFailure = dispatcher && status.status === 403 && status.data?.cloudflare_error === true;
    throw error;
  }
  const cooldown = Number(status.data.cooldownMinutes) * 60;
  if (!Number.isFinite(cooldown) || cooldown <= 0) throw new Error('cooldownMinutes dari API tidak valid');
  await pool.recordClaim(proxy);
  const response = await request('POST', address, signal, dispatcher);
  if (response.status === 429) {
    const scope = rateLimitScope(response.data);
    if (scope === 'address') {
      log.warn(`${shortAddress(address)}: address masih cooldown; coba lagi ${rateLimitDescription(response, 0)}`);
      return nextTime(response, 180);
    }
    if (scope === 'unknown') {
      log.warn(`${shortAddress(address)}: HTTP 429 tanpa penyebab IP yang jelas; address dijeda ${rateLimitDescription(response)}`);
      return nextTime(response, 180);
    }
    log.warn(`${shortAddress(address)}: pembatasan IP/proxy; jeda ${rateLimitDescription(response)}`);
    if (!proxy) return Date.now() + (rateLimitWait(response) + 2) * 1000;
    const error = new Error('HTTP 429');
    error.proxyRateLimit = true;
    error.waitSeconds = rateLimitWait(response);
    throw error;
  }
  if (response.status >= 200 && response.status < 300 && response.data?.ok === true) {
    log.ok(`${chalk.bold(response.data.zthAmount || status.data.zthAmount)} ZTH dikirim ke ${chalk.cyan(address)}`);
    if (response.data.zthTxHash) log.detail('Tx hash', chalk.dim(response.data.zthTxHash));
    return nextTime(response, cooldown);
  }
  const message = String(response.data?.error || response.data?.message || '');
  const limited = response.status === 429 || (response.status === 400 && /cooldown|wait|too many|already claim|rate limit|try again|minute|second/i.test(message));
  if (limited) log.warn(`${shortAddress(address)}: ${message || `HTTP ${response.status}; batas klaim`}`);
  if ([400, 401, 403].includes(response.status) && !limited) {
    const error = new Error(`Klaim ditolak HTTP ${response.status}: ${message}`);
    error.permanent = true;
    error.proxyFailure = dispatcher && response.status === 403 && response.data?.cloudflare_error === true;
    throw error;
  }
  return nextTime(response, limited ? cooldown : 300);
}

async function sleepUntil(target, signal) {
  while (!signal.aborted && Date.now() < target) {
    try { await delay(Math.min(60000, target - Date.now()), undefined, { signal }); }
    catch { return; }
  }
}

export async function withProxyRotation(pool, address, signal, operation, { forClaim = true } = {}) {
  let rateLimitedProxies = 0;
  let longestWait = 0;
  while (!signal?.aborted) {
    const route = await pool.routeFor(address, { forClaim });
    if (route.waitUntil) {
      const error = new Error(route.empty
        ? `Tidak ada proxy untuk ${shortAddress(address)}. Tambahkan proxy ke proxy.txt.`
        : `Semua proxy sedang dibatasi; tunggu sampai ${localTime(route.waitUntil)}.`);
      error.noProxy = route.empty;
      error.proxyWaitUntil = route.waitUntil;
      error.globalRateLimit = route.global === true;
      throw error;
    }
    if (route.proxy) log.detail('Proxy', chalk.dim(route.proxy.label));
    try { return await operation(route.dispatcher, route.proxy); }
    catch (error) {
      if (signal?.aborted || !route.proxy) throw error;
      if (error.proxyRateLimit) {
        await pool.cooldown(route.proxy, error.waitSeconds);
        rateLimitedProxies++;
        longestWait = Math.max(longestWait, pool.blockedUntil.get(route.proxy.key));
        log.warn(`Proxy ${route.proxy.label} cooldown ${Math.ceil(error.waitSeconds / 60)} menit; coba proxy lain.`);
        if (rateLimitedProxies >= Math.min(3, pool.proxies.length)) {
          await pool.setGlobalCooldown(longestWait);
          const pause = new Error(`HTTP 429 dari ${rateLimitedProxies} proxy berbeda. Semua klaim dijeda sampai ${localTime(longestWait)}.`);
          pause.globalRateLimit = true;
          pause.proxyWaitUntil = longestWait;
          throw pause;
        }
        continue;
      }
      if (!error.proxyFailure) throw error;
      log.warn(`Proxy ${route.proxy.label} gagal; dihapus dari proxy.txt dan dirotasi.`);
      await pool.retire(route.proxy);
    }
  }
  throw signal.reason || new Error('Dihentikan');
}

async function runClaims(signal) {
  const addresses = await readAddresses();
  const due = new Map();
  for (const address of addresses) due.set(address, await readState(address));
  const pool = new ProxyPool(PROXY_FILE, addresses, PROXY_RATE_FILE);
  const discarded = await pool.refresh();
  let globalPauseUntil = pool.globalBlockedUntil;
  log.info(`${chalk.bold(addresses.length)} alamat dimuat. Klaim satu per satu.`);
  log.info(pool.mode === 'proxy' ? `Mode proxy: ${pool.proxies.length} proxy untuk ${addresses.length} address.` : 'Mode tanpa proxy.');
  if (discarded) log.warn(`${discarded} baris proxy tidak valid/duplikat dihapus dari proxy.txt.`);
  log.info(`Ketik ${chalk.bold('q + Enter')} untuk kembali ke menu.`);
  try {
    while (!signal.aborted) {
      if (globalPauseUntil > Date.now()) {
        log.warn(`Semua klaim dijeda sampai ${localTime(globalPauseUntil)} setelah HTTP 429 berulang.`);
        await sleepUntil(globalPauseUntil, signal);
        continue;
      }
      for (const [index, address] of addresses.entries()) {
        if (signal.aborted) break;
        if (Date.now() < due.get(address)) continue;
        console.log(`\n${chalk.bgCyan.black(` KLAIM ${index + 1}/${addresses.length} `)} ${chalk.cyan(address)}`);
        let next;
        let persist = true;
        try { next = await withProxyRotation(pool, address, signal, (dispatcher, proxy) => claimOne(address, signal, dispatcher, proxy, pool)); }
        catch (error) {
          if (signal.aborted) break;
          if (error.globalRateLimit) {
            globalPauseUntil = error.proxyWaitUntil;
            log.warn(error.message);
            break;
          } else if (error.proxyWaitUntil) {
            log.warn(error.message);
            next = error.proxyWaitUntil;
            persist = false;
          } else {
            log.error(`${shortAddress(address)}: ${error.message}`);
            if (error.permanent) {
              log.error('Proses klaim dihentikan karena akses atau klaim ditolak permanen.');
              return;
            }
            next = Date.now() + 5 * 60 * 1000;
          }
        }
        if (persist) await writeState(address, next);
        due.set(address, next);
        log.detail('Berikutnya', chalk.magenta(localTime(next)));
        await sleepUntil(Date.now() + 2000, signal);
      }
      if (globalPauseUntil > Date.now()) continue;
      if (!signal.aborted) {
        const earliest = Math.min(...due.values());
        log.info(`Menunggu klaim berikutnya: ${chalk.magenta(localTime(earliest))}`);
        await sleepUntil(earliest, signal);
        }
    }
  } finally { await pool.close(); }
}

export async function createWallets(rl) {
  const countText = (await rl.question('Mau buat berapa wallet? ')).trim();
  if (!/^[1-9]\d*$/.test(countText) || Number(countText) > 100) {
    log.warn('Masukkan angka 1 sampai 100.');
    return;
  }
  let Wallet;
  try { ({ Wallet } = await import('ethers')); }
  catch { throw new Error('Paket ethers belum terpasang. Jalankan npm install.'); }
  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(ACCOUNT_FILE, 'utf8'));
    if (!Array.isArray(existing)) throw new Error('akun.json harus berupa array JSON.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const created = [];
  for (let i = 0; i < Number(countText); i++) {
    const wallet = Wallet.createRandom();
    created.push({ mnemonic: wallet.mnemonic.phrase, privateKey: wallet.privateKey, address: wallet.address });
  }
  const temp = `${ACCOUNT_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify([...existing, ...created], null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, ACCOUNT_FILE);
  let addressText = '';
  try { addressText = await fs.readFile(ADDRESS_FILE, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const known = new Set(addressText.split(/\r?\n/).map(value => value.trim().toLowerCase()));
  const additions = created.filter(wallet => !known.has(wallet.address.toLowerCase()));
  const prefix = addressText && !addressText.endsWith('\n') ? '\n' : '';
  await fs.writeFile(ADDRESS_FILE, addressText + prefix + additions.map(wallet => wallet.address).join('\n') + '\n');
  log.ok(`${created.length} wallet dibuat. Total akun: ${existing.length + created.length}.`);
  log.detail('Rahasia', chalk.yellow(ACCOUNT_FILE));
  log.detail('Alamat', chalk.cyan(ADDRESS_FILE));
  for (const [index, wallet] of created.entries()) {
    log.detail(`#${index + 1}`, chalk.cyan(wallet.address));
  }
}

async function rpc(method, params, dispatcher) {
  const response = await fetchJson(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, undefined, dispatcher);
  if (response.status !== 200 || response.data.error || response.data.result == null) {
    throw new Error(`RPC ${method}: ${JSON.stringify(response.data)}`);
  }
  return response.data.result;
}

export function formatZth(hex) {
  const wei = BigInt(hex);
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function checkBalances() {
  const addresses = await readAddresses();
  const pool = new ProxyPool(PROXY_FILE, addresses, PROXY_RATE_FILE);
  const discarded = await pool.refresh();
  console.log(`\n${chalk.bgBlue.white(' SALDO ZTH ')} ${chalk.dim(`Zenith EVM Testnet • Chain ${CHAIN_ID}`)}`);
  log.info(pool.mode === 'proxy' ? `Mode proxy: ${pool.proxies.length} proxy.` : 'Mode tanpa proxy.');
  if (discarded) log.warn(`${discarded} baris proxy tidak valid/duplikat dihapus dari proxy.txt.`);
  try {
    for (const [index, address] of addresses.entries()) {
      try {
        const balance = await withProxyRotation(pool, address, undefined, async dispatcher => {
          const chainId = Number(BigInt(await rpc('eth_chainId', [], dispatcher)));
          if (chainId !== CHAIN_ID) throw new Error(`Chain ID RPC ${chainId}, seharusnya ${CHAIN_ID}.`);
          return rpc('eth_getBalance', [address, 'latest'], dispatcher);
        }, { forClaim: false });
        console.log(`${chalk.dim(String(index + 1).padStart(2))}  ${chalk.cyan(address)}  ${chalk.green.bold(formatZth(balance))} ${chalk.green('ZTH')}`);
      } catch (error) {
        if (error.proxyWaitUntil) log.warn(error.message);
        else log.error(`${shortAddress(address)}: ${error.message}`);
      }
    }
  } finally { await pool.close(); }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      console.clear();
      console.log(`\n${chalk.cyan.bold('ZENITH EVM TESTNET')} ${chalk.dim('• faucet bot')}`);
      console.log(chalk.dim('────────────────────────────────'));
      console.log(`${chalk.dim('Created by')} ${chalk.bold.yellow('Yusuf Abdullah')}`);
      console.log(`${chalk.cyan('[1]')} Create EVM Wallet`);
      console.log(`${chalk.cyan('[2]')} Claim Faucet ${chalk.green('(Running)')}`);
      console.log(`${chalk.cyan('[3]')} Cek Balance ${chalk.green('$ZTH')}`);
      console.log(`${chalk.yellow('[q]')} Quit`);
      const choice = (await rl.question(chalk.bold('\nPilih > '))).trim().toLowerCase();
      console.clear();
      if (choice === 'q') return;
      let pauseBeforeMenu = true;
      try {
        if (choice === '1') await createWallets(rl);
        else if (choice === '2') {
          const controller = new AbortController();
          let stoppedByUser = false;
          const worker = runClaims(controller.signal)
            .catch(error => log.error(`Klaim: ${error.message}`))
            .finally(() => controller.abort());
          while (!controller.signal.aborted) {
            try {
              const command = (await rl.question(chalk.dim('Ketik q + Enter untuk stop klaim > '), { signal: controller.signal })).trim().toLowerCase();
              if (command === 'q') {
                stoppedByUser = true;
                controller.abort();
              } else log.warn('Ketik q lalu Enter untuk kembali ke menu.');
            } catch (error) {
              if (error.name !== 'AbortError') throw error;
            }
          }
          await worker;
          pauseBeforeMenu = !stoppedByUser;
        } else if (choice === '3') await checkBalances();
        else log.warn('Pilihan tidak dikenal.');
      } catch (error) { log.error(error.message); }
      if (pauseBeforeMenu) await rl.question(chalk.dim('\nEnter untuk kembali ke menu...'));
    }
  } finally { rl.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { log.error(error.message); process.exitCode = 1; });
}
