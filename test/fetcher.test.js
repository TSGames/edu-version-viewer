import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractVersion, extractServices, summarize } from '../src/fetcher.js';

const SAMPLE = {
  plugins: null,
  features: null,
  themesUrl: 'https://stable.demo.edu-sharing.net/edu-sharing/themes/default/',
  lastCacheUpdate: 1750750154234,
  version: { repository: '9.0', renderservice: '9.0', major: 1, minor: 1 },
  services: [
    { name: 'MEDIACENTER', instances: [{ endpoint: '/mediacenter/v1' }] },
    { name: 'CONFIG', instances: [{ endpoint: '/config/v1' }] },
  ],
};

test('extractVersion uses version.repository', () => {
  assert.equal(extractVersion(SAMPLE), '9.0');
});

test('extractVersion falls back to major.minor', () => {
  assert.equal(extractVersion({ version: { major: 2, minor: 3 } }), '2.3');
});

test('extractVersion handles string version', () => {
  assert.equal(extractVersion({ version: '7.1' }), '7.1');
});

test('extractVersion returns null when absent', () => {
  assert.equal(extractVersion({}), null);
});

test('extractServices returns names', () => {
  assert.deepEqual(extractServices(SAMPLE), ['MEDIACENTER', 'CONFIG']);
});

test('extractServices handles missing services', () => {
  assert.deepEqual(extractServices({}), []);
});

test('summarize captures full raw and key fields', () => {
  const s = summarize(SAMPLE);
  assert.equal(s.version, '9.0');
  assert.equal(s.renderservice, '9.0');
  assert.deepEqual(s.services, ['MEDIACENTER', 'CONFIG']);
  assert.equal(s.features, null);
  assert.equal(s.plugins, null);
  assert.deepEqual(s.raw, SAMPLE); // everything is preserved
});
