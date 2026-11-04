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
//   affected: ['10.0', '9.1', 'unknown'], repoTypes: [] (empty = all),
//   status: 'open' | 'closed', createdAt, createdBy, updatedAt,
//   closedAt, closedBy, closeNote,
//   history: [{ at, by, action, note }],
//   entries: { <endpointId>: { label, url, version, repoType, status, comment,
//              addedAt, updatedAt, updatedBy, removed, openAtClose,
//              log: [{ at, by, status, comment }] } }
// }
import crypto from 'node:crypto';

import { loadAudit, loadAudits, saveAudit, loadMerged } from './store.js';
import { minorOf } from './version.js';

export const ENTRY_STATUSES = ['open', 'patched', 'accepted', 'not-affected'];
const REPO_TYPES = ['dev', 'staging', 'prod'];
const BASE_VERSION_RE = /^\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYSTEM = 'system';
const LOG_KEEP = 50; // per-entry change log cap

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

function inScope(audit, ep) {
  if (audit.repoTypes && audit.repoTypes.length && !audit.repoTypes.includes(ep.repoType)) {
    return false;
  }
  const base = minorOf(ep.version);
  if (base == null) return audit.affected.includes('unknown');
  return audit.affected.includes(base);
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
    const affected = inScope(audit, ep);

    if (!entry) {
      if (!affected) continue;
      audit.entries[ep.id] = {
        label: ep.label || '',
        url: ep.url || '',
        version: ep.version || null,
        repoType: ep.repoType || '',
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

    const knownBase = minorOf(ep.version);
    if (entry.status === 'open' && !affected && knownBase != null) {
      const note = `automatisch: Upgrade ${prevVersion || '?'} → ${ep.version} erkannt`;
      entry.status = 'not-affected';
      entry.comment = entry.comment || note;
      entry.updatedAt = now;
      entry.updatedBy = SYSTEM;
      pushLog(entry, now, SYSTEM, 'not-affected', note);
      changed = true;
    } else if (entry.status === 'not-affected' && entry.updatedBy === SYSTEM && affected) {
      // Auto-marked earlier but back on an affected version (e.g. downgrade).
      const note = `automatisch: wieder betroffene Version ${ep.version || 'unbekannt'}`;
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

export function updateAudit(id, payload, by) {
  return mutate(id, (a) => {
    requireOpen(a);
    const changed = [];
    if (payload.title !== undefined) {
      const t = str(payload.title, 300);
      if (!t) throw new AuditError(400, 'title is required');
      a.title = t;
      changed.push('title');
    }
    if (payload.description !== undefined) (a.description = str(payload.description)), changed.push('description');
    if (payload.link !== undefined) (a.link = normalizeLink(payload.link)), changed.push('link');
    if (payload.dueDate !== undefined) (a.dueDate = normalizeDate(payload.dueDate)), changed.push('dueDate');
    if (payload.affected !== undefined) (a.affected = normalizeAffected(payload.affected)), changed.push('affected');
    if (payload.repoTypes !== undefined) (a.repoTypes = normalizeRepoTypes(payload.repoTypes)), changed.push('repoTypes');
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

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Semicolon-separated (German Excel default), with BOM added by the route.
export function auditCsv(audit) {
  const rows = [
    ['Runde', 'Instanz', 'URL', 'Version', 'Typ', 'Status', 'Offen bei Abschluss', 'Kommentar', 'Geändert am', 'Geändert von', 'Gelöscht'],
  ];
  const entries = Object.values(audit.entries || {}).sort((a, b) =>
    String(a.label).localeCompare(String(b.label))
  );
  for (const e of entries) {
    rows.push([
      audit.title,
      e.label,
      e.url,
      e.version || 'unbekannt',
      e.repoType || '',
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
