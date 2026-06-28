import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBasic, makeAuthenticator } from '../src/auth.js';

function basic(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

const roleFor = makeAuthenticator({
  adminUser: 'admin',
  adminPassword: 'adminpw',
  viewerUser: 'viewer',
  viewerPassword: 'viewpw',
});

test('parseBasic decodes user and password', () => {
  assert.deepEqual(parseBasic(basic('alice', 's3cret')), { user: 'alice', pass: 's3cret' });
});

test('parseBasic handles passwords containing colons', () => {
  assert.deepEqual(parseBasic(basic('bob', 'a:b:c')), { user: 'bob', pass: 'a:b:c' });
});

test('parseBasic returns null for missing/!basic headers', () => {
  assert.equal(parseBasic(''), null);
  assert.equal(parseBasic(undefined), null);
  assert.equal(parseBasic('Bearer xyz'), null);
});

test('admin credentials -> admin', () => {
  assert.equal(roleFor(basic('admin', 'adminpw')), 'admin');
});

test('viewer credentials -> viewer', () => {
  assert.equal(roleFor(basic('viewer', 'viewpw')), 'viewer');
});

test('wrong password -> null', () => {
  assert.equal(roleFor(basic('admin', 'nope')), null);
  assert.equal(roleFor(basic('viewer', 'nope')), null);
});

test('no header -> null', () => {
  assert.equal(roleFor(''), null);
});

test('empty viewerPassword disables the viewer account', () => {
  const r = makeAuthenticator({
    adminUser: 'admin',
    adminPassword: 'adminpw',
    viewerUser: 'viewer',
    viewerPassword: '',
  });
  // Empty supplied password must not match an unset account.
  assert.equal(r(basic('viewer', '')), null);
  assert.equal(r(basic('admin', 'adminpw')), 'admin');
});

test('empty adminPassword disables the admin account', () => {
  const r = makeAuthenticator({
    adminUser: 'admin',
    adminPassword: '',
    viewerUser: 'viewer',
    viewerPassword: 'viewpw',
  });
  assert.equal(r(basic('admin', '')), null);
  assert.equal(r(basic('viewer', 'viewpw')), 'viewer');
});
