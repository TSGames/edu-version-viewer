// Source-IP allowlist + proxy trust (src/access.js) wired into buildApp().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'evv-access-'));
const { buildApp } = await import('../src/app.js');
const { parseSourceRanges, parseTrustProxyHops, resolveAccessConfig, ipAllowed } = await import('../src/access.js');

after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const ADMIN = 'Basic ' + Buffer.from('admin:pw').toString('base64');
const base = { adminUser: 'admin', adminPassword: 'pw', sessionSecret: 'x'.repeat(32) };

test('parseSourceRanges: CIDR, octet prefix, separators; invalid throws', () => {
  const r = parseSourceRanges('134.76.0.0/16, 10 192.168.1;');
  assert.deepEqual(
    r.map((x) => x.spec),
    ['134.76.0.0/16', '10', '192.168.1']
  );
  assert.deepEqual(parseSourceRanges(''), []);
  assert.deepEqual(parseSourceRanges(undefined), []);
  assert.throws(() => parseSourceRanges('134.76.0.0/33'));
  assert.throws(() => parseSourceRanges('example.org'));
});

test('parseTrustProxyHops', () => {
  assert.equal(parseTrustProxyHops(undefined), undefined);
  assert.equal(parseTrustProxyHops(''), undefined);
  assert.equal(parseTrustProxyHops('0'), false);
  assert.equal(parseTrustProxyHops('2'), 2);
  assert.throws(() => parseTrustProxyHops('true'));
  assert.throws(() => parseTrustProxyHops('-1'));
});

test('allowlist without TRUST_PROXY_HOPS refuses to start', () => {
  assert.throws(() => resolveAccessConfig({ allowedSourceRanges: '10.0.0.0/8' }, {}), /TRUST_PROXY_HOPS/);
  assert.deepEqual(resolveAccessConfig({}, {}).trustProxy, true); // legacy default, no allowlist
});

test('ipAllowed: IPv4, IPv4-mapped IPv6; plain IPv6 never matches', () => {
  const r = parseSourceRanges('10.0.0.0/8');
  assert.equal(ipAllowed('10.1.2.3', r), true);
  assert.equal(ipAllowed('::ffff:10.1.2.3', r), true);
  assert.equal(ipAllowed('11.0.0.1', r), false);
  assert.equal(ipAllowed('::1', r), false);
  assert.equal(ipAllowed(undefined, r), false);
});

test('direct exposure (hops 0): connection IP decides, X-Forwarded-For is ignored', async () => {
  const app = await buildApp({ ...base, allowedSourceRanges: '10.0.0.0/8', trustProxyHops: '0' });
  const inj = (remoteAddress, url, headers = {}) => app.inject({ method: 'GET', url, remoteAddress, headers });

  assert.equal((await inj('10.0.0.5', '/api/endpoints', { authorization: ADMIN })).statusCode, 200);
  const denied = await inj('203.0.113.7', '/api/endpoints', { authorization: ADMIN });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.json(), { error: 'Forbidden' });
  // Spoofed header from an outside address does not help.
  assert.equal(
    (await inj('203.0.113.7', '/api/endpoints', { authorization: ADMIN, 'x-forwarded-for': '10.0.0.5' })).statusCode,
    403
  );
  // Static shell and unknown paths are restricted too.
  assert.equal((await inj('203.0.113.7', '/')).statusCode, 403);
  assert.equal((await inj('203.0.113.7', '/nope')).statusCode, 403);
  assert.equal((await inj('203.0.113.7', '/api/login')).statusCode, 403);
  // Public routes stay open (also with a query string).
  assert.equal((await inj('203.0.113.7', '/api/health')).statusCode, 200);
  assert.equal((await inj('203.0.113.7', '/api/public/instances?target=app')).statusCode, 200);
  // A path that only *looks* public is not exempt.
  assert.equal((await inj('203.0.113.7', '/api/public/../endpoints')).statusCode, 403);
  assert.equal((await inj('203.0.113.7', '/api/public/instances/x')).statusCode, 403);
  await app.close();
});

test('behind one proxy (hops 1): only the address the proxy saw counts', async () => {
  const app = await buildApp({ ...base, allowedSourceRanges: '134.76.0.0/16', trustProxyHops: '1' });
  const inj = (xff) =>
    app.inject({
      method: 'GET',
      url: '/api/me',
      remoteAddress: '10.42.0.9', // the ingress pod
      headers: { authorization: ADMIN, ...(xff ? { 'x-forwarded-for': xff } : {}) },
    });
  assert.equal((await inj('134.76.1.2')).statusCode, 200);
  assert.equal((await inj('203.0.113.7')).statusCode, 403);
  // Client-supplied entry in front of the proxy's own entry is ignored.
  assert.equal((await inj('134.76.1.2, 203.0.113.7')).statusCode, 403);
  // No header -> req.ip is the proxy itself, which is not allowed.
  assert.equal((await inj()).statusCode, 403);
  await app.close();
});

test('no allowlist configured: nothing is restricted', async () => {
  const app = await buildApp({ ...base, allowedSourceRanges: '', trustProxyHops: '0' });
  const res = await app.inject({ method: 'GET', url: '/api/me', remoteAddress: '203.0.113.7', headers: { authorization: ADMIN } });
  assert.equal(res.statusCode, 200);
  await app.close();
});
