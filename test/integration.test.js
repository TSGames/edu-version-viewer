import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the store at a throwaway dir BEFORE app.js (and thus store.js) loads.
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'evv-itest-'));
process.env.DATA_DIR = DATA_DIR;
const { buildApp } = await import('../src/app.js');

function basic(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

let app;
before(async () => {
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
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// Pull the evv_session cookie value out of an inject response.
function sessionCookie(res) {
  const c = res.cookies.find((x) => x.name === 'evv_session');
  return c ? `evv_session=${c.value}` : '';
}

test('health is open and sets no session cookie', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(res.headers['set-cookie'], undefined);
});

test('unauthenticated /api/me and /api/endpoints return 401', async () => {
  const me = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(me.statusCode, 401);
  assert.equal(me.headers['www-authenticate'], undefined); // no native dialog
  const eps = await app.inject({ method: 'GET', url: '/api/endpoints' });
  assert.equal(eps.statusCode, 401);
});

test('login with bad credentials -> 401, no cookie', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { user: 'admin', password: 'wrong' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('login -> cookie -> session carries the role', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { user: 'admin', password: 'pw' },
  });
  assert.equal(login.statusCode, 200);
  assert.deepEqual(login.json(), { role: 'admin', user: 'admin', canWrite: true });
  const cookie = sessionCookie(login);
  assert.ok(cookie, 'expected an evv_session cookie');

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().role, 'admin');

  const eps = await app.inject({ method: 'GET', url: '/api/endpoints', headers: { cookie } });
  assert.equal(eps.statusCode, 200);
  assert.ok(Array.isArray(eps.json().endpoints));
});

test('HTTP Basic still works and roles are enforced', async () => {
  const ok = await app.inject({
    method: 'GET',
    url: '/api/endpoints',
    headers: { authorization: basic('admin', 'pw') },
  });
  assert.equal(ok.statusCode, 200);

  // viewer may read but not hit an admin-only route
  const forbidden = await app.inject({
    method: 'POST',
    url: '/api/refresh',
    headers: { authorization: basic('viewer', 'vpw') },
  });
  assert.equal(forbidden.statusCode, 403);
});

test('logout destroys the session (cookie no longer authenticates)', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { user: 'viewer', password: 'vpw' },
  });
  const cookie = sessionCookie(login);

  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.json(), { ok: true });

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.statusCode, 401);
});

test('static shell is public; unknown /api route -> JSON 404', async () => {
  const index = await app.inject({ method: 'GET', url: '/' });
  assert.equal(index.statusCode, 200);
  assert.match(index.headers['content-type'], /text\/html/);

  const unknown = await app.inject({ method: 'GET', url: '/api/nope' });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: 'Unknown API route' });
});
