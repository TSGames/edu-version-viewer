// Patch-audit rounds: auth, manual status, auto bookkeeping, close/reopen,
// per-round JSON file + backups, CSV export. Offline (mock upstream).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'evv-audit-'));
const { buildApp } = await import('../src/app.js');
const { syncAudit, scopeSummary } = await import('../src/audits.js');

const ADMIN = 'Basic ' + Buffer.from('admin:pw').toString('base64');
const VIEWER = 'Basic ' + Buffer.from('viewer:vpw').toString('base64');

// Per-host version served by the mock upstream; mutable to simulate upgrades.
const versions = { a: '10.0', b: '9.1', c: '10.1' };

let app;
let upstream;
let base;

before(async () => {
  upstream = http.createServer((req, res) => {
    const host = req.url.split('/')[1];
    if (req.url.endsWith('/_about') && versions[host]) {
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ version: { repository: versions[host] } }));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${upstream.address().port}`;
  app = await buildApp({
    adminUser: 'admin',
    adminPassword: 'pw',
    viewerUser: 'viewer',
    viewerPassword: 'vpw',
    sessionSecret: 'x'.repeat(32),
  });
  await app.ready();
});
after(async () => {
  await app.close();
  upstream.close();
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const req = (method, url, auth, payload) =>
  app.inject({
    method,
    url,
    headers: {
      ...(auth ? { authorization: auth } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload,
  });

const ids = {};

test('setup: three endpoints on 10.0 / 9.1 / 10.1', async () => {
  for (const [key, label] of [
    ['a', 'Alpha'],
    ['b', 'Beta'],
    ['c', 'Gamma'],
  ]) {
    const res = await req('POST', '/api/endpoints', ADMIN, { url: `${base}/${key}/edu-sharing/rest/_about`, label });
    assert.equal(res.statusCode, 201, res.body);
    ids[key] = res.json().endpoint.id;
  }
  const res = await req('POST', '/api/refresh', ADMIN);
  assert.equal(res.statusCode, 200);
});

test('audits are admin only', async () => {
  assert.equal((await req('GET', '/api/audits')).statusCode, 401);
  assert.equal((await req('GET', '/api/audits', VIEWER)).statusCode, 403);
  assert.equal((await req('POST', '/api/audits', VIEWER, { title: 'x', affected: ['10.0'] })).statusCode, 403);
  assert.equal((await req('GET', '/api/audits', ADMIN)).statusCode, 200);
});

test('create validates input', async () => {
  assert.equal((await req('POST', '/api/audits', ADMIN, { affected: ['10.0'] })).statusCode, 400);
  assert.equal((await req('POST', '/api/audits', ADMIN, { title: 'x', affected: [] })).statusCode, 400);
  assert.equal((await req('POST', '/api/audits', ADMIN, { title: 'x', affected: ['abc'] })).statusCode, 400);
  assert.equal(
    (await req('POST', '/api/audits', ADMIN, { title: 'x', affected: ['10.0'], dueDate: '15.11.2026' })).statusCode,
    400
  );
  assert.equal(
    (await req('POST', '/api/audits', ADMIN, { title: 'x', affected: ['10.0'], repoTypes: ['qa'] })).statusCode,
    400
  );
});

let auditId;

test('create: uuid id, own JSON file, affected base versions become open entries', async () => {
  const res = await req('POST', '/api/audits', ADMIN, {
    title: 'CVE-1',
    description: 'desc',
    link: 'jira.example/SEC-1',
    affected: ['10.0.3', '9.1'], // normalized to base versions
  });
  assert.equal(res.statusCode, 201, res.body);
  const a = res.json().audit;
  auditId = a.id;
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(a.affected, ['10.0', '9.1']);
  assert.equal(a.link, 'https://jira.example/SEC-1');
  assert.equal(a.createdBy, 'admin');
  assert.deepEqual(Object.keys(a.entries).sort(), [ids.a, ids.b].sort());
  assert.equal(a.entries[ids.a].status, 'open');
  assert.deepEqual(a.counts, { open: 2, patched: 0, accepted: 0, 'not-affected': 0, total: 2 });
  assert.ok(existsSync(path.join(process.env.DATA_DIR, 'audits', a.id + '.json')));
});

test('manual status per instance with comment and actor', async () => {
  let res = await req('PATCH', `/api/audits/${auditId}/entries/${ids.a}`, ADMIN, {
    status: 'patched',
    comment: 'sp3 eingespielt',
  });
  assert.equal(res.statusCode, 200, res.body);
  const e = res.json().audit.entries[ids.a];
  assert.equal(e.status, 'patched');
  assert.equal(e.comment, 'sp3 eingespielt');
  assert.equal(e.updatedBy, 'admin');
  assert.equal(e.log.at(-1).status, 'patched');

  res = await req('PATCH', `/api/audits/${auditId}/entries/${ids.a}`, ADMIN, { status: 'done' });
  assert.equal(res.statusCode, 400);
  res = await req('PATCH', `/api/audits/${auditId}/entries/${ids.c}`, ADMIN, { status: 'patched' });
  assert.equal(res.statusCode, 404); // 10.1 is not part of the round
});

test('list returns summaries with counts and status map', async () => {
  const res = await req('GET', '/api/audits', ADMIN);
  const s = res.json().audits.find((x) => x.id === auditId);
  assert.equal(s.id, auditId);
  assert.equal(s.entries, undefined);
  assert.equal(s.statusById[ids.a], 'patched');
  assert.equal(s.counts.open, 1);
});

test('auto: upgrade of an open instance -> not-affected; never auto-patched', async () => {
  versions.b = '10.1';
  await req('POST', '/api/refresh', ADMIN);
  const a = (await req('GET', `/api/audits/${auditId}`, ADMIN)).json().audit;
  assert.equal(a.entries[ids.b].status, 'not-affected');
  assert.equal(a.entries[ids.b].updatedBy, 'system');
  assert.match(a.entries[ids.b].comment, /9\.1 → 10\.1/);
  versions.b = '9.1';
  await req('POST', '/api/refresh', ADMIN);
  const again = (await req('GET', `/api/audits/${auditId}`, ADMIN)).json().audit;
  assert.equal(again.entries[ids.b].status, 'open'); // back on affected version
});

test('auto: newly affected instance is added; edited affected list applies', async () => {
  const res = await req('PATCH', `/api/audits/${auditId}`, ADMIN, { affected: ['10.0', '9.1', '10.1'] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().audit.entries[ids.c].status, 'open');
});

test('round notes (Vermerke): set on create/edit, logged in history', async () => {
  const res = await req('PATCH', `/api/audits/${auditId}`, ADMIN, {
    notes: 'Mindestversion jetzt 10.0-sp3\nhttps://git.example/commit/abc123',
  });
  assert.equal(res.statusCode, 200, res.body);
  const a = res.json().audit;
  assert.match(a.notes, /10\.0-sp3\nhttps:\/\/git\.example/);
  assert.equal(a.history.at(-1).note, 'notes');
  const created = await req('POST', '/api/audits', ADMIN, { title: 'N', affected: ['9.0'], notes: 'x' });
  assert.equal(created.json().audit.notes, 'x');
});

test('close requires matching title; closed round is read-only', async () => {
  let res = await req('POST', `/api/audits/${auditId}/close`, ADMIN, { confirmTitle: 'CVE' });
  assert.equal(res.statusCode, 400);
  res = await req('POST', `/api/audits/${auditId}/close`, ADMIN, { confirmTitle: 'CVE-1', note: 'Rest später' });
  assert.equal(res.statusCode, 200, res.body);
  const a = res.json().audit;
  assert.equal(a.status, 'closed');
  assert.equal(a.closeNote, 'Rest später');
  assert.equal(a.entries[ids.b].openAtClose, true);
  assert.equal(a.entries[ids.a].openAtClose, false);

  assert.equal(
    (await req('PATCH', `/api/audits/${auditId}/entries/${ids.b}`, ADMIN, { status: 'patched' })).statusCode,
    409
  );
  assert.equal((await req('PATCH', `/api/audits/${auditId}`, ADMIN, { title: 'x' })).statusCode, 409);
  assert.equal((await req('POST', `/api/audits/${auditId}/close`, ADMIN, { confirmTitle: 'CVE-1' })).statusCode, 409);

  // Frozen: upgrades no longer change a closed round.
  versions.b = '10.1';
  await req('POST', '/api/refresh', ADMIN);
  const frozen = (await req('GET', `/api/audits/${auditId}`, ADMIN)).json().audit;
  assert.equal(frozen.entries[ids.b].status, 'open');
  versions.b = '9.1';
});

test('reopen without confirmation, then editable again', async () => {
  const res = await req('POST', `/api/audits/${auditId}/reopen`, ADMIN);
  assert.equal(res.statusCode, 200);
  const a = res.json().audit;
  assert.equal(a.status, 'open');
  assert.equal(a.entries[ids.b].openAtClose, undefined);
  assert.deepEqual(
    a.history.map((h) => h.action),
    ['created', 'edited', 'edited', 'closed', 'reopened']
  );
  assert.equal((await req('POST', `/api/audits/${auditId}/reopen`, ADMIN)).statusCode, 409);
});

test('deleted endpoint keeps its snapshot, flagged removed', async () => {
  await req('DELETE', `/api/endpoints/${ids.c}`, ADMIN);
  const a = (await req('GET', `/api/audits/${auditId}`, ADMIN)).json().audit;
  assert.equal(a.entries[ids.c].removed, true);
  assert.equal(a.entries[ids.c].label, 'Gamma');
  assert.equal(a.counts.total, 2);
});

test('CSV export (semicolon, BOM, formula-safe)', async () => {
  await req('PATCH', `/api/audits/${auditId}/entries/${ids.a}`, ADMIN, { comment: '=HYPERLINK("x")' });
  const res = await req('GET', `/api/audits/${auditId}/export.csv`, ADMIN);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.ok(res.body.startsWith('﻿Runde;Umfang;Instanz;'));
  assert.match(res.body, /Basisversionen: 10\.0, 9\.1, 10\.1/);
  assert.match(res.body, /'=HYPERLINK/);
  assert.match(res.body, /Alpha/);
});

test('bad / unknown ids -> 404', async () => {
  assert.equal((await req('GET', '/api/audits/../../config', ADMIN)).statusCode, 404);
  assert.equal((await req('GET', '/api/audits/not-a-uuid', ADMIN)).statusCode, 404);
  assert.equal(
    (await req('POST', '/api/audits/00000000-0000-4000-8000-000000000000/reopen', ADMIN)).statusCode,
    404
  );
});

test('every change backs up the previous round file', () => {
  const backups = readdirSync(path.join(process.env.DATA_DIR, 'backups')).filter((f) =>
    f.startsWith(`audit-${auditId}-`)
  );
  assert.ok(backups.length > 0 && backups.length <= 10);
  const saved = JSON.parse(readFileSync(path.join(process.env.DATA_DIR, 'audits', auditId + '.json'), 'utf8'));
  assert.equal(saved.id, auditId);
});

test('syncAudit: unknown version only matches when "unknown" is affected', () => {
  const audit = { status: 'open', affected: ['10.0'], repoTypes: [], entries: {} };
  assert.equal(syncAudit(audit, [{ id: 'x', version: null }]), false);
  audit.affected.push('unknown');
  assert.equal(syncAudit(audit, [{ id: 'x', version: null }]), true);
  assert.equal(audit.entries.x.status, 'open');
  // repoType scope
  const scoped = { status: 'open', affected: ['10.0'], repoTypes: ['prod'], entries: {} };
  syncAudit(scoped, [
    { id: 'p', version: '10.0', repoType: 'prod' },
    { id: 'd', version: '10.0', repoType: 'dev' },
  ]);
  assert.deepEqual(Object.keys(scoped.entries), ['p']);
});

test('scope filters: validation', async () => {
  const bad = [
    { excludeHosting: ['cloud'] },
    { excludeHosting: 'external' },
    { components: ['feature:'] },
    { components: ['widget'] },
    { minVersion: '10.x' },
    { minVersion: '10.0.5', fixedVersion: '10.0.5' },
  ];
  for (const extra of bad) {
    const res = await req('POST', '/api/audits', ADMIN, { title: 'x', affected: ['10.0'], ...extra });
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
  }
  const res = await req('POST', '/api/audits', ADMIN, {
    title: 'scoped',
    affected: ['10.0'],
    excludeHosting: ['external', 'external'],
    components: ['rs2', 'plugin:foo'],
    fixedVersion: '10.0.4',
  });
  assert.equal(res.statusCode, 201, res.body);
  const a = res.json().audit;
  assert.deepEqual(a.excludeHosting, ['external']);
  assert.deepEqual(a.includeTags, []);
  assert.equal(a.fixedVersion, '10.0.4');
});

const ep = (id, extra = {}) => ({
  id,
  version: '10.0',
  repoType: 'prod',
  hosting: 'cluster',
  resolvedIp: '10.1.2.3',
  networkTags: ['gwdg'],
  raw: {},
  rs2: false,
  renderservice: null,
  features: [{ id: 'dataprotection' }],
  plugins: ['foo'],
  ...extra,
});
const round = (extra) => ({ status: 'open', affected: ['10.0'], repoTypes: [], entries: {}, ...extra });
const scoped = (extra, eps) => {
  const a = round(extra);
  syncAudit(a, eps);
  return Object.keys(a.entries).sort();
};

test('syncAudit: hosting exclusion; unset hosting stays unless excluded', () => {
  const eps = [ep('k'), ep('x', { hosting: 'external' }), ep('n', { hosting: '' })];
  assert.deepEqual(scoped({ excludeHosting: ['external'] }, eps), ['k', 'n']);
  assert.deepEqual(scoped({ excludeHosting: ['external', 'unset'] }, eps), ['k']);
});

test('syncAudit: network tags include/exclude; unresolved host stays in', () => {
  const eps = [ep('g'), ep('o', { networkTags: ['other'] }), ep('u', { resolvedIp: null, networkTags: [] })];
  assert.deepEqual(scoped({ includeTags: ['gwdg'] }, eps), ['g', 'u']);
  assert.deepEqual(scoped({ excludeTags: ['gwdg'] }, eps), ['o', 'u']);
});

test('syncAudit: components match any; never-fetched instance stays in', () => {
  const eps = [
    ep('rs', { rs2: true }),
    ep('fe'),
    ep('pl', { features: [], plugins: [{ id: 'bar' }] }),
    ep('none', { features: [], plugins: [] }),
    ep('new', { raw: null, features: null, plugins: null }),
  ];
  assert.deepEqual(scoped({ components: ['rs2'] }, eps), ['new', 'rs']);
  assert.deepEqual(scoped({ components: ['feature:dataprotection', 'plugin:bar'] }, eps), ['fe', 'new', 'pl', 'rs']);
});

test('syncAudit: version range only applies with enough precision', () => {
  const eps = [ep('old', { version: '10.0.2' }), ep('fix', { version: '10.0.4' }), ep('base', { version: '10.0' })];
  assert.deepEqual(scoped({ minVersion: '10.0.3' }, eps), ['base', 'fix']);
  assert.deepEqual(scoped({ fixedVersion: '10.0.4' }, eps), ['base', 'old']);
});

test('syncAudit: scope change marks open entries not-affected and back', () => {
  const a = round({});
  syncAudit(a, [ep('x', { hosting: 'external', version: null })]);
  a.affected.push('unknown');
  syncAudit(a, [ep('x', { hosting: 'external', version: null })]);
  assert.equal(a.entries.x.status, 'open');
  a.excludeHosting = ['external'];
  syncAudit(a, [ep('x', { hosting: 'external', version: null })]);
  assert.equal(a.entries.x.status, 'not-affected'); // also with unknown version
  assert.match(a.entries.x.comment, /Hosting ausgeschlossen/);
  a.excludeHosting = [];
  syncAudit(a, [ep('x', { hosting: 'external', version: null })]);
  assert.equal(a.entries.x.status, 'open');
  // Patched entries are never touched by scope changes.
  a.entries.x.status = 'patched';
  a.entries.x.updatedBy = 'admin';
  a.excludeHosting = ['external'];
  syncAudit(a, [ep('x', { hosting: 'external', version: null })]);
  assert.equal(a.entries.x.status, 'patched');
});

test('scopeSummary describes all filters', () => {
  const s = scopeSummary(
    round({ affected: ['10.0', 'unknown'], excludeHosting: ['external'], components: ['rs2'], fixedVersion: '10.0.4' })
  );
  assert.match(s, /Basisversionen: 10\.0, unbekannt/);
  assert.match(s, /ohne Hosting: Extern/);
  assert.match(s, /Komponente: RS2/);
  assert.match(s, /behoben ab 10\.0\.4/);
});
