// Persistence layer (dependency-free, just fs).
//
// Data is split into two concerns kept in DATA_DIR:
//   - config.json          durable user config only:
//                          { endpoints: [{ id, label, publicName, url, addedAt,
//                            notes, pwLink, repoType, hosting, showInApp,
//                            showInBrowserPlugin }] }
//                          written only on add / delete / edit; the previous
//                          version is copied to backups/ first (last 10 kept).
//   - fetches/<id>.json    the latest fetch result per endpoint:
//                          { lastSync, lastStatus, error, lastError, failCount,
//                            version, renderservice, rs2, services,
//                            features, plugins, raw }
//                          written on every fetch, independently per endpoint.
//   - audits/<uuid>.json   one security-patch audit round each (see audits.js);
//                          previous version backed up like config.json.
//
// This keeps the (potentially large) raw `_about` blobs out of the config and
// avoids rewriting every endpoint's data on each refresh.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const FETCH_DIR = path.join(DATA_DIR, 'fetches');
// Rolling copies of config.json taken before every change to it.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 10;
// Patch-audit rounds, one JSON file per round: audits/<uuid>.json.
const AUDIT_DIR = path.join(DATA_DIR, 'audits');
// IP-range -> tag mappings for automatic network/organisation tagging.
const IP_RANGES_PATH = process.env.IP_RANGES_FILE || path.join(DATA_DIR, 'ip-ranges.conf');

const EMPTY = { endpoints: [] };

// Durable config fields kept in config.json.
const CONFIG_FIELDS = [
  'id',
  'label',
  'publicName',
  'url',
  'addedAt',
  'notes',
  'pwLink',
  'repoType',
  'hosting',
  'showInApp',
  'showInBrowserPlugin',
];
// Volatile fetch fields kept in fetches/<id>.json.
const FETCH_FIELDS = [
  'lastSync',
  'lastStatus',
  'error',
  'lastError',
  'failCount',
  'version',
  'renderservice',
  'rs2',
  'services',
  'features',
  'plugins',
  'repositories',
  'resolvedIp',
  'networkTags',
  'raw',
];

export function getConfigPath() {
  return CONFIG_PATH;
}

export function getFetchDir() {
  return FETCH_DIR;
}

export function getBackupDir() {
  return BACKUP_DIR;
}

export function getIpRangesPath() {
  return IP_RANGES_PATH;
}

// The state a never-fetched endpoint reports.
export function defaultFetch() {
  return {
    lastSync: null,
    lastStatus: 'pending',
    error: null,
    lastError: null,
    failCount: 0,
    version: null,
    renderservice: null,
    rs2: false,
    services: [],
    features: null,
    plugins: null,
    repositories: [],
    resolvedIp: null,
    networkTags: [],
    raw: null,
  };
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (obj[f] !== undefined) out[f] = obj[f];
  }
  return out;
}

// Visibility flags for the public instance list default to false (opt-in).
function pickConfig(ep) {
  return {
    ...pick(ep, CONFIG_FIELDS),
    addedAt: ep.addedAt || null,
    showInApp: ep.showInApp === true,
    showInBrowserPlugin: ep.showInBrowserPlugin === true,
  };
}

function fetchPathFor(id) {
  return path.join(FETCH_DIR, encodeURIComponent(id) + '.json');
}

// Atomic write: temp file in the same dir, then rename.
async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// ---------- config (durable) ----------

export async function loadConfig() {
  const parsed = await readJson(CONFIG_PATH);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.endpoints)) {
    return structuredClone(EMPTY);
  }
  // Return only durable fields, even if older data still carries fetch fields.
  return { endpoints: parsed.endpoints.map(pickConfig) };
}

export async function saveConfig(config) {
  const clean = { endpoints: (config.endpoints || []).map(pickConfig) };
  const text = JSON.stringify(clean, null, 2);
  await backupConfig(text);
  await atomicWrite(CONFIG_PATH, text);
}

// Copy the current config.json to backups/config-<timestamp>.json before it is
// overwritten, then keep only the newest BACKUP_KEEP copies. Skipped when there
// is no config yet or the content would not change (e.g. the startup rewrite).
async function backupConfig(nextText) {
  await backupFile(CONFIG_PATH, 'config-', nextText);
}

// Generic rolling backup: copy `file` to backups/<prefix><timestamp>.json unless
// it doesn't exist yet or is unchanged; keep the newest BACKUP_KEEP per prefix.
async function backupFile(file, prefix, nextText) {
  let current;
  try {
    current = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (current === nextText) return;

  await fs.mkdir(BACKUP_DIR, { recursive: true });
  // ISO timestamp + zero-padded counter (for same-ms collisions) keeps the
  // names sorting chronologically: <prefix><iso>-000.json, -001, ...
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let n = 0; ; n++) {
    const target = path.join(BACKUP_DIR, `${prefix}${stamp}-${String(n).padStart(3, '0')}.json`);
    try {
      await fs.writeFile(target, current, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  // Only names that are <prefix> + timestamp; "config-" must not match
  // audit backups and vice versa.
  const backups = (await fs.readdir(BACKUP_DIR))
    .filter((f) => f.startsWith(prefix) && /^\d{4}-/.test(f.slice(prefix.length)) && f.endsWith('.json'))
    .sort();
  for (const old of backups.slice(0, -BACKUP_KEEP)) {
    await fs.unlink(path.join(BACKUP_DIR, old)).catch(() => {});
  }
}

// ---------- patch audits (one file per round) ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getAuditDir() {
  return AUDIT_DIR;
}

function auditPathFor(id) {
  if (!UUID_RE.test(String(id))) return null; // ids are UUIDs; never build paths from junk
  return path.join(AUDIT_DIR, String(id).toLowerCase() + '.json');
}

export async function loadAudit(id) {
  const file = auditPathFor(id);
  return file ? readJson(file) : null;
}

export async function loadAudits() {
  let files = [];
  try {
    files = await fs.readdir(AUDIT_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const a = await loadAudit(f.slice(0, -'.json'.length));
    if (a) out.push(a);
  }
  return out;
}

// Atomic write with a rolling backup of the previous version of this round.
export async function saveAudit(audit) {
  const file = auditPathFor(audit.id);
  if (!file) throw new Error('Invalid audit id');
  const text = JSON.stringify(audit, null, 2);
  await backupFile(file, `audit-${audit.id.toLowerCase()}-`, text);
  await atomicWrite(file, text);
}

// ---------- fetch results (per endpoint) ----------

export async function loadFetch(id) {
  return readJson(fetchPathFor(id));
}

export async function saveFetch(id, data) {
  await atomicWrite(fetchPathFor(id), JSON.stringify(pick(data, FETCH_FIELDS), null, 2));
}

export async function deleteFetch(id) {
  try {
    await fs.unlink(fetchPathFor(id));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// ---------- merged views (config + fetch) ----------

export async function loadMerged() {
  const { endpoints } = await loadConfig();
  const out = [];
  for (const cfg of endpoints) {
    const f = (await loadFetch(cfg.id)) || defaultFetch();
    out.push({ ...cfg, ...f });
  }
  return out;
}

export async function loadMergedOne(id) {
  const { endpoints } = await loadConfig();
  const cfg = endpoints.find((e) => e.id === id);
  if (!cfg) return null;
  const f = (await loadFetch(id)) || defaultFetch();
  return { ...cfg, ...f };
}

// ---------- startup: migrate + ensure + cleanup ----------

// Split a legacy single-file config (endpoints carrying fetch fields) into the
// config/fetches layout, ensure files exist, and drop orphaned fetch files.
export async function ensureConfig() {
  await fs.mkdir(FETCH_DIR, { recursive: true });

  const parsed = (await readJson(CONFIG_PATH)) || structuredClone(EMPTY);
  const endpoints = Array.isArray(parsed.endpoints) ? parsed.endpoints : [];

  for (const ep of endpoints) {
    if (!ep || !ep.id) continue;
    const carriesFetch = FETCH_FIELDS.some((f) => ep[f] !== undefined);
    const fetchExists = (await loadFetch(ep.id)) !== null;
    // Migrate embedded fetch data only if we don't already have a fetch file.
    if (carriesFetch && !fetchExists) {
      await saveFetch(ep.id, { ...defaultFetch(), ...pick(ep, FETCH_FIELDS) });
    }
  }

  // Rewrite config.json stripped to durable fields.
  await saveConfig({ endpoints });

  // Remove fetch files with no matching endpoint.
  const keep = new Set(endpoints.map((e) => e && e.id).filter(Boolean));
  let files = [];
  try {
    files = await fs.readdir(FETCH_DIR);
  } catch {
    /* dir just created, ignore */
  }
  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
    const id = decodeURIComponent(file.slice(0, -'.json'.length));
    if (!keep.has(id)) await deleteFetch(id);
  }

  return loadConfig();
}
