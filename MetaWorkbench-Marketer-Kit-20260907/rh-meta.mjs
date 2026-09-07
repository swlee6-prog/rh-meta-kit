#!/usr/bin/env node
// Node.js >=22, dependency-free. Never pass a token as an argument.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, mkdir, rename, unlink, lstat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ORIGIN = 'https://meta-ads.rabbithole-studios.io';
const TOKEN_RE = /^rhm_[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RATIOS = ['9x16', '1x1', '16x9'];
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
    if (!['--adset', '--ad', '--after', '--confirm-new-paused', '--output', '--ratio', '--manifest', '--interval', '--timeout', '--query', '--state', '--before', '--limit', '--help'].includes(arg) || arg in flags) throw new Error(`Unknown or duplicate option: ${arg}`);
    if (['--confirm-new-paused', '--help'].includes(arg)) flags[arg] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value: ${arg}`); flags[arg] = args[++i]; }
  }
  return { positional, flags };
}

export function validateManifest(manifest) {
  const allowed = ['gameId', 'language', 'targetAdsetId', 'referenceAdId', 'newAdName', 'reviewedSourceHash', 'assets'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some((key) => !allowed.includes(key))) throw new Error('Manifest contains unsupported fields. Existing ad IDs must never be supplied as output IDs.');
  if (manifest.gameId !== 'rabbit-hole' || !['EN','KO','JA','DE','FR','ES','PT','ID','TH','ZH-CN','ZH-TW'].includes(manifest.language)) throw new Error('Unsupported game or language.');
  for (const field of ['targetAdsetId', 'referenceAdId']) if (typeof manifest[field] !== 'string' || !/^\d{5,30}$/.test(manifest[field])) throw new Error(`${field} must be a string of digits.`);
  if (typeof manifest.newAdName !== 'string' || manifest.newAdName.length > 160 || !/^[\p{L}\p{N}][\p{L}\p{N}_.()\- ]+$/u.test(manifest.newAdName)) throw new Error('Invalid newAdName.');
  if (typeof manifest.reviewedSourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.reviewedSourceHash)) throw new Error('Run preview, review its targeting/copy/links, and put the approved hash in reviewedSourceHash.');
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 3 || RATIOS.some((ratio) => manifest.assets.filter((asset) => asset?.ratio === ratio).length !== 1)) throw new Error('Exactly one MP4 per ratio is required: 9x16, 1x1, 16x9.');
  for (const asset of manifest.assets) if (Object.keys(asset).some((key) => !['ratio','path'].includes(key)) || typeof asset.path !== 'string' || !asset.path || !asset.path.toLowerCase().endsWith('.mp4')) throw new Error('Each asset must contain only ratio and path to an MP4.');
  return manifest;
}

export function createApi({ token, origin = ORIGIN, fetcher = fetch }) {
  if (!TOKEN_RE.test(token)) throw new Error('No valid personal API token. Run login in your terminal.');
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

export async function saveToken(token, configDir = CONFIG_DIR) {
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
    await file.writeFile(JSON.stringify({ token, origin: ORIGIN }) + '\n');
    await file.close();
    await rename(temporary, join(configDir, 'credentials.json'));
  } catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
}

export async function loadToken(origin, { env = process.env, configDir = CONFIG_DIR } = {}) {
  if (env.RH_META_TOKEN) return env.RH_META_TOKEN;
  if (origin !== ORIGIN) throw new Error('Development requires a separate RH_META_TOKEN; saved production credentials are not used.');
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
    if (data.origin !== ORIGIN || !TOKEN_RE.test(data.token)) throw Object.assign(new Error('Credential origin or token mismatch.'), { code: 'CREDENTIAL_INVALID' });
    return data.token;
  } catch (error) {
    const code = error.code === 'ENOENT' ? 'CREDENTIAL_MISSING' : error.code === 'CREDENTIAL_UNSAFE' || error.code === 'EACCES' || error.code === 'EPERM' ? 'CREDENTIAL_UNSAFE' : 'CREDENTIAL_INVALID';
    throw Object.assign(new Error('No safe saved login. Run login in your terminal.'), { code });
  }
}

async function readManifestFiles(manifestPath) {
  let parsed;
  const source = await readFile(manifestPath, 'utf8');
  try { parsed = JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch { throw Object.assign(new Error('Manifest must be valid UTF-8 JSON.'), { code: 'MANIFEST_JSON_INVALID' }); }
  const manifest = validateManifest(parsed);
  const files = [];
  for (const asset of manifest.assets) {
    const path = resolve(dirname(resolve(manifestPath)), asset.path);
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 12 || info.size > 512 * 1024 * 1024) throw new Error(`${asset.ratio}: file must be a regular MP4 between 12 bytes and 512 MiB.`);
      const header = Buffer.alloc(12); await file.read(header, 0, 12, 0);
      if (header.toString('ascii', 4, 8) !== 'ftyp') throw new Error(`${asset.ratio}: MP4 signature missing.`);
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
      files.push({ ratio: asset.ratio, path, originalName: basename(path), bytes: info.size, contentType: 'video/mp4', sha256: hash.digest('hex'), mtimeMs: info.mtimeMs });
    } finally { await file.close(); }
  }
  return { manifest, files };
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
export async function doctor({ env = process.env, configDir = CONFIG_DIR, nodeVersion = process.versions.node, fetcher = globalThis.fetch } = {}) {
  const supported = Number(nodeVersion.split('.')[0]) >= 22;
  const result = { ok: false, command: 'doctor', runtime: { node: nodeVersion, minimumMajor: 22, supported }, credential: { source: env.RH_META_TOKEN ? 'environment' : 'saved', status: 'not_checked' }, connection: { status: 'not_checked' }, nextAction: '' };
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
    return { ...result, credential: { ...result.credential, status }, nextAction: status === 'unsafe_permissions' ? 'Use a local NTFS profile on Windows and run login yourself to restore owner-only permissions.' : status === 'development_token_required' ? 'Use a separate development token in a private process environment. Saved production credentials are not used.' : 'Create a personal token in Workbench > Claude Code connection and run login yourself in an interactive terminal.' };
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
  const nextAction = status === 'connected' ? 'Connection is ready. Run check-manifest before prepare; reuse resume for an existing unsubmitted draft.' : status === 'unauthorized' ? 'Create a new personal token in the browser and run login yourself. The server cannot distinguish expired, revoked and invalid tokens here.' : ['access_redirect', 'access_html'].includes(status) ? 'Ask the workbench administrator to check Access configuration for /agent/v1/* only. Keep browser authentication enabled.' : status === 'rate_limited' ? 'Wait before rerunning doctor. No automatic retry was performed.' : status === 'forbidden' ? 'Ask the administrator to verify your allowed account and API permissions. Do not use management credentials.' : 'Check service availability with the administrator. Do not retry prepare or submit blindly.';
  return { ...result, ok: status === 'connected', connection: { status, httpStatus }, nextAction };
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
    const file = await open(asset.path, 'r');
    try {
      const info = await file.stat();
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

export const HELP = `Rabbit Hole Meta Ads — Node.js 22+ / Windows PowerShell, macOS
Usage: node rh-meta.mjs COMMAND [options]
  login                         Paste personal token privately in an interactive terminal
  logout                        Remove local login (revoke in Workbench for full revocation)
  doctor                        Diagnose runtime, private login and API access as safe JSON
  check-manifest FILE.json      Local-only schema/file/hash check; no login or upload
  whoami                        Show authenticated identity
  adsets [--after CURSOR]        List allowed account ad sets
  ads --adset ID [--after CURSOR] List reference ads in one ad set
  preview --adset ID --ad ID     Review inherited settings; copy approved hash into manifest
  prepare manifest.json         Hash and upload 3 MP4s; create draft only, NEVER submit
  resume OPERATION_ID --manifest FILE.json  Resume the SAME draft after checking hashes
  submit OPERATION_ID --confirm-new-paused  Explicitly create a NEW PAUSED ad
  recheck-paused OPERATION_ID   Recheck a confirmed PAUSED ad after AD_PAUSED_TIMEOUT
  status OPERATION_ID            State, receipts, errors and preview results
  wait OPERATION_ID [--interval 10] [--timeout 600]  Poll until terminal state
  list [--query TEXT] [--state STATE] [--before UUID] [--limit 40]  History
  lineage OPERATION_ID          Check live identity against recorded IDs/names
  export OPERATION_ID --output FILE.json  Save receipt (refuses overwrite)
  download OPERATION_ID --ratio 9x16 --output FILE.mp4  Save source (refuses overwrite)
  --help                        This help

Get a 7-day personal API token from Workbench > Personal API access. Maximum 30 days.
Run login YOURSELF, not in Claude chat. Do not put credentials in manifests, prompts, Git,
screenshots or command-line arguments. Saved locally outside the repo with owner-only
permissions, not encrypted. Windows ACL requires NTFS and your current user account.
RH_META_TOKEN is optional for an existing private process environment; never echo it.
Production host is fixed. RH_META_DEV_ORIGIN allows loopback only, separate env token required.
All normal results are JSON on stdout; errors/progress on stderr. Failures exit nonzero.
No automatic POST retry. On unknown results inspect list/status; never duplicate writes.
prepare resolves asset paths relative to manifest (Windows paths accepted on Windows).
The reference ad is read-only. No activation, budget change, rename or existing-ID overwrite.
Download/export refuse symlinks and existing output files. Review in Ads Manager before activation.
`;

export async function main(args = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(args);
  const [command, id] = positional;
  if (!command || command === 'help' || flags['--help']) { process.stdout.write(HELP); return; }
  if (positional.length > 2) throw new Error('Too many arguments.');
  const specs = { doctor: [0, []], 'check-manifest': [1, []], login: [0, []], logout: [0, []], whoami: [0, []], adsets: [0, ['--after']], ads: [0, ['--adset','--after']], preview: [0, ['--adset','--ad']], prepare: [1, []], resume: [1, ['--manifest']], wait: [1, ['--interval','--timeout']], submit: [1, ['--confirm-new-paused']], 'recheck-paused': [1, []], status: [1, []], list: [0, ['--query','--state','--before','--limit']], lineage: [1, []], export: [1, ['--output']], download: [1, ['--output','--ratio']] };
  const spec = specs[command];
  if (!spec || positional.length !== spec[0] + 1 || Object.keys(flags).some((flag) => !spec[1].includes(flag))) throw new Error('Invalid command arguments. Use --help.');
  if (command === 'doctor') { const result = await doctor(); if (!result.ok) process.exitCode = 1; return result; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
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
  if (['submit','recheck-paused','resume','wait','status','lineage','export','download'].includes(command) && !UUID_RE.test(id || '')) throw new Error('A valid operation UUID is required.');
  if (['ads','preview'].includes(command) && !/^\d{5,30}$/.test(flags['--adset'] || '')) throw new Error('--adset must be a Meta numeric ID.');
  if (command === 'preview' && !/^\d{5,30}$/.test(flags['--ad'] || '')) throw new Error('--ad must be a Meta numeric ID.');
  if (command === 'submit' && !flags['--confirm-new-paused']) throw new Error('Submission requires --confirm-new-paused. Obtain marketer approval before this command.');
  if (['export','download'].includes(command) && !flags['--output']) throw new Error('--output is required.');
  if (command === 'download' && !RATIOS.includes(flags['--ratio'])) throw new Error('--ratio must be 9x16, 1x1 or 16x9.');
  if (command === 'resume' && !flags['--manifest']) throw new Error('--manifest is required to verify the original files.');
  if (command === 'list' && flags['--before'] && !UUID_RE.test(flags['--before'])) throw new Error('--before must be an operation UUID.');
  if (command === 'list' && flags['--limit'] && (!Number.isInteger(Number(flags['--limit'])) || Number(flags['--limit']) < 1 || Number(flags['--limit']) > 100)) throw new Error('--limit must be 1–100.');
  const api = createApi({ token: await loadToken(origin), origin });
  const cursor = flags['--after'] ? `&after=${encodeURIComponent(flags['--after'])}` : '';
  switch (command) {
    case 'whoami': return api('/me');
    case 'adsets': return api(`/catalog/adsets?${cursor.slice(1)}`);
    case 'ads': return api(`/catalog/ads?adsetId=${flags['--adset']}${cursor}`);
    case 'preview': return api(`/source-preview?adsetId=${flags['--adset']}&adId=${flags['--ad']}`);
    case 'prepare': return prepare(resolve(id), api);
    case 'resume': return resume(id, resolve(flags['--manifest']), api);
    case 'wait': {
      const result = await waitForOperation(id, api, { interval: Number(flags['--interval'] || 10), timeout: Number(flags['--timeout'] || 600) });
      if (result.operation.state !== 'AWAITING_MARKETER_REVIEW') process.exitCode = 1;
      return result;
    }
    case 'recheck-paused': return api(`/operations/${id}/recheck-paused`, { method: 'POST', body: {} });
    case 'submit': return api(`/operations/${id}/submit`, { method: 'POST', body: {} });
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
