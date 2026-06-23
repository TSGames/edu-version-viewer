// Persistence layer (dependency-free, just fs).
//
// Data is split into two concerns kept in DATA_DIR:
//   - config.json          durable user config only:
//                          { endpoints: [{ id, label, url, addedAt }] }
//                          written only on add / delete / rename.
//   - fetches/<id>.json    the latest fetch result per endpoint:
//                          { lastSync, lastStatus, error, lastError, failCount,
//                            version, renderservice, rs2, services,
//                            features, plugins, raw }
//                          written on every fetch, independently per endpoint.
//
// This keeps the (potentially large) raw `_about` blobs out of the config and
// avoids rewriting every endpoint's data on each refresh.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const FETCH_DIR = path.join(DATA_DIR, 'fetches');

const EMPTY = { endpoints: [] };

// Durable config fields kept in config.json.
const CONFIG_FIELDS = ['id', 'label', 'url', 'addedAt', 'notes', 'pwLink'];
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
  'raw',
];

export function getConfigPath() {
  return CONFIG_PATH;
}

export function getFetchDir() {
  return FETCH_DIR;
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

function pickConfig(ep) {
  return { ...pick(ep, CONFIG_FIELDS), addedAt: ep.addedAt || null };
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
  await atomicWrite(CONFIG_PATH, JSON.stringify(clean, null, 2));
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
