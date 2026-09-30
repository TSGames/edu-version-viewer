import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAboutUrl, deriveLabel, portalUrl } from '../src/url.js';

test('bare hostname gets https + _about path', () => {
  assert.equal(
    normalizeAboutUrl('stable.demo.edu-sharing.net'),
    'https://stable.demo.edu-sharing.net/edu-sharing/rest/_about'
  );
});

test('hostname with trailing slash', () => {
  assert.equal(
    normalizeAboutUrl('stable.demo.edu-sharing.net/'),
    'https://stable.demo.edu-sharing.net/edu-sharing/rest/_about'
  );
});

test('full _about url is preserved', () => {
  const u = 'https://stable.demo.edu-sharing.net/edu-sharing/rest/_about';
  assert.equal(normalizeAboutUrl(u), u);
});

test('http scheme is kept', () => {
  assert.equal(
    normalizeAboutUrl('http://localhost:8080'),
    'http://localhost:8080/edu-sharing/rest/_about'
  );
});

test('base path is preserved and _about appended', () => {
  assert.equal(
    normalizeAboutUrl('https://host.example/edu-sharing/rest/_about/'),
    'https://host.example/edu-sharing/rest/_about/'
  );
});

test('empty input throws', () => {
  assert.throws(() => normalizeAboutUrl(''));
  assert.throws(() => normalizeAboutUrl('   '));
});

test('deriveLabel returns hostname', () => {
  assert.equal(
    deriveLabel('https://stable.demo.edu-sharing.net/edu-sharing/rest/_about'),
    'stable.demo.edu-sharing.net'
  );
});

test('portalUrl derives <origin>/edu-sharing, keeping a path prefix', () => {
  assert.equal(portalUrl('https://h.example/edu-sharing/rest/_about'), 'https://h.example/edu-sharing');
  assert.equal(portalUrl('https://h.example/pre/edu-sharing/rest/_about'), 'https://h.example/pre/edu-sharing');
  assert.equal(portalUrl('https://h.example:8443/custom/_about'), 'https://h.example:8443/edu-sharing');
});
