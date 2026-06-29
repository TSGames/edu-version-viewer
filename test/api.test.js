// Auth and HTTP status-code matrix across the API, plus the write handlers,
// driven via app.inject() against a local mock upstream (offline, CI-safe).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'evv-api-'));
const { buildApp } = await import('../src/app.js');

const ADMIN = 'Basic ' + Buffer.from('admin:pw').toString('base64');
const VIEWER = 'Basic ' + Buffer.from('viewer:vpw').toString('base64');
const BAD = 'Basic ' + Buffer.from('admin:wrong').toString('base64');

const ABOUT = { version: { repository: '9.0' }, services: [{ name: 'CONFIG' }] };

let app;
let upstream;
let mockUrl;

before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url.endsWith('/_about'))
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ABOUT));
    res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${upstream.address().port}/edu-sharing/rest/_about`;
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

const headers = (auth, json) => ({
  ...(auth ? { authorization: auth } : {}),
  ...(json ? { 'content-type': 'application/json' } : {}),
});
const get = (url, auth) => app.inject({ method: 'GET', url, headers: headers(auth) });
// Only advertise a JSON body when there actually is one — otherwise Fastify
// rejects the empty body with 400 during parsing, before the role preHandler.
const post = (url, auth, payload) =>
  app.inject({ method: 'POST', url, headers: headers(auth, payload !== undefined), payload });

// ---------- auth matrix on read/identity routes ----------

test('GET /api/health is open -> 200, no session cookie', async () => {
  const res = await get('/api/health');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(res.headers['set-cookie'], undefined);
});

test('GET /api/me: 401 unauth / wrong password, 200 with role for admin+viewer', async () => {
  assert.equal((await get('/api/me')).statusCode, 401);
  assert.equal((await get('/api/me', BAD)).statusCode, 401);
  const a = await get('/api/me', ADMIN);
  assert.equal(a.statusCode, 200);
  assert.deepEqual(a.json(), { role: 'admin', user: 'admin', canWrite: true });
  const v = await get('/api/me', VIEWER);
  assert.equal(v.statusCode, 200);
  assert.deepEqual(v.json(), { role: 'viewer', user: 'viewer', canWrite: false });
});

test('GET /api/endpoints: 401 unauth, 401 bad creds, 200 for viewer and admin', async () => {
  assert.equal((await get('/api/endpoints')).statusCode, 401);
  assert.equal((await get('/api/endpoints', BAD)).statusCode, 401);
  assert.equal((await get('/api/endpoints', VIEWER)).statusCode, 200);
  assert.equal((await get('/api/endpoints', ADMIN)).statusCode, 200);
});

test('401 responses carry no WWW-Authenticate (no native browser dialog)', async () => {
  const res = await get('/api/endpoints');
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['www-authenticate'], undefined);
});

test('unknown /api route -> 404 JSON', async () => {
  const res = await get('/api/nope', ADMIN);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Unknown API route' });
});

// ---------- session cookie auth (login/logout) ----------

test('login + cookie auth + logout: 401 -> 200 -> 401', async () => {
  assert.equal(
    (await post('/api/login', null, { user: 'admin', password: 'wrong' })).statusCode,
    401
  );
  const login = await post('/api/login', null, { user: 'admin', password: 'pw' });
  assert.equal(login.statusCode, 200);
  const c = login.cookies.find((x) => x.name === 'evv_session');
  assert.ok(c, 'session cookie set');
  const cookie = `evv_session=${c.value}`;

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().role, 'admin');

  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
  assert.equal(out.statusCode, 200);
  const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(after.statusCode, 401); // session destroyed server-side
});

// ---------- write handlers: roles + status codes ----------

let id;

test('POST /api/endpoints: 401 unauth, 403 viewer, 201 admin, 409 dup, 400 invalid', async () => {
  assert.equal((await post('/api/endpoints', null, { url: mockUrl })).statusCode, 401);
  assert.equal((await post('/api/endpoints', VIEWER, { url: mockUrl })).statusCode, 403);

  const created = await post('/api/endpoints', ADMIN, { url: mockUrl, label: 'Mock' });
  assert.equal(created.statusCode, 201);
  const ep = created.json().endpoint;
  assert.equal(ep.version, '9.0'); // fetched from the mock upstream
  assert.equal(ep.lastStatus, 'ok');
  id = ep.id;

  assert.equal((await post('/api/endpoints', ADMIN, { url: mockUrl })).statusCode, 409);
  assert.equal((await post('/api/endpoints', ADMIN, { url: '' })).statusCode, 400);
  assert.equal(
    (await post('/api/endpoints', ADMIN, { url: 'http://h/edu-sharing/rest/_about', repoType: 'bogus' }))
      .statusCode,
    400
  );
});

test('GET /api/endpoints/:id: 401 unauth, 200 (full incl raw), 404 unknown', async () => {
  assert.equal((await get('/api/endpoints/' + id)).statusCode, 401);
  const one = await get('/api/endpoints/' + id, VIEWER);
  assert.equal(one.statusCode, 200);
  assert.ok(one.json().endpoint.raw, 'full record includes raw');
  assert.equal((await get('/api/endpoints/does-not-exist', ADMIN)).statusCode, 404);
});

test('PATCH /api/endpoints/:id: 403 viewer, 200 admin, 400 invalid, 404 unknown', async () => {
  const patch = (auth, body, theId = id) =>
    app.inject({ method: 'PATCH', url: '/api/endpoints/' + theId, headers: headers(auth, true), payload: body });
  assert.equal((await patch(VIEWER, { notes: 'x' })).statusCode, 403);
  const ok = await patch(ADMIN, { repoType: 'prod', notes: 'hi', hosting: 'cluster' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().endpoint.repoType, 'prod');
  assert.equal(ok.json().endpoint.notes, 'hi');
  assert.equal((await patch(ADMIN, { repoType: 'nope' })).statusCode, 400);
  assert.equal((await patch(ADMIN, { notes: 'x' }, 'unknown')).statusCode, 404);
});

test('POST /api/endpoints/:id/refresh: 403 viewer, 200 admin, 404 unknown', async () => {
  assert.equal((await post('/api/endpoints/' + id + '/refresh', VIEWER)).statusCode, 403);
  assert.equal((await post('/api/endpoints/' + id + '/refresh', ADMIN)).statusCode, 200);
  assert.equal((await post('/api/endpoints/unknown/refresh', ADMIN)).statusCode, 404);
});

test('DELETE /api/endpoints/:id: 403 viewer, 404 unknown, 200 then 404', async () => {
  const del = (auth, theId = id) =>
    app.inject({ method: 'DELETE', url: '/api/endpoints/' + theId, headers: headers(auth) });
  assert.equal((await del(VIEWER)).statusCode, 403);
  assert.equal((await del(ADMIN, 'unknown')).statusCode, 404);
  assert.equal((await del(ADMIN)).statusCode, 200);
  assert.equal((await get('/api/endpoints/' + id, ADMIN)).statusCode, 404); // gone
});
