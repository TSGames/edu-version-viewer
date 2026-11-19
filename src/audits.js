// Security-patch audit rounds ("Patch-Runden").
//
// The `_about` endpoint only reports a base version (major.minor), never the
// patch level, so a round is defined by the affected base versions and every
// instance's patch state is maintained manually by an admin. The only automatic
// changes are bookkeeping:
//   - instances that (newly) run an affected base version are added as `open`;
//   - an `open` instance that moved to a non-affected base version is marked
//     `not-affected` (by "system", with a note);
//   - a deleted endpoint keeps its entry (snapshot) and is flagged `removed`.
// Nothing is ever set to `patched` automatically. Closed rounds are frozen.
//
// File shape (audits/<uuid>.json):
// {
//   id, title, description, link, dueDate ('YYYY-MM-DD' | ''),
//   notes (free text: new minimum version, git commits / MR links, …),
//   affected: ['10.0', '9.1', 'unknown'], repoTypes: [] (empty = all),
//   scope filters (all optional, empty = no restriction, see inScope()):
//     excludeHosting: ['external', 'unset'], includeTags: [], excludeTags: [],
//     components: ['rs2', 'renderservice', 'feature:<id>', 'plugin:<id>'],
//     minVersion: '', fixedVersion: '',
//   status: 'open' | 'closed', createdAt, createdBy, updatedAt,
//   closedAt, closedBy, closeNote,
//   history: [{ at, by, action, note }],
//   entries: { <endpointId>: { label, url, version, repoType, hosting, status, comment,
//              addedAt, updatedAt, updatedBy, removed, openAtClose,
//              log: [{ at, by, status, comment }] } }
// }
import crypto from 'node:crypto';

import { loadAudit, loadAudits, saveAudit, loadMerged } from './store.js';
import { minorOf, versionKey, compareKeys } from './version.js';

export const ENTRY_STATUSES = ['open', 'patched', 'accepted', 'not-affected'];
const REPO_TYPES = ['dev', 'staging', 'prod'];
// Hosting values a round can exclude; 'unset' = endpoint without a hosting.
const HOSTING_EXCLUDES = ['cluster', 'docker', 'external', 'unset'];
const COMPONENT_RE = /^(rs2|renderservice|(feature|plugin):[^\s]{1,200})$/;
const LIST_MAX = 200;
const BASE_VERSION_RE = /^\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYSTEM = 'system';
const LOG_KEEP = 50; // per-entry change log cap
const NOTES_MAX = 20000; // round notes (Vermerke)

export class AuditError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

// ---------- per-round lock (cron sync vs. admin edits) ----------

const locks = new Map();
async function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  const chained = prev.then(() => next);
  locks.set(id, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === chained) locks.delete(id);
  }
}

// ---------- validation ----------

function str(v, max = 5000) {
  return v == null ? '' : String(v).trim().slice(0, max);
}

function normalizeAffected(list) {
  if (!Array.isArray(list)) throw new AuditError(400, 'affected must be a list');
  const out = [];
  for (const raw of list) {
    const v = String(raw).trim();
    if (v === 'unknown') {
      if (!out.includes(v)) out.push(v);
      continue;
    }
    // Accept "10", "10.0", "10.0.3" -> base version "10.0".
    const m = minorOf(v);
    if (!m || !/^\d+(\.\d+)*$/.test(v)) throw new AuditError(400, 'Invalid version: ' + v);
    if (!out.includes(m)) out.push(m);
  }
  if (out.length === 0) throw new AuditError(400, 'At least one affected version is required');
  return out;
}

function normalizeRepoTypes(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new AuditError(400, 'repoTypes must be a list');
  for (const t of list) {
    if (!REPO_TYPES.includes(t)) throw new AuditError(400, 'Invalid repoType: ' + t);
  }
  return [...new Set(list)];
}

// Generic list validator: dedupes, trims, enforces a pattern / allow-list.
function normalizeList(list, name, check) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new AuditError(400, name + ' must be a list');
  if (list.length > LIST_MAX) throw new AuditError(400, name + ': too many entries');
  const out = [];
  for (const raw of list) {
    const v = String(raw).trim();
    if (!check(v)) throw new AuditError(400, `Invalid ${name}: ${v}`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

const SCOPE_LISTS = {
  excludeHosting: (v) => HOSTING_EXCLUDES.includes(v),
  includeTags: (v) => v.length > 0 && v.length <= 100,
  excludeTags: (v) => v.length > 0 && v.length <= 100,
  components: (v) => COMPONENT_RE.test(v),
};

// Optional full version bound ('' = none), e.g. "10.0.4".
function normalizeVersionBound(v, name) {
  const s = str(v, 50);
  if (s === '') return '';
  if (!/^\d+(\.\d+)*$/.test(s)) throw new AuditError(400, 'Invalid ' + name);
  return s;
}

// Validate and apply every scope field present in `payload` onto `target`.
// Returns the names of the fields that were set.
function applyScope(target, payload, { all = false } = {}) {
  const set = [];
  for (const [k, check] of Object.entries(SCOPE_LISTS)) {
    if (all || payload[k] !== undefined) {
      target[k] = normalizeList(payload[k], k, check);
      set.push(k);
    }
  }
  for (const k of ['minVersion', 'fixedVersion']) {
    if (all || payload[k] !== undefined) {
      target[k] = normalizeVersionBound(payload[k], k);
      set.push(k);
    }
  }
  if (target.minVersion && target.fixedVersion) {
    const lo = versionKey(target.minVersion);
    const hi = versionKey(target.fixedVersion);
    if (compareKeys(lo, hi) >= 0) throw new AuditError(400, 'minVersion must be below fixedVersion');
  }
  return set;
}

function normalizeDate(v) {
  const s = str(v, 20);
  if (s === '') return '';
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) throw new AuditError(400, 'Invalid dueDate');
  return s;
}

function normalizeLink(v) {
  const s = str(v, 2000);
  if (s === '') return '';
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s);
  } catch {
    throw new AuditError(400, 'Invalid link');
  }
  if (!/^https?:$/.test(url.protocol)) throw new AuditError(400, 'Only http(s) links are supported');
  return url.toString();
}

// ---------- scope / sync ----------

// Ids of features / plugins as reported by _about (arrays of {id} objects or
// strings; an object map falls back to its keys).
function idsOf(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (v && typeof v === 'object' ? (v.id != null ? v.id : v.name) : v))
      .filter((v) => v != null)
      .map(String);
  }
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

function hasComponent(ep, c) {
  if (c === 'rs2') return ep.rs2 === true;
  if (c === 'renderservice') return ep.renderservice != null && ep.renderservice !== '';
  if (c.startsWith('feature:')) return idsOf(ep.features).includes(c.slice(8));
  if (c.startsWith('plugin:')) return idsOf(ep.plugins).includes(c.slice(7));
  return false;
}

// Decide whether `ep` belongs to the round. Returns { in, reason, sure } where
// `reason` (German) explains an exclusion and `sure` is false when the
// exclusion only stems from an unknown version (then an open entry is kept). Safety rule: a filter only excludes
// on known data — an attribute that is unknown (never fetched, DNS failed,
// version without the needed precision) keeps the instance in scope. The one
// exception is the pre-existing repoTypes allow-list, which requires a match.
export function inScope(audit, ep) {
  const out = (reason, sure = true) => ({ in: false, reason, sure });
  const ids = (k) => audit[k] || [];

  if (audit.repoTypes && audit.repoTypes.length && !audit.repoTypes.includes(ep.repoType)) {
    return out('Typ nicht im Umfang');
  }
  const hosting = ep.hosting || 'unset';
  if (ids('excludeHosting').includes(hosting)) return out('Hosting ausgeschlossen');

  // Network tags are only known once the host resolved to an IP.
  if (ep.resolvedIp) {
    const tags = Array.isArray(ep.networkTags) ? ep.networkTags : [];
    if (ids('excludeTags').some((t) => tags.includes(t))) return out('Netz-Tag ausgeschlossen');
    if (ids('includeTags').length && !ids('includeTags').some((t) => tags.includes(t))) {
      return out('kein passender Netz-Tag');
    }
  }

  // Components are only known after a successful _about fetch.
  if (ids('components').length && ep.raw != null && !ids('components').some((c) => hasComponent(ep, c))) {
    return out('betroffene Komponente nicht vorhanden');
  }

  const base = minorOf(ep.version);
  if (base == null) return audit.affected.includes('unknown') ? { in: true, reason: '' } : out('Version unbekannt', false);
  if (!audit.affected.includes(base)) return out('Basisversion nicht betroffen');

  // Optional full-version range. Only applies when the reported version is at
  // least as precise as the bound (a bare "10.0" can't prove "10.0.4" or later).
  const kv = versionKey(ep.version);
  if (audit.minVersion) {
    const km = versionKey(audit.minVersion);
    if (kv.length >= km.length && compareKeys(kv, km) < 0) return out('Version unterhalb des betroffenen Bereichs');
  }
  if (audit.fixedVersion) {
    const kf = versionKey(audit.fixedVersion);
    if (kv.length >= kf.length && compareKeys(kv, kf) >= 0) return out('Version enthält den Fix');
  }
  return { in: true, reason: '' };
}

function pushLog(entry, at, by, status, comment) {
  entry.log = entry.log || [];
  entry.log.push({ at, by, status, comment });
  if (entry.log.length > LOG_KEEP) entry.log = entry.log.slice(-LOG_KEEP);
}

// Bring an open round's entries in line with the current endpoints. Mutates
// `audit`; returns true when anything changed. Closed rounds are never touched.
export function syncAudit(audit, endpoints, now = new Date().toISOString()) {
  if (audit.status !== 'open') return false;
  audit.entries = audit.entries || {};
  let changed = false;
  const seen = new Set();

  for (const ep of endpoints) {
    seen.add(ep.id);
    const entry = audit.entries[ep.id];
    const scope = inScope(audit, ep);
    const affected = scope.in;

    if (!entry) {
      if (!affected) continue;
      audit.entries[ep.id] = {
        label: ep.label || '',
        url: ep.url || '',
        version: ep.version || null,
        repoType: ep.repoType || '',
        hosting: ep.hosting || '',
        status: 'open',
        comment: '',
        addedAt: now,
        updatedAt: null,
        updatedBy: null,
        removed: false,
        log: [{ at: now, by: SYSTEM, status: 'open', comment: 'in Runde aufgenommen' }],
      };
      changed = true;
      continue;
    }

    // Keep the snapshot current (it is what survives an endpoint deletion).
    const prevVersion = entry.version;
    for (const [k, v] of [
      ['label', ep.label || ''],
      ['url', ep.url || ''],
      ['repoType', ep.repoType || ''],
      ['hosting', ep.hosting || ''],
    ]) {
      if (entry[k] !== v) {
        entry[k] = v;
        changed = true;
      }
    }
    if (ep.version && entry.version !== ep.version) {
      entry.version = ep.version;
      changed = true;
    }
    if (entry.removed) {
      entry.removed = false;
      changed = true;
    }

    if (entry.status === 'open' && !affected && scope.sure) {
      const upgraded = prevVersion && ep.version !== prevVersion;
      const note = upgraded
        ? `automatisch: Upgrade ${prevVersion} → ${ep.version} erkannt (${scope.reason})`
        : `automatisch: außerhalb des Umfangs (${scope.reason})`;
      entry.status = 'not-affected';
      entry.comment = entry.comment || note;
      entry.updatedAt = now;
      entry.updatedBy = SYSTEM;
      pushLog(entry, now, SYSTEM, 'not-affected', note);
      changed = true;
    } else if (entry.status === 'not-affected' && entry.updatedBy === SYSTEM && affected) {
      // Auto-marked earlier but back on an affected version (e.g. downgrade).
      const note = `automatisch: wieder im Umfang (Version ${ep.version || 'unbekannt'})`;
      entry.status = 'open';
      entry.updatedAt = now;
      pushLog(entry, now, SYSTEM, 'open', note);
      changed = true;
    }
  }

  for (const [id, entry] of Object.entries(audit.entries)) {
    if (!seen.has(id) && !entry.removed) {
      entry.removed = true;
      pushLog(entry, now, SYSTEM, entry.status, 'Instanz gelöscht');
      changed = true;
    }
  }
  if (changed) audit.updatedAt = now;
  return changed;
}

async function syncAndSave(audit, endpoints) {
  if (syncAudit(audit, endpoints)) await saveAudit(audit);
  return audit;
}

// Sync every open round against the current endpoints (called after a refresh).
export async function syncAllAudits(endpoints) {
  const eps = endpoints || (await loadMerged());
  for (const a of await loadAudits()) {
    if (a.status !== 'open') continue;
    await withLock(a.id, async () => {
      const fresh = await loadAudit(a.id);
      if (fresh) await syncAndSave(fresh, eps);
    });
  }
}

// ---------- read views ----------

export function countsOf(audit) {
  const c = { open: 0, patched: 0, accepted: 0, 'not-affected': 0, total: 0 };
  for (const e of Object.values(audit.entries || {})) {
    if (e.removed) continue;
    c[e.status] = (c[e.status] || 0) + 1;
    c.total++;
  }
  return c;
}

// Light view for lists and badges: header, counts and a per-endpoint status map.
export function summaryOf(audit) {
  const { entries, history, ...head } = audit;
  const statusById = {};
  for (const [id, e] of Object.entries(entries || {})) {
    if (!e.removed) statusById[id] = e.status;
  }
  return { ...head, counts: countsOf(audit), statusById };
}

export async function listAudits() {
  const eps = await loadMerged();
  const out = [];
  for (const a of await loadAudits()) {
    const synced = await withLock(a.id, async () => {
      const fresh = await loadAudit(a.id);
      return fresh ? syncAndSave(fresh, eps) : null;
    });
    if (synced) out.push(summaryOf(synced));
  }
  // Open first, then newest first.
  out.sort(
    (x, y) =>
      (x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1) ||
      String(y.createdAt).localeCompare(String(x.createdAt))
  );
  return out;
}

export async function getAudit(id) {
  return withLock(id, async () => {
    const a = await loadAudit(id);
    if (!a) return null;
    await syncAndSave(a, await loadMerged());
    return { ...a, counts: countsOf(a) };
  });
}

// ---------- mutations ----------

export async function createAudit(payload, by) {
  const title = str(payload.title, 300);
  if (!title) throw new AuditError(400, 'title is required');
  const now = new Date().toISOString();
  const audit = {
    id: crypto.randomUUID(),
    title,
    description: str(payload.description),
    notes: str(payload.notes, NOTES_MAX),
    link: normalizeLink(payload.link),
    dueDate: normalizeDate(payload.dueDate),
    affected: normalizeAffected(payload.affected),
    repoTypes: normalizeRepoTypes(payload.repoTypes),
    status: 'open',
    createdAt: now,
    createdBy: by,
    updatedAt: now,
    closedAt: null,
    closedBy: null,
    closeNote: '',
    history: [{ at: now, by, action: 'created', note: '' }],
    entries: {},
  };
  applyScope(audit, payload, { all: true });
  syncAudit(audit, await loadMerged(), now);
  await saveAudit(audit);
  return { ...audit, counts: countsOf(audit) };
}

async function mutate(id, fn) {
  return withLock(id, async () => {
    const audit = await loadAudit(id);
    if (!audit) throw new AuditError(404, 'Not found');
    await fn(audit);
    syncAudit(audit, await loadMerged());
    await saveAudit(audit);
    return { ...audit, counts: countsOf(audit) };
  });
}

function requireOpen(audit) {
  if (audit.status !== 'open') throw new AuditError(409, 'Runde ist abgeschlossen');
}

const EDITABLE_FIELDS = [
  'title', 'description', 'notes', 'link', 'dueDate', 'affected', 'repoTypes',
  ...Object.keys(SCOPE_LISTS), 'minVersion', 'fixedVersion',
];

export function updateAudit(id, payload, by) {
  return mutate(id, (a) => {
    requireOpen(a);
    const prev = Object.fromEntries(EDITABLE_FIELDS.map((k) => [k, JSON.stringify(a[k] ?? null)]));
    if (payload.title !== undefined) {
      const t = str(payload.title, 300);
      if (!t) throw new AuditError(400, 'title is required');
      a.title = t;
    }
    if (payload.description !== undefined) a.description = str(payload.description);
    if (payload.notes !== undefined) a.notes = str(payload.notes, NOTES_MAX);
    if (payload.link !== undefined) a.link = normalizeLink(payload.link);
    if (payload.dueDate !== undefined) a.dueDate = normalizeDate(payload.dueDate);
    if (payload.affected !== undefined) a.affected = normalizeAffected(payload.affected);
    if (payload.repoTypes !== undefined) a.repoTypes = normalizeRepoTypes(payload.repoTypes);
    applyScope(a, payload);
    // History lists only the fields whose value actually changed.
    const changed = EDITABLE_FIELDS.filter((k) => JSON.stringify(a[k] ?? null) !== prev[k]);
    if (!changed.length) return;
    const now = new Date().toISOString();
    a.updatedAt = now;
    a.history.push({ at: now, by, action: 'edited', note: changed.join(', ') });
  });
}

export function setEntry(id, endpointId, payload, by) {
  return mutate(id, (a) => {
    requireOpen(a);
    const entry = a.entries && a.entries[endpointId];
    if (!entry) throw new AuditError(404, 'Instanz ist nicht Teil der Runde');
    const now = new Date().toISOString();
    if (payload.status !== undefined) {
      if (!ENTRY_STATUSES.includes(payload.status)) throw new AuditError(400, 'Invalid status');
      entry.status = payload.status;
    }
    if (payload.comment !== undefined) entry.comment = str(payload.comment, 2000);
    entry.updatedAt = now;
    entry.updatedBy = by;
    pushLog(entry, now, by, entry.status, entry.comment);
  });
}

// Closing requires the exact title as confirmation (the UI's second step);
// enforced here too so a stray API call can't close a round by accident.
export function closeAudit(id, payload, by) {
  return mutate(id, (a) => {
    requireOpen(a);
    if (str(payload.confirmTitle, 300) !== a.title) {
      throw new AuditError(400, 'Bestätigung: Titel stimmt nicht überein');
    }
    const now = new Date().toISOString();
    for (const e of Object.values(a.entries || {})) {
      e.openAtClose = !e.removed && e.status === 'open';
    }
    a.status = 'closed';
    a.closedAt = now;
    a.closedBy = by;
    a.closeNote = str(payload.note, 2000);
    a.updatedAt = now;
    a.history.push({ at: now, by, action: 'closed', note: a.closeNote });
  });
}

// Reopening is a plain action (no confirmation).
export function reopenAudit(id, by) {
  return mutate(id, (a) => {
    if (a.status !== 'closed') throw new AuditError(409, 'Runde ist bereits offen');
    const now = new Date().toISOString();
    for (const e of Object.values(a.entries || {})) delete e.openAtClose;
    a.status = 'open';
    a.closedAt = null;
    a.closedBy = null;
    a.updatedAt = now;
    a.history.push({ at: now, by, action: 'reopened', note: '' });
  });
}

// ---------- export ----------

const STATUS_DE = {
  open: 'offen',
  patched: 'gepatcht',
  accepted: 'akzeptiert',
  'not-affected': 'nicht (mehr) betroffen',
};

const REPO_TYPE_DE = { dev: 'Dev', staging: 'Staging', prod: 'Prod' };
const HOSTING_DE = { cluster: 'K8S', docker: 'Docker', external: 'Extern', unset: 'ohne Angabe' };

function componentDe(c) {
  if (c === 'rs2') return 'RS2';
  if (c === 'renderservice') return 'Rendering-Service';
  if (c.startsWith('feature:')) return 'Feature ' + c.slice(8);
  if (c.startsWith('plugin:')) return 'Plugin ' + c.slice(7);
  return c;
}

// Human-readable (German) description of a round's scope, for export and UI.
export function scopeSummary(a) {
  const parts = [
    'Basisversionen: ' + (a.affected || []).map((v) => (v === 'unknown' ? 'unbekannt' : v)).join(', '),
  ];
  const list = (k) => a[k] || [];
  if (a.minVersion || a.fixedVersion) {
    parts.push(
      'Version: ' + [a.minVersion && 'ab ' + a.minVersion, a.fixedVersion && 'behoben ab ' + a.fixedVersion].filter(Boolean).join(', ')
    );
  }
  if (list('repoTypes').length) parts.push('nur Typ: ' + list('repoTypes').map((t) => REPO_TYPE_DE[t] || t).join(', '));
  if (list('excludeHosting').length) {
    parts.push('ohne Hosting: ' + list('excludeHosting').map((h) => HOSTING_DE[h] || h).join(', '));
  }
  if (list('includeTags').length) parts.push('nur Netz: ' + list('includeTags').join(', '));
  if (list('excludeTags').length) parts.push('ohne Netz: ' + list('excludeTags').join(', '));
  if (list('components').length) parts.push('Komponente: ' + list('components').map(componentDe).join(' oder '));
  return parts.join(' · ');
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Semicolon-separated (German Excel default), with BOM added by the route.
export function auditCsv(audit) {
  const rows = [
    ['Runde', 'Umfang', 'Instanz', 'URL', 'Version', 'Typ', 'Hosting', 'Status', 'Offen bei Abschluss', 'Kommentar', 'Geändert am', 'Geändert von', 'Gelöscht'],
  ];
  const scope = scopeSummary(audit);
  const entries = Object.values(audit.entries || {}).sort((a, b) =>
    String(a.label).localeCompare(String(b.label))
  );
  for (const e of entries) {
    rows.push([
      audit.title,
      scope,
      e.label,
      e.url,
      e.version || 'unbekannt',
      e.repoType || '',
      e.hosting ? HOSTING_DE[e.hosting] || e.hosting : '',
      STATUS_DE[e.status] || e.status,
      e.openAtClose ? 'ja' : '',
      e.comment,
      e.updatedAt || '',
      e.updatedBy || '',
      e.removed ? 'ja' : '',
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
