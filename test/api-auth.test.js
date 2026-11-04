// Auth guard for the WHOLE /api surface. Every registered /api route must be
// listed in ACCESS below; the test fails when a route is added without being
// classified, so new endpoints can't silently ship unauthenticated.
//
// For every non-public route it asserts: no / bad / malformed credentials and
// forged session cookies -> 401 (never issuing a session); viewer on admin
// routes -> 403; error bodies are just { error }. Runs in CI as its own step.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'evv-auth-'));
const { buildApp } = await import('../src/app.js');

// method + route pattern -> required role. 'public' = intentionally open.
const ACCESS = {
  'GET /api/health': 'public',
  'GET /api/public/instances': 'public',
  'POST /api/login': 'public', // validates credentials itself (bad -> 401)
  'POST /api/logout': 'public', // only destroys the caller's own session
  'GET /api/me': 'viewer',
  'GET /api/endpoints': 'viewer',
  'GET /api/endpoints/:id': 'viewer',
  'POST /api/endpoints': 'admin',
  'PATCH /api/endpoints/:id': 'admin',
  'DELETE /api/endpoints/:id': 'admin',
  'POST /api/endpoints/:id/refresh': 'admin',
  'POST /api/refresh': 'admin',
  'GET /api/audits': 'admin',
  'POST /api/audits': 'admin',
  'GET /api/audits/:id': 'admin',
  'PATCH /api/audits/:id': 'admin',
  'PATCH /api/audits/:id/entries/:endpointId': 'admin',
  'POST /api/audits/:id/close': 'admin',
  'POST /api/audits/:id/reopen': 'admin',
  'GET /api/audits/:id/export.csv': 'admin',
};

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const ADMIN = basic('admin', 'pw');
const VIEWER = basic('viewer', 'vpw');

// Credentials / tokens that must never authenticate.
const BAD_AUTH = {
  none: {},
  'wrong admin password': { authorization: basic('admin', 'nope') },
  'wrong viewer password': { authorization: basic('viewer', 'nope') },
  'unknown user': { authorization: basic('root', 'pw') },
  'empty credentials': { authorization: basic('', '') },
  'admin user with viewer password': { authorization: basic('admin', 'vpw') },
  'bearer token': { authorization: 'Bearer pw' },
  'garbage basic': { authorization: 'Basic !!!not-base64' },
  'basic without password': { authorization: 'Basic ' + Buffer.from('admin').toString('base64') },
  'forged session cookie': { cookie: 'evv_session=forged.signature' },
};

const UUID = '00000000-0000-4000-8000-000000000000';
let app;
let routes; // [{ method, url }] for /api, incl. auto-generated HEAD routes

before(async () => {
  app = await buildApp({
    adminUser: 'admin',
    adminPassword: 'pw',
    viewerUser: 'viewer',
    viewerPassword: 'vpw',
    sessionSecret: 'x'.repeat(32),
  });
  await app.ready();
  routes = app.registeredRoutes().filter((r) => r.url.startsWith('/api/'));
});
after(async () => {
  await app.close();
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

// HEAD routes are auto-generated for GET and share its guard.
const keyOf = (r) => `${r.method === 'HEAD' ? 'GET' : r.method} ${r.url}`;
const fill = (url) => url.replace(/:[A-Za-z]+/g, UUID);
const hasBody = (m) => m === 'POST' || m === 'PATCH' || m === 'PUT';

function call(r, headers = {}) {
  return app.inject({
    method: r.method,
    url: fill(r.url),
    headers: { ...headers, ...(hasBody(r.method) ? { 'content-type': 'application/json' } : {}) },
    payload: hasBody(r.method) ? {} : undefined,
  });
}

function protectedRoutes() {
  return routes.filter((r) => ACCESS[keyOf(r)] && ACCESS[keyOf(r)] !== 'public');
}

function assertDenied(res, status, label) {
  assert.equal(res.statusCode, status, `${label}: expected ${status}, got ${res.statusCode} ${res.body}`);
  // A rejected request must never start a session. Clearing a bogus cookie
  // (empty value) is fine; on 403 an existing valid session may be refreshed.
  if (status === 401) {
    for (const c of [].concat(res.headers['set-cookie'] || [])) {
      assert.match(c, /^evv_session=;/, `${label}: must not issue a session cookie (${c})`);
    }
  }
  if (res.body) assert.deepEqual(Object.keys(JSON.parse(res.body)), ['error'], `${label}: body leaks data`);
}

test('every /api route is classified in ACCESS (no unguarded new routes)', () => {
  const unknown = routes.map(keyOf).filter((k) => !(k in ACCESS));
  assert.deepEqual([...new Set(unknown)], [], 'add new routes to ACCESS with the role they require');
  const registered = new Set(routes.map(keyOf));
  const stale = Object.keys(ACCESS).filter((k) => !registered.has(k));
  assert.deepEqual(stale, [], 'ACCESS lists routes that no longer exist');
});

test('protected routes reject missing / invalid credentials with 401', async () => {
  const list = protectedRoutes();
  assert.ok(list.length >= 15, 'expected the full protected API surface');
  for (const r of list) {
    for (const [name, headers] of Object.entries(BAD_AUTH)) {
      assertDenied(await call(r, headers), 401, `${r.method} ${r.url} [${name}]`);
    }
  }
});

test('admin routes reject the viewer with 403 (Basic and session)', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { 'content-type': 'application/json' },
    payload: { user: 'viewer', password: 'vpw' },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];

  for (const r of protectedRoutes().filter((x) => ACCESS[keyOf(x)] === 'admin')) {
    assertDenied(await call(r, { authorization: VIEWER }), 403, `${r.method} ${r.url} [viewer basic]`);
    assertDenied(await call(r, { cookie }), 403, `${r.method} ${r.url} [viewer session]`);
  }
});

test('valid roles pass the guard (no 401/403)', async () => {
  for (const r of protectedRoutes()) {
    const role = ACCESS[keyOf(r)];
    const auths = role === 'viewer' ? [VIEWER, ADMIN] : [ADMIN];
    for (const authorization of auths) {
      const res = await call(r, { authorization });
      assert.ok(
        res.statusCode !== 401 && res.statusCode !== 403,
        `${r.method} ${r.url}: authorized call got ${res.statusCode} ${res.body}`
      );
    }
  }
});

test('a logged-out session cookie no longer authenticates', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { 'content-type': 'application/json' },
    payload: { user: 'admin', password: 'pw' },
  });
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ method: 'GET', url: '/api/audits', headers: { cookie } })).statusCode, 200);
  await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
  for (const r of protectedRoutes()) {
    assertDenied(await call(r, { cookie }), 401, `${r.method} ${r.url} [after logout]`);
  }
});

test('public routes stay open and never expose protected data', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  const pub = await app.inject({ method: 'GET', url: '/api/public/instances?target=app' });
  assert.equal(pub.statusCode, 200);
  assert.deepEqual(Object.keys(pub.json()), ['instances']);
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { 'content-type': 'application/json' },
    payload: { user: 'admin', password: 'wrong' },
  });
  assertDenied(login, 401, 'POST /api/login [wrong password]');
});

test('unknown /api routes -> 404 without auth, no data', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(Object.keys(res.json()), ['error']);
});
