#!/usr/bin/env node
// Node.js >=22, dependency-free. Never pass a token as an argument.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, writeFile, mkdir, rename, unlink, lstat, chmod, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ORIGIN = 'https://meta-ads.rabbithole-studios.io';
const TOKEN_RE = /^rhm_[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RATIOS = ['9x16', '1x1', '16x9'];
// Mirrors games.json in the workbench release. check-manifest stays local-only,
// so the CLI validates against this embedded copy; tests fail if it drifts.
export const GAME_REGISTRY = {
  'rabbit-hole': { languages: ['EN','KO','JA','DE','FR','ES','PT','ID','TH','ZH-CN','ZH-TW'] },
  'card-of-demon-slayer': { languages: ['EN','KO','JA','DE','FR','ES','PT','ID','TH','ZH-CN','ZH-TW'] },
};
const CONFIG_DIR = join(homedir(), '.rh-meta-workbench');
const CREDENTIAL_FILE = join(CONFIG_DIR, 'credentials.json');

export function apiOrigin(env = process.env) {
  if (!env.RH_META_DEV_ORIGIN) return ORIGIN;
  const url = new URL(env.RH_META_DEV_ORIGIN);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('RH_META_DEV_ORIGIN must be a loopback origin. Remote overrides are forbidden.');
  return url.origin;
}

export function parseArgs(args) {
  const positional = [], flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (!['--adset', '--ad', '--adset-name', '--reference-name', '--campaign-name', '--game', '--after', '--confirm-new-paused', '--supersede-failed', '--output', '--ratio', '--manifest', '--interval', '--timeout', '--query', '--state', '--before', '--limit', '--help'].includes(arg) || arg in flags) throw new Error(`Unknown or duplicate option: ${arg}`);
    if (['--confirm-new-paused', '--help'].includes(arg)) flags[arg] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value: ${arg}`); flags[arg] = args[++i]; }
  }
  return { positional, flags };
}

export function validateManifest(manifest) {
  const allowed = ['gameId', 'language', 'targetAdsetId', 'referenceAdId', 'newAdName', 'reviewedSourceHash', 'assets'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some((key) => !allowed.includes(key))) throw new Error('Manifest contains unsupported fields. Existing ad IDs must never be supplied as output IDs.');
  const game = typeof manifest.gameId === 'string' ? GAME_REGISTRY[manifest.gameId] : undefined;
  if (!game || !game.languages.includes(manifest.language)) throw new Error('Unsupported game or language.');
  for (const field of ['targetAdsetId', 'referenceAdId']) if (typeof manifest[field] !== 'string' || !/^\d{5,30}$/.test(manifest[field])) throw new Error(`${field} must be a string of digits.`);
  if (typeof manifest.newAdName !== 'string' || manifest.newAdName.length > 160 || !/^[\p{L}\p{N}][\p{L}\p{N}_.()\- ]+$/u.test(manifest.newAdName)) throw new Error('Invalid newAdName.');
  if (typeof manifest.reviewedSourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.reviewedSourceHash)) throw new Error('Run preview, review its targeting/copy/links, and put the approved hash in reviewedSourceHash.');
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 3 || RATIOS.some((ratio) => manifest.assets.filter((asset) => asset?.ratio === ratio).length !== 1)) throw new Error('Exactly one MP4 per ratio is required: 9x16, 1x1, 16x9.');
  for (const asset of manifest.assets) if (Object.keys(asset).some((key) => !['ratio','path'].includes(key)) || typeof asset.path !== 'string' || !asset.path || !asset.path.toLowerCase().endsWith('.mp4')) throw new Error('Each asset must contain only ratio and path to an MP4.');
  return manifest;
}

export function createApi({ token, origin = ORIGIN, fetcher = fetch }) {
  if (!TOKEN_RE.test(token)) throw new Error('No valid personal API token. Run connect and approve in your browser.');
  return async function api(path, { method = 'GET', body, headers = {}, binary = false } = {}) {
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) throw new Error('Invalid API path.');
    const requestHeaders = { ...headers, authorization: `Bearer ${token}`, accept: 'application/json' };
    if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); requestHeaders['content-type'] = 'application/json'; }
    let response;
    try { response = await fetcher(`${origin}/agent/v1${path}`, { method, headers: requestHeaders, body, redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
    catch { throw new Error(`Request could not be confirmed (${method} ${path.split('?')[0]}). Do not repeat a write blindly; inspect list/status. No automatic retry was performed.`); }
    if (response.status === 204) return { etag: response.headers.get('x-part-etag') || response.headers.get('etag') };
    const mime = response.headers.get('content-type') || '';
    if (binary && response.ok && mime.startsWith('video/mp4')) return response;
    if (!mime.toLowerCase().includes('application/json')) throw new Error(`Expected JSON, received HTTP ${response.status}. Login redirects/HTML are rejected. Check service agent access configuration.`);
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${data.error?.code || data.code || 'REQUEST_FAILED'} — ${data.error?.message || data.message || 'Request failed'}`);
      error.status = response.status;
      const retry = Number(response.headers.get('retry-after'));
      error.retryAfter = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 60) : 10;
      throw error;
    }
    return data;
  };
}

async function hiddenToken() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Login requires an interactive terminal. Do not paste tokens into Claude chat or shell commands.');
  process.stderr.write('Paste personal API token (hidden), then Enter: ');
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolvePromise, reject) => {
    let input = '';
    const finish = (error) => { process.stdin.off('data', receive); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); error ? reject(error) : resolvePromise(input.trim()); };
    const receive = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') return finish(new Error('Login cancelled.'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') input = input.slice(0,-1);
        else if (/^[a-zA-Z0-9_]$/.test(char)) input += char;
        if (input.length > 100) return finish(new Error('Invalid token.'));
      }
    };
    process.stdin.on('data', receive);
  });
}

// PowerShell's native ACL APIs avoid localized icacls output and account-name ambiguity.
export function windowsCredentialAcl(path, { directory = false, secure = false, runner = execFileSync } = {}) {
  const literal = "'" + path.replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference = 'Stop'
$p = ${literal}
$item = Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Credential path is a reparse point' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
${secure ? `$acl = New-Object Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', '${directory ? 'ContainerInherit, ObjectInherit' : 'None'}', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl` : ''}
$acl = Get-Acl -LiteralPath $p
if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unsafe credential ACL owner/inheritance' }
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl' -or $rules[0].IsInherited) { throw 'Unsafe credential ACL permissions' }
`;
  try { runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'pipe', windowsHide: true }); }
  catch { throw new Error('Windows credential ACL validation failed. Use a local NTFS profile directory; no token was stored or loaded.'); }
}

export async function saveToken(token, configDir = CONFIG_DIR, origin = ORIGIN) {
  if (origin !== ORIGIN) { apiOrigin({ RH_META_DEV_ORIGIN: origin }); configDir = join(configDir, 'development', encodeURIComponent(origin)); }
  if (!TOKEN_RE.test(token)) throw new Error('Invalid personal token.');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const info = await lstat(configDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Credential directory must be a real directory.');
  if (process.platform === 'win32') windowsCredentialAcl(configDir, { directory: true, secure: true });
  else await chmod(configDir, 0o700);
  const temporary = join(configDir, `credentials-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    if (process.platform === 'win32') windowsCredentialAcl(temporary, { secure: true });
    await file.writeFile(JSON.stringify({ token, origin }) + '\n');
    await file.close();
    await rename(temporary, join(configDir, 'credentials.json'));
  } catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
}

export async function loadToken(origin, { env = process.env, configDir = CONFIG_DIR } = {}) {
  if (env.RH_META_TOKEN) return env.RH_META_TOKEN;
  if (origin !== ORIGIN) { apiOrigin({ RH_META_DEV_ORIGIN: origin }); configDir = join(configDir, 'development', encodeURIComponent(origin)); }
  try {
    const credentialFile = join(configDir, 'credentials.json');
    // An empty first-run folder is a missing login, even before its ACL is secured.
    await lstat(credentialFile);
    for (const [path, directory] of [[configDir, true], [credentialFile, false]]) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (process.platform !== 'win32' && (info.mode & 0o077))) throw Object.assign(new Error('Unsafe credential file permissions.'), { code: 'CREDENTIAL_UNSAFE' });
      if (process.platform === 'win32') {
        try { windowsCredentialAcl(path, { directory }); }
        catch { throw Object.assign(new Error('Unsafe credential ACL.'), { code: 'CREDENTIAL_UNSAFE' }); }
      }
    }
    const data = JSON.parse(await readFile(credentialFile, 'utf8'));
    if (data.origin !== origin || !TOKEN_RE.test(data.token)) throw Object.assign(new Error('Credential origin or token mismatch.'), { code: 'CREDENTIAL_INVALID' });
    return data.token;
  } catch (error) {
    const code = error.code === 'ENOENT' ? 'CREDENTIAL_MISSING' : error.code === 'CREDENTIAL_UNSAFE' || error.code === 'EACCES' || error.code === 'EPERM' ? 'CREDENTIAL_UNSAFE' : 'CREDENTIAL_INVALID';
    throw Object.assign(new Error(origin === ORIGIN ? 'No safe saved login. Run connect and approve in your browser.' : 'Development requires a separate RH_META_TOKEN or connect login; saved production credentials are not used.'), { code });
  }
}

async function openRegularFile(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('INVALID_FILE');
  // Nonblocking open also rejects a FIFO swapped in after lstat without hanging.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('INVALID_FILE');
    if (info.ino !== before.ino || info.dev !== before.dev) throw new Error('FILE_CHANGED');
    return { file, info };
  } catch (error) { await file.close(); throw error; }
}

async function readManifestFiles(manifestPath) {
  let parsed;
  const { file: manifestFile } = await openRegularFile(manifestPath);
  let source;
  try { source = await manifestFile.readFile('utf8'); } finally { await manifestFile.close(); }
  try { parsed = JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch { throw Object.assign(new Error('Manifest must be valid UTF-8 JSON.'), { code: 'MANIFEST_JSON_INVALID' }); }
  const manifest = validateManifest(parsed);
  const files = [];
  for (const asset of manifest.assets) {
    const path = resolve(dirname(resolve(manifestPath)), asset.path);
    const { file, info } = await openRegularFile(path);
    try {
      if (!info.isFile() || info.size < 12 || info.size > 512 * 1024 * 1024) throw new Error(`${asset.ratio}: file must be a regular MP4 between 12 bytes and 512 MiB.`);
      const header = Buffer.alloc(12); await file.read(header, 0, 12, 0);
      if (header.toString('latin1', 4, 8) !== 'ftyp') throw new Error(`${asset.ratio}: MP4 signature missing.`);
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
      files.push({ ratio: asset.ratio, path, originalName: basename(path), bytes: info.size, contentType: 'video/mp4', sha256: hash.digest('hex'), mtimeMs: info.mtimeMs });
    } finally { await file.close(); }
  }
  return { manifest, files };
}

// Device approval transfers a token directly into the local private store.
export function openVerificationUrl(url, { platform = process.platform, runner = execFileSync } = {}) {
  try {
    if (platform === 'win32') runner('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    else runner(platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch { return false; }
}

export async function connect({ env = process.env, configDir = CONFIG_DIR, fetcher = globalThis.fetch, browser = openVerificationUrl, report = (data) => process.stderr.write(JSON.stringify(data) + '\n'), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now, persist = saveToken } = {}) {
  const origin = apiOrigin(env);
  const startedAt = now();
  let existing;
  try { existing = await loadToken(origin, { env, configDir }); }
  catch (error) { if (!['CREDENTIAL_MISSING', 'CREDENTIAL_INVALID'].includes(error.code)) throw new Error('Existing credential permissions could not be verified. Repair the private login before connecting.'); }
  if (existing && TOKEN_RE.test(existing)) {
    let response;
    try { response = await fetcher(`${origin}/agent/v1/me`, { headers: { authorization: `Bearer ${existing}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('Existing connection could not be checked. No new connection was started; check your network.'); }
    if (response.status !== 401) {
      if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) { await response.body?.cancel().catch(() => {}); throw new Error(`Existing connection check stopped (HTTP ${response.status}). No new connection was started.`); }
      let identity; try { identity = await response.json(); } catch { throw new Error('Existing connection check returned invalid JSON. No new connection was started.'); }
      if (typeof identity?.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email) || identity.email.includes(existing)) throw new Error('Existing connection check returned invalid identity.');
      return { connected: true, reused: true, email: identity.email, expiresAt: null };
    }
    await response.body?.cancel().catch(() => {});
  }
  const post = async (path, body, timeout) => {
    let response;
    try { response = await fetcher(`${origin}/agent/v1/connect/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(15000, timeout))) }); }
    catch { throw new Error(`Connect ${path} response could not be confirmed. No retry was performed. Check browser connection status before starting again.`); }
    if (!response.ok) {
      let code;
      if ((response.headers.get('content-type') || '').includes('application/json')) {
        try { const error = await response.json(); code = error?.error?.code || error?.code; } catch { /* Raw response details are never shown. */ }
      } else await response.body?.cancel().catch(() => {});
      const actions = {
        AGENT_TOKEN_LIMIT: 'Cancel an unused connection in Workbench > Claude Code connection before reconnecting.',
        DEVICE_CONNECT_EXPIRED: 'Approval expired. Run connect again to receive a new approval code.',
        DEVICE_CONNECT_CLAIMED: 'Approval was already claimed. Run doctor to check the existing connection before reconnecting.',
        RATE_LIMITED: 'Wait before running connect again. No automatic retry was performed.',
      };
      const recognized = typeof code === 'string' && Object.hasOwn(actions, code);
      throw new Error(`Connect stopped (HTTP ${response.status}${recognized ? `: ${code}` : ''}). ${recognized ? actions[code] : 'Check browser connection status before reconnecting. No retry was performed.'}`);
    }
    if (!(response.headers.get('content-type') || '').includes('application/json')) { await response.body?.cancel().catch(() => {}); throw new Error('Connect expected JSON. Check agent Access configuration; no retry was performed.'); }
    try { return await response.json(); } catch { throw new Error('Connect received invalid JSON. No retry was performed.'); }
  };
  const start = await post('start', {}, 15000);
  if (!/^rhd_[a-f0-9]{64}$/.test(start.deviceCode || '') || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(start.userCode || '') || !Number.isInteger(start.expiresIn) || start.expiresIn < 1 || start.expiresIn > 600 || !Number.isInteger(start.interval) || start.interval < 5 || start.interval > 60) throw new Error('Invalid connect session response. No token was saved.');
  let verification;
  try { verification = new URL(start.verificationUrl); } catch { throw new Error('Invalid verification URL.'); }
  if (![ORIGIN, origin].includes(verification.origin) || verification.username || verification.password || verification.pathname !== '/' || verification.searchParams.get('connect') !== start.userCode || [...verification.searchParams.keys()].some((key) => key !== 'connect') || !['', '#agents'].includes(verification.hash) || !['http:', 'https:'].includes(verification.protocol)) throw new Error('Verification URL origin is not allowed.');
  // Only public approval coordinates leave the client; deviceCode stays private.
  report({ userCode: start.userCode, verificationUrl: verification.href });
  try { await browser(verification.href); } catch { /* The printed public URL remains available for manual opening. */ }
  const deadline = startedAt + start.expiresIn * 1000;
  while (now() < deadline) {
    await sleep(Math.min(start.interval * 1000, deadline - now()));
    if (now() >= deadline) break;
    const result = await post('poll', { deviceCode: start.deviceCode }, deadline - now());
    if (result.status === 'pending') continue;
    if (result.status !== 'connected' || !TOKEN_RE.test(result.token || '') || typeof result.email !== 'string' || result.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email) || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= now() || result.email.includes(result.token) || result.email.includes(start.deviceCode)) throw new Error('Invalid connect claim response. No retry was performed.');
    try { await persist(result.token, configDir, origin); }
    catch { throw new Error('Browser approval succeeded but private credential storage failed. Revoke this connection in the browser before reconnecting; no claim retry was performed.'); }
    return { connected: true, email: result.email, expiresAt: result.expiresAt };
  }
  throw new Error('Connect approval timed out. No token was saved.');
}

// tkhd layout and display matrix: Apple QuickTime File Format, Track header atom.
// Only a single video track with a pure right-angle rotation is auto-classified.
export async function inspectMp4(path) {
  const { file, info } = await openRegularFile(path);
  let atoms = 0;
  const read = async (offset, length) => {
    if (offset < 0 || offset + length > info.size || length > 128) throw new Error('INVALID_ATOM');
    const bytes = Buffer.alloc(length);
    if ((await file.read(bytes, 0, length, offset)).bytesRead !== length) throw new Error('TRUNCATED_ATOM');
    return bytes;
  };
  const children = async (start, end) => {
    const result = [];
    for (let offset = start; offset < end;) {
      if (++atoms > 4096 || end - offset < 8) throw new Error('ATOM_LIMIT_OR_TRUNCATION');
      const header = await read(offset, 8); let size = header.readUInt32BE(0), head = 8;
      if (size === 1) { const extended = (await read(offset + 8, 8)).readBigUInt64BE(0); if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_ATOM'); size = Number(extended); head = 16; }
      if (size === 0) size = end - offset;
      if (size < head || offset + size > end) throw new Error('INVALID_ATOM');
      result.push({ type: header.toString('latin1', 4, 8), start: offset + head, end: offset + size }); offset += size;
    }
    return result;
  };
  try {
    if (info.size < 12 || info.size > 512 * 1024 * 1024) throw new Error('INVALID_FILE');
    const top = await children(0, info.size);
    if (!top.some((atom) => atom.type === 'ftyp')) throw new Error('MISSING_FTYP');
    const movies = top.filter((atom) => atom.type === 'moov');
    if (movies.length !== 1) throw new Error('MISSING_OR_MULTIPLE_MOOV');
    const tracks = (await children(movies[0].start, movies[0].end)).filter((atom) => atom.type === 'trak');
    const videos = [];
    for (const track of tracks) {
      const items = await children(track.start, track.end), headers = items.filter((atom) => atom.type === 'tkhd'), media = items.filter((atom) => atom.type === 'mdia');
      if (media.length !== 1) throw new Error('INVALID_TRACK');
      const handlers = (await children(media[0].start, media[0].end)).filter((atom) => atom.type === 'hdlr');
      if (handlers.length !== 1 || handlers[0].end - handlers[0].start < 12) throw new Error('INVALID_HANDLER');
      if ((await read(handlers[0].start, 12)).toString('latin1', 8, 12) !== 'vide') continue;
      if (headers.length !== 1) throw new Error('INVALID_TRACK_HEADER');
      const version = (await read(headers[0].start, 1))[0], length = version === 0 ? 84 : version === 1 ? 96 : 0;
      if (!length || headers[0].end - headers[0].start < length) throw new Error('INVALID_TRACK_HEADER');
      const h = await read(headers[0].start, length), matrix = version === 0 ? 40 : 52;
      const a = h.readInt32BE(matrix), b = h.readInt32BE(matrix + 4), c = h.readInt32BE(matrix + 12), d = h.readInt32BE(matrix + 16);
      if (h.readInt32BE(matrix + 8) !== 0 || h.readInt32BE(matrix + 20) !== 0 || h.readInt32BE(matrix + 32) !== 0x40000000) throw new Error('UNSUPPORTED_TRANSFORM');
      const rotation = [[65536, 0, 0, 65536], [0, 65536, -65536, 0], [-65536, 0, 0, -65536], [0, -65536, 65536, 0]].findIndex((m) => m.every((v, i) => v === [a, b, c, d][i]));
      if (rotation < 0) throw new Error('UNSUPPORTED_TRANSFORM');
      const width = h.readUInt32BE(matrix + 36) / 65536, height = h.readUInt32BE(matrix + 40) / 65536;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 32768 || height > 32768) throw new Error('INVALID_DIMENSIONS');
      const displayWidth = rotation % 2 ? height : width, displayHeight = rotation % 2 ? width : height;
      // 0.5% allows encoder rounding, but never broad portrait/landscape guessing.
      const ratio = RATIOS.find((value) => { const [w, h] = value.split('x').map(Number); return Math.abs(displayWidth / displayHeight / (w / h) - 1) <= 0.005; }) || null;
      videos.push({ width, height, rotation: rotation * 90, displayWidth, displayHeight, ratio });
    }
    if (videos.length !== 1) throw new Error('VIDEO_TRACK_COUNT');
    const after = await file.stat(); if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('FILE_CHANGED');
    return { ...videos[0], bytes: info.size, evidence: 'mp4_tkhd_and_video_handler' };
  } finally { await file.close(); }
}

export async function scanFolder(folder) {
  const root = resolve(folder), limits = { maxDepth: 3, maxEntries: 500, maxFileBytes: 512 * 1024 * 1024, maxAtomsPerFile: 4096 };
  const candidates = [], conflicts = [], groups = Object.fromEntries(RATIOS.map((ratio) => [ratio, []])); let entries = 0, complete = true;
  const walk = async (path, depth) => {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { complete = false; conflicts.push({ path, code: 'DIRECTORY_OR_SYMLINK_REJECTED' }); return; }
    const dir = await opendir(path);
    for await (const entry of dir) {
      if (++entries > limits.maxEntries) { complete = false; conflicts.push({ path, code: 'ENTRY_LIMIT' }); break; }
      const child = join(path, entry.name), info = await lstat(child);
      if (info.isSymbolicLink()) { complete = false; conflicts.push({ path: child, code: 'SYMLINK_SKIPPED' }); continue; }
      if (info.isDirectory()) { if (depth >= limits.maxDepth) { complete = false; conflicts.push({ path: child, code: 'DEPTH_LIMIT' }); } else await walk(child, depth + 1); }
      else if (info.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
        try {
          const candidate = { path: child, ...await inspectMp4(child) }; candidates.push(candidate);
          if (candidate.ratio) groups[candidate.ratio].push(child); else conflicts.push({ path: child, code: 'UNSUPPORTED_RATIO' });
        } catch (error) {
          const allowed = ['INVALID_FILE', 'INVALID_ATOM', 'TRUNCATED_ATOM', 'ATOM_LIMIT_OR_TRUNCATION', 'MISSING_FTYP', 'MISSING_OR_MULTIPLE_MOOV', 'INVALID_TRACK', 'INVALID_HANDLER', 'INVALID_TRACK_HEADER', 'UNSUPPORTED_TRANSFORM', 'INVALID_DIMENSIONS', 'VIDEO_TRACK_COUNT', 'FILE_CHANGED'];
          conflicts.push({ path: child, code: allowed.includes(error.message) ? error.message : 'FILE_UNREADABLE' });
        }
      }
      if (entries > limits.maxEntries) break;
    }
  };
  try { await walk(root, 0); } catch { complete = false; conflicts.push({ path: root, code: 'FOLDER_UNREADABLE' }); }
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  for (const ratio of RATIOS) { groups[ratio].sort(); if (groups[ratio].length !== 1) conflicts.push({ ratio, code: groups[ratio].length ? 'AMBIGUOUS_RATIO' : 'MISSING_RATIO', candidates: groups[ratio] }); }
  const ok = complete && conflicts.length === 0;
  return { ok, command: 'scan-folder', folder: root, complete, candidates, groups, conflicts, ...(ok ? { selected: RATIOS.map((ratio) => ({ ratio, path: groups[ratio][0] })) } : {}), limits, notChecked: ['videoPlayback', 'metaCompatibility', 'gameIdentity', 'contentReview', 'sourceReviewFreshness'] };
}

// Local-only inspection: this function does not load credentials or create a draft.
export async function checkManifest(manifestPath) {
  const result = { ok: false, command: 'check-manifest', manifestPath: resolve(manifestPath), notChecked: ['videoDimensions', 'videoOrientation', 'videoPlayback', 'metaCompatibility', 'sourceReviewFreshness', 'gameIdentity', 'contentReview'] };
  try {
    const { files } = await readManifestFiles(manifestPath);
    return { ...result, ok: true, checks: { manifestSchema: true, threeRatios: true, regularFiles: true, fileSize: true, mp4Signature: true, sha256: true }, assets: files.map(({ ratio, path, bytes, sha256 }) => ({ ratio, path, bytes, sha256 })), nextAction: 'Review source settings and videos before prepare. This check did not create a draft or submit an ad.' };
  } catch (error) {
    const code = error.code === 'MANIFEST_JSON_INVALID' ? 'MANIFEST_JSON_INVALID' : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'FILE_NOT_FOUND' : ['EACCES', 'EPERM'].includes(error.code) ? 'FILE_ACCESS_DENIED' : 'MANIFEST_OR_ASSET_INVALID';
    return { ...result, error: { code }, nextAction: 'Check UTF-8 JSON, supported manifest fields, exactly three ratio paths, regular MP4 files and the 512 MiB size limit. No draft was created.' };
  }
}

// This diagnostic uses only fixed classifications, never raw server/native error text.
async function checkCliUpdate(fetcher, origin, token, selfPath) {
  try {
    if (!selfPath.endsWith('.mjs')) return { status: 'unknown' };
    const local = createHash('sha256').update(await readFile(selfPath)).digest('hex');
    const response = await fetcher(`${origin}/agent/v1/cli-version`, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const data = await response.json().catch(() => null);
    if (!/^[a-f0-9]{64}$/.test(data?.sha256 || '')) return { status: 'unknown' };
    return { status: data.sha256 === local ? 'current' : 'outdated' };
  } catch { return { status: 'unknown' }; }
}

export async function doctor({ env = process.env, configDir = CONFIG_DIR, nodeVersion = process.versions.node, fetcher = globalThis.fetch, selfPath = process.argv[1] || '' } = {}) {
  const supported = Number(nodeVersion.split('.')[0]) >= 22;
  const result = { ok: false, command: 'doctor', runtime: { node: nodeVersion, minimumMajor: 22, supported }, credential: { source: env.RH_META_TOKEN ? 'environment' : 'saved', status: 'not_checked' }, connection: { status: 'not_checked' }, cliUpdate: { status: 'not_checked' }, nextAction: '' };
  if (!supported) return { ...result, nextAction: 'Install Node.js 22 or newer, reopen the terminal, then run doctor.' };
  let origin;
  try { origin = apiOrigin(env); }
  catch { return { ...result, connection: { status: 'invalid_origin' }, nextAction: 'Remove the invalid RH_META_DEV_ORIGIN override. Production origin is fixed.' }; }
  let token;
  try {
    token = await loadToken(origin, { env, configDir });
    if (!TOKEN_RE.test(token)) throw Object.assign(new Error('Invalid token format.'), { code: 'CREDENTIAL_INVALID' });
  } catch (error) {
    const status = origin !== ORIGIN && !env.RH_META_TOKEN ? 'development_token_required' : error.code === 'CREDENTIAL_MISSING' ? 'missing' : error.code === 'CREDENTIAL_UNSAFE' ? 'unsafe_permissions' : 'invalid';
    return { ...result, credential: { ...result.credential, status }, nextAction: status === 'unsafe_permissions' ? 'Restore owner-only permissions on your local profile directory (NTFS on Windows), then run connect. Manual login is a fallback after permissions are safe.' : status === 'development_token_required' ? 'Use a separate loopback development connection or a private development token. Saved production credentials are never sent to development servers.' : result.credential.source === 'environment' ? 'Remove the invalid RH_META_TOKEN override from the private process environment, then run connect and approve in your browser. Do not paste tokens into chat.' : 'Run connect and approve in your browser. The CLI stores the connection privately; you do not need to copy a token.' };
  }
  result.credential.status = 'available';
  let response;
  try { response = await fetcher(`${origin}/agent/v1/me`, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) }); }
  catch (error) {
    const nativeCode = error?.cause?.code;
    const status = ['TimeoutError', 'AbortError'].includes(error?.name) || nativeCode === 'UND_ERR_CONNECT_TIMEOUT' ? 'timeout' : ['ENOTFOUND', 'EAI_AGAIN'].includes(nativeCode) ? 'dns_error' : ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(nativeCode) ? 'tls_error' : 'network_error';
    return { ...result, connection: { status }, nextAction: 'Check the network, VPN, DNS and system clock, then rerun doctor. No write was attempted.' };
  }
  const httpStatus = response.status;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  let status = httpStatus >= 300 && httpStatus < 400 ? 'access_redirect' : contentType.includes('text/html') ? 'access_html' : httpStatus === 401 ? 'unauthorized' : httpStatus === 403 ? 'forbidden' : httpStatus === 429 ? 'rate_limited' : httpStatus >= 500 ? 'service_error' : !response.ok ? 'http_error' : !contentType.includes('application/json') ? 'unexpected_response' : 'connected';
  // Authentication errors intentionally do not distinguish missing server records,
  // revoked tokens and expired tokens. Do not infer an exact expiry date.
  if (status === 'unauthorized') result.credential.status = 'invalid_expired_or_revoked';
  if (status === 'connected') {
    try {
      const data = await response.json();
      if (typeof data?.email !== 'string' || typeof data?.role !== 'string') status = 'unexpected_response';
    } catch { status = 'unexpected_response'; }
  } else await response.body?.cancel().catch(() => {});
  const baseNextAction = status === 'connected' ? 'Connection is ready. Give Claude the material folder and your instructions; scan-folder and check-manifest can prepare the files. Reuse resume for an existing unsubmitted draft.' : status === 'unauthorized' ? result.credential.source === 'environment' ? 'Remove the rejected RH_META_TOKEN override from the private process environment, then run connect and approve in your browser.' : 'Run connect to renew the connection through browser approval. The server cannot distinguish expired, revoked and invalid tokens here.' : ['access_redirect', 'access_html'].includes(status) ? 'Ask the workbench administrator to check Access configuration for /agent/v1/* only. Keep browser authentication enabled.' : status === 'rate_limited' ? 'Wait before rerunning doctor. No automatic retry was performed.' : status === 'forbidden' ? 'Ask the administrator to verify your allowed account and API permissions. Do not use management credentials.' : 'Check service availability with the administrator. Do not retry prepare or submit blindly.';
  const cliUpdate = status === 'connected' ? await checkCliUpdate(fetcher, origin, token, selfPath) : result.cliUpdate;
  const nextAction = cliUpdate.status === 'outdated' ? 'This CLI copy is outdated. Run update to replace it with the verified current file, then rerun doctor.' : baseNextAction;
  return { ...result, ok: status === 'connected', connection: { status, httpStatus }, cliUpdate, nextAction };
}

export async function updateCli(api, selfPath) {
  if (typeof selfPath !== 'string' || !selfPath.endsWith('.mjs')) throw new Error('Cannot locate the running CLI file; re-download it from the Workbench downloads page.');
  const current = createHash('sha256').update(await readFile(selfPath)).digest('hex');
  const bundle = await api('/cli-download', { method: 'GET' });
  if (typeof bundle?.source !== 'string' || !/^[a-f0-9]{64}$/.test(bundle?.sha256 || '')) throw new Error('Server did not return a valid CLI package; kept the current file.');
  if (createHash('sha256').update(bundle.source).digest('hex') !== bundle.sha256) throw new Error('Downloaded CLI failed integrity check; kept the current file.');
  if (bundle.sha256 === current) return { updated: false, sha256: current };
  const tmp = `${selfPath}.update-${randomUUID()}`;
  try {
    await writeFile(tmp, bundle.source, 'utf8');
    await rename(tmp, selfPath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return { updated: true, sha256: bundle.sha256, previousSha256: current };
}

export async function prepare(manifestPath, api) {
  const { manifest, files } = await readManifestFiles(manifestPath);
  const operation = await api('/operations', { method: 'POST', body: { ...manifest, assets: files.map(({ path, mtimeMs, ...asset }) => asset) } });
  if (!UUID_RE.test(operation.id)) throw new Error('Server did not return a valid operation ID; inspect list before preparing again.');
  // Emit recovery ID before any upload. Re-running prepare creates another draft, not a resume.
  process.stderr.write(JSON.stringify({ event: 'DRAFT_CREATED', operationId: operation.id, recovery: `status ${operation.id}` }) + '\n');
  return uploadFiles(operation.id, files, api);
}

async function uploadFiles(operationId, files, api) {
  for (const asset of files) {
    const { file, info } = await openRegularFile(asset.path);
    try {
      if (info.size !== asset.bytes || info.mtimeMs !== asset.mtimeMs) throw new Error('Source file changed after hashing. Stop and inspect the draft.');
      const base = `/operations/${operationId}/uploads/${asset.ratio}`;
      const upload = await api(`${base}/start`, { method: 'POST', body: {} });
      if (!Number.isSafeInteger(upload.partSize) || upload.partSize < 1 || upload.partSize > 32 * 1024 * 1024 || typeof upload.uploadId !== 'string') throw new Error('Invalid upload session response.');
      const parts = [];
      for (let offset = 0, partNumber = 1; offset < asset.bytes; offset += upload.partSize, partNumber++) {
        const bytes = Math.min(upload.partSize, asset.bytes - offset);
        const buffer = Buffer.alloc(bytes);
        const read = await file.read(buffer, 0, bytes, offset);
        if (read.bytesRead !== bytes) throw new Error('Source file changed during upload.');
        const result = await api(`${base}/parts/${partNumber}`, { method: 'PUT', body: buffer, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes), 'x-upload-id': upload.uploadId } });
        if (!result.etag) throw new Error('Upload part receipt missing.');
        parts.push({ partNumber, etag: result.etag });
        process.stderr.write(JSON.stringify({ event: 'UPLOAD_PROGRESS', operationId: operationId, ratio: asset.ratio, bytes: offset + bytes, total: asset.bytes }) + '\n');
      }
      await api(`${base}/complete`, { method: 'POST', body: { uploadId: upload.uploadId, parts } });
    } finally { await file.close(); }
  }
  return { operationId: operationId, prepared: true, submitted: false, next: `node rh-meta.mjs submit ${operationId} --confirm-new-paused` };
}

export async function resume(operationId, manifestPath, api) {
  if (!UUID_RE.test(operationId)) throw new Error('A valid operation UUID is required.');
  const { manifest, files } = await readManifestFiles(manifestPath);
  const bundle = await api(`/operations/${operationId}`);
  const operation = bundle.operation;
  if (!operation || operation.id !== operationId || !['DRAFT', 'ASSETS_READY'].includes(operation.state)) throw new Error('Only an existing unsubmitted draft can be resumed. Inspect status.');
  const fields = { gameId: 'game_id', language: 'language', targetAdsetId: 'target_adset_id', referenceAdId: 'reference_ad_id', newAdName: 'new_ad_name' };
  if (Object.entries(fields).some(([local, remote]) => manifest[local] !== operation[remote]) || bundle.reviewed?.hash !== manifest.reviewedSourceHash) throw new Error('Manifest does not match the existing reviewed draft. No upload was performed.');
  if (!Array.isArray(bundle.assets) || bundle.assets.length !== 3) throw new Error('Invalid existing draft assets.');
  const pending = [];
  for (const file of files) {
    const saved = bundle.assets.filter((asset) => asset.ratio === file.ratio);
    if (saved.length !== 1 || saved[0].sha256 !== file.sha256 || saved[0].bytes !== file.bytes || saved[0].original_name !== file.originalName || saved[0].staging_deleted_at || !['PENDING', 'UPLOADING', 'UPLOADED'].includes(saved[0].state)) throw new Error(`${file.ratio}: local file differs from the draft or cannot be resumed. No upload was performed.`);
    if (saved[0].state !== 'UPLOADED') pending.push(file);
  }
  // Explicit recovery command: confirmed PUTs return the original receipt server-side.
  // This never creates another draft or retries an ambiguous Meta write.
  return uploadFiles(operationId, pending, api);
}

export async function waitForOperation(operationId, api, { interval = 10, timeout = 600, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now } = {}) {
  if (!Number.isFinite(interval) || interval < 5 || interval > 60 || !Number.isFinite(timeout) || timeout < 1 || timeout > 3600) throw new Error('Polling interval must be 5–60 seconds and timeout 1–3600 seconds.');
  const deadline = now() + timeout * 1000;
  let previous;
  while (true) {
    let bundle;
    try { bundle = await api(`/operations/${operationId}`); }
    catch (error) {
      if (error.status !== 429 || now() >= deadline) throw error;
      await sleep(Math.min(Math.max(interval, error.retryAfter || 10) * 1000, deadline - now()));
      continue;
    }
    const state = bundle.operation?.state;
    if (typeof state !== 'string') throw new Error('Invalid operation status response.');
    if (state !== previous) process.stderr.write(JSON.stringify({ event: 'OPERATION_STATE', operationId, state }) + '\n');
    previous = state;
    if (['AWAITING_MARKETER_REVIEW', 'FAILED_TERMINAL', 'UNKNOWN_EXTERNAL_WRITE'].includes(state)) return bundle;
    if (['DRAFT', 'ASSETS_READY'].includes(state)) throw new Error('Operation has not been submitted. Review it before explicit submit.');
    if (now() >= deadline) throw new Error(`Polling timed out. No write was performed; inspect status ${operationId}.`);
    await sleep(Math.min(interval * 1000, deadline - now()));
  }
}

// Resolve names only after exhaustive, consistent catalog reads. Never pick a first match.
export async function resolveSource({ adsetName, referenceName, campaignName, gameId = 'rabbit-hole' }, api) {
  const validName = (name) => typeof name === 'string' && name.trim().length > 0 && name.length <= 512;
  if (!validName(adsetName) || !validName(referenceName) || (campaignName !== undefined && !validName(campaignName))) {
    return { ok: false, code: 'INVALID_SOURCE_NAMES', candidates: [], nextAction: 'Supply exact ad set and reference names; optionally supply the exact campaign name.' };
  }
  if (typeof gameId !== 'string' || !GAME_REGISTRY[gameId]) {
    return { ok: false, code: 'UNKNOWN_GAME', candidates: [], nextAction: 'Run update to refresh rh-meta.mjs and retry with a supported game.' };
  }
  const gameQuery = `gameId=${encodeURIComponent(gameId)}`;
  const fail = (code, candidates, nextAction) => ({ ok: false, code, candidates, nextAction });
  const readCatalog = async (path, kind) => {
    const byId = new Map(), cursors = new Set();
    let after = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const query = after === null ? '' : `${path.includes('?') ? '&' : '?'}after=${encodeURIComponent(after)}`;
      const page = await api(path + query);
      if (!page || !Array.isArray(page.items) || !(page.after === null || (typeof page.after === 'string' && /^[A-Za-z0-9_+/=-]{1,2048}$/.test(page.after)))) throw new Error('Invalid catalog page');
      for (const raw of page.items) {
        if (!raw || typeof raw.id !== 'string' || !/^[1-9]\d{0,29}$/.test(raw.id) || typeof raw.name !== 'string' || typeof raw.status !== 'string') throw new Error('Invalid catalog identity');
        const item = { id: raw.id, name: raw.name, status: raw.status };
        if (kind === 'adset') {
          if (!raw.campaign || typeof raw.campaign.id !== 'string' || !/^[1-9]\d{0,29}$/.test(raw.campaign.id) || typeof raw.campaign.name !== 'string') throw new Error('Invalid campaign identity');
          item.campaign = { id: raw.campaign.id, name: raw.campaign.name };
        } else {
          if (typeof raw.creativeId !== 'string' || !/^[1-9]\d{0,29}$/.test(raw.creativeId)) throw new Error('Invalid creative identity');
          item.creativeId = raw.creativeId;
        }
        if (byId.has(item.id) && JSON.stringify(byId.get(item.id)) !== JSON.stringify(item)) throw new Error('Catalog changed during pagination');
        byId.set(item.id, item);
        if (byId.size > 5000) throw new Error('Catalog item limit');
      }
      if (page.after === null) return [...byId.values()];
      if (cursors.has(page.after)) throw new Error('Repeated catalog cursor');
      cursors.add(page.after); after = page.after;
    }
    throw new Error('Catalog page limit');
  };
  let adsets, references;
  try { adsets = await readCatalog(`/catalog/adsets?${gameQuery}`, 'adset'); }
  catch { return fail('CATALOG_INCOMPLETE', [], 'The full ad set catalog could not be confirmed. Retry this read-only command later; do not select from partial results.'); }
  const matches = adsets.filter((item) => item.name === adsetName && (campaignName === undefined || item.campaign.name === campaignName));
  if (matches.length !== 1) return fail(matches.length ? 'ADSET_AMBIGUOUS' : 'ADSET_NOT_FOUND', matches.map((item, index) => ({ choice: index + 1, ...item })), 'Present numbered choices; ask the marketer for a choice or campaign, never an ad ID or ID suffix. Identical settings do not authorize choosing automatically.');
  const adset = matches[0];
  try { references = await readCatalog(`/catalog/ads?adsetId=${adset.id}&${gameQuery}`, 'reference'); }
  catch { return fail('CATALOG_INCOMPLETE', [], 'The full reference catalog could not be confirmed. Retry this read-only command later; do not select from partial results.'); }
  const referenceMatches = references.filter((item) => item.name === referenceName);
  if (referenceMatches.length !== 1) return fail(referenceMatches.length ? 'REFERENCE_AMBIGUOUS' : 'REFERENCE_NOT_FOUND', referenceMatches.map((item, index) => ({ choice: index + 1, ...item, adsetId: adset.id, adsetName: adset.name, campaign: adset.campaign })), 'Present numbered choices; ask the marketer for a choice or campaign, never an ad ID or ID suffix. Identical settings do not authorize choosing the first ID.');
  const reference = referenceMatches[0];
  try {
    const preview = await api(`/source-preview?${gameQuery}&adsetId=${adset.id}&adId=${reference.id}`);
    if (!preview || typeof preview.hash !== 'string' || !/^[a-f0-9]{64}$/.test(preview.hash)) throw new Error('Invalid preview');
    return { ok: true, adset, reference, preview };
  } catch { return fail('SOURCE_PREVIEW_UNCONFIRMED', [], 'Source preview could not be confirmed. Retry this read-only command later; do not prepare a manifest from an unconfirmed source.'); }
}

export const HELP = `Rabbit Hole Meta Ads — Node.js 22+ / Windows PowerShell, macOS
Usage: node rh-meta.mjs COMMAND [options]
  connect                       Start here: reuse a valid connection or approve in your browser
  scan-folder FOLDER            Inspect MP4 track dimensions/rotation; no filename guessing
  login                         Fallback only: privately paste a manually issued token
  logout                        Remove local login (revoke in Workbench for full revocation)
  doctor                        Diagnose runtime, private login and API access as safe JSON
  update                        Replace this file with the verified current CLI; no-op when current
  check-manifest FILE.json      Local-only schema/file/hash check; no login or upload
  whoami                        Show authenticated identity
  adsets [--game ID] [--after CURSOR]        List allowed account ad sets
  ads --adset ID [--game ID] [--after CURSOR] List reference ads in one ad set
  resolve-source --adset-name NAME --reference-name NAME [--campaign-name NAME] [--game ID]  Resolve unique source names across all pages
  preview --adset ID --ad ID [--game ID]     Review inherited settings; copy approved hash into manifest
  prepare manifest.json         Hash and upload 3 MP4s; create draft only, NEVER submit
  resume OPERATION_ID --manifest FILE.json  Resume the SAME draft after checking hashes
  submit OPERATION_ID --confirm-new-paused [--supersede-failed PREVIOUS_OPERATION_UUID]  Explicitly create a NEW PAUSED ad
  recheck-paused OPERATION_ID   Recheck a confirmed PAUSED ad after AD_PAUSED_TIMEOUT
  recover OPERATION_ID          Record a stranded operation as FAILED after its workflow died
  status OPERATION_ID            State, receipts, errors and preview results
  wait OPERATION_ID [--interval 10] [--timeout 600]  Poll until terminal state
  list [--query TEXT] [--state STATE] [--before UUID] [--limit 40]  History
  lineage OPERATION_ID          Check live identity against recorded IDs/names
  export OPERATION_ID --output FILE.json  Save receipt (refuses overwrite)
  download OPERATION_ID --ratio 9x16 --output FILE.mp4  Save source (refuses overwrite)
  --help                        This help

Catalog commands default to --game rabbit-hole; use --game card-of-demon-slayer for that game. The manifest gameId must match the game used for preview.
Start with connect. A valid saved connection is reused without opening the browser.
Otherwise, approve the displayed code in your browser; the CLI saves the 7-day connection
privately. You do not need to copy a token or give one to Claude.
Then give Claude your material folder and instructions; scan-folder checks video ratios.
Manual login is a fallback when browser connection cannot be used. Only then issue a
personal token in Workbench > Claude Code connection and paste it into login YOURSELF
in an interactive terminal. Never put credentials in chat, manifests, prompts, Git,
screenshots or command-line arguments. Saved credentials have owner-only permissions
and are not encrypted. Windows ACL requires NTFS and your current user account.
RH_META_TOKEN is optional for an existing private process environment; never echo it.
Production host is fixed. RH_META_DEV_ORIGIN allows loopback only; development credentials
are stored separately for each origin and never replace the production connection.
All normal results are JSON on stdout; errors/progress on stderr. Failures exit nonzero.
No automatic POST retry. On unknown results inspect list/status; never duplicate writes.
--supersede-failed requests one explicitly approved retry from an ASSETS_READY draft with a different UUID.
Reuse an existing draft with the same reviewed files/settings/name; never rename to bypass duplicate protection.
The backend must confirm a finished failure with no creative/ad creation or uncertain external effects; unsafe retries are refused.
On a duplicate response, follow the returned operation.id with status/wait; the requested draft was not newly submitted.
prepare resolves asset paths relative to manifest (Windows paths accepted on Windows).
The reference ad is read-only. No activation, budget change, rename or existing-ID overwrite.
Download/export refuse symlinks and existing output files. Review in Ads Manager before activation.
`;

export async function main(args = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(args);
  const [command, id] = positional;
  if (!command || command === 'help' || flags['--help']) { process.stdout.write(HELP); return; }
  if (positional.length > 2) throw new Error('Too many arguments.');
  const specs = { connect: [0, []], 'scan-folder': [1, []], doctor: [0, []], update: [0, []], 'check-manifest': [1, []], login: [0, []], logout: [0, []], whoami: [0, []], 'resolve-source': [0, ['--adset-name','--reference-name','--campaign-name','--game']], adsets: [0, ['--game','--after']], ads: [0, ['--adset','--game','--after']], preview: [0, ['--adset','--ad','--game']], prepare: [1, []], resume: [1, ['--manifest']], wait: [1, ['--interval','--timeout']], submit: [1, ['--confirm-new-paused','--supersede-failed']], 'recheck-paused': [1, []], recover: [1, []], status: [1, []], list: [0, ['--query','--state','--before','--limit']], lineage: [1, []], export: [1, ['--output']], download: [1, ['--output','--ratio']] };
  const spec = specs[command];
  if (!spec || positional.length !== spec[0] + 1 || Object.keys(flags).some((flag) => !spec[1].includes(flag))) throw new Error('Invalid command arguments. Use --help.');
  if (command === 'doctor') { const result = await doctor(); if (!result.ok) process.exitCode = 1; return result; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  if (command === 'connect') return connect();
  if (command === 'scan-folder') { const result = await scanFolder(id); if (!result.ok) process.exitCode = 1; return result; }
  if (command === 'check-manifest') { const result = await checkManifest(resolve(id)); if (!result.ok) process.exitCode = 1; return result; }
  if (command === 'logout') { await unlink(CREDENTIAL_FILE).catch((error) => { if (error.code !== 'ENOENT') throw error; }); return { loggedOut: true, note: 'Revoke the token in Workbench if compromised.' }; }
  const origin = apiOrigin();
  if (command === 'login') {
    if (origin !== ORIGIN) throw new Error('Login saves production credentials only.');
    const token = await hiddenToken();
    const actor = await createApi({ token, origin })('/me');
    await saveToken(token);
    return { loggedIn: true, email: actor.email, credentialFile: CREDENTIAL_FILE };
  }
  if (['submit','recheck-paused','recover','resume','wait','status','lineage','export','download'].includes(command) && !UUID_RE.test(id || '')) throw new Error('A valid operation UUID is required.');
  if (['ads','preview'].includes(command) && !/^\d{5,30}$/.test(flags['--adset'] || '')) throw new Error('--adset must be a Meta numeric ID.');
  if (command === 'preview' && !/^\d{5,30}$/.test(flags['--ad'] || '')) throw new Error('--ad must be a Meta numeric ID.');
  if (command === 'submit' && !flags['--confirm-new-paused']) throw new Error('Submission requires --confirm-new-paused. Obtain marketer approval before this command.');
  if (flags['--supersede-failed'] !== undefined) {
    if (!UUID_RE.test(flags['--supersede-failed'])) throw new Error('--supersede-failed must be a valid previous operation UUID.');
    if (flags['--supersede-failed'] === id) throw new Error('--supersede-failed must differ from the operation UUID being submitted.');
  }
  if (['export','download'].includes(command) && !flags['--output']) throw new Error('--output is required.');
  if (command === 'download' && !RATIOS.includes(flags['--ratio'])) throw new Error('--ratio must be 9x16, 1x1 or 16x9.');
  if (command === 'resume' && !flags['--manifest']) throw new Error('--manifest is required to verify the original files.');
  if (command === 'list' && flags['--before'] && !UUID_RE.test(flags['--before'])) throw new Error('--before must be an operation UUID.');
  if (command === 'list' && flags['--limit'] && (!Number.isInteger(Number(flags['--limit'])) || Number(flags['--limit']) < 1 || Number(flags['--limit']) > 100)) throw new Error('--limit must be 1–100.');
  const gameId = flags['--game'] || 'rabbit-hole';
  if (!GAME_REGISTRY[gameId]) throw new Error(`Unknown game "${gameId}". Run update to refresh rh-meta.mjs and retry with a supported game.`);
  const api = createApi({ token: await loadToken(origin), origin });
  const cursor = flags['--after'] ? `&after=${encodeURIComponent(flags['--after'])}` : '';
  switch (command) {
    case 'resolve-source': {
      const result = await resolveSource({ adsetName: flags['--adset-name'], referenceName: flags['--reference-name'], campaignName: flags['--campaign-name'], gameId }, api);
      if (!result.ok) process.exitCode = 1;
      return result;
    }
    case 'whoami': return api('/me');
    case 'update': return updateCli(api, process.argv[1] || '');
    case 'adsets': return api(`/catalog/adsets?gameId=${encodeURIComponent(gameId)}${cursor}`);
    case 'ads': return api(`/catalog/ads?adsetId=${flags['--adset']}&gameId=${encodeURIComponent(gameId)}${cursor}`);
    case 'preview': return api(`/source-preview?gameId=${encodeURIComponent(gameId)}&adsetId=${flags['--adset']}&adId=${flags['--ad']}`);
    case 'prepare': return prepare(resolve(id), api);
    case 'resume': return resume(id, resolve(flags['--manifest']), api);
    case 'wait': {
      const result = await waitForOperation(id, api, { interval: Number(flags['--interval'] || 10), timeout: Number(flags['--timeout'] || 600) });
      if (result.operation.state !== 'AWAITING_MARKETER_REVIEW') process.exitCode = 1;
      return result;
    }
    case 'recheck-paused': return api(`/operations/${id}/recheck-paused`, { method: 'POST', body: {} });
    case 'recover': return api(`/operations/${id}/recover-stranded`, { method: 'POST', body: {} });
    case 'submit': {
      const body = flags['--supersede-failed'] === undefined ? {} : { supersedeFailedOperationId: flags['--supersede-failed'] };
      const result = await api(`/operations/${id}/submit`, { method: 'POST', body });
      if (result.duplicate === true || (result.operation?.id && result.operation.id !== id)) {
        process.stderr.write(JSON.stringify({ requestedOperationId: id, operationId: result.operation?.id, note: 'This response does not confirm a new submission of the requested draft. Follow the returned operation.id with status/wait; do not repeat submit. If the returned ID is missing, inspect list/status first.' }) + '\n');
      }
      return result;
    }
    case 'status': return api(`/operations/${id}`);
    case 'list': {
      const query = new URLSearchParams();
      for (const [flag, key] of [['--query','q'],['--state','state'],['--before','before'],['--limit','limit']]) if (flags[flag]) query.set(key, flags[flag]);
      return api(`/operations?${query}`);
    }
    case 'lineage': return api(`/operations/${id}/lineage`);
    case 'export': {
      const result = await api(`/operations/${id}/export`);
      const file = await open(resolve(flags['--output']), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(result, null, 2) + '\n'); } finally { await file.close(); }
      return { exported: true, path: resolve(flags['--output']) };
    }
    case 'download': {
      const response = await api(`/operations/${id}/assets/${flags['--ratio']}/download`, { binary: true });
      const file = await open(resolve(flags['--output']), 'wx', 0o600);
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 512 * 1024 * 1024) throw new Error('Download exceeds 512 MiB.');
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = await file.write(chunk, offset, chunk.byteLength - offset);
            if (!written.bytesWritten) throw new Error('Could not write downloaded file.');
            offset += written.bytesWritten;
          }
        }
      } catch (error) { await file.close(); await unlink(resolve(flags['--output'])); throw error; }
      await file.close(); return { downloaded: true, bytes: size, path: resolve(flags['--output']) };
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => { if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + '\n'); })
    .catch((error) => { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; });
}
