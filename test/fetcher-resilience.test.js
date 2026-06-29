import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Configure the fetcher BEFORE import (it reads these env vars at load time).
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'evv-fetch-'));
process.env.FAIL_THRESHOLD = '2';
process.env.REQUEST_TIMEOUT_MS = '2000';
const { fetchEndpoint } = await import('../src/fetcher.js');
const { parseRanges } = await import('../src/ipranges.js');

const RANGES = parseRanges('127.0.0.0/8: LOCAL');

const ABOUT = {
  version: { repository: '9.0', renderservice: '9.0' },
  renderingService2: {},
  services: [{ name: 'CONFIG' }],
};
const REPOS = {
  repositories: [
    { repositoryType: 'ALFRESCO', title: 'local', isHomeRepo: true },
    { repositoryType: 'PIXABAY', title: 'Pixabay' },
  ],
};

// Mutable mock state, flipped per test.
const state = { about: 'ok', repos: 'ok' };
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.endsWith('/_about')) {
      if (state.about === 'fail') return void res.writeHead(500).end('err');
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ABOUT));
    }
    if (req.url.endsWith('/network/v1/repositories')) {
      if (state.repos === 'forbidden') return void res.writeHead(403).end('no');
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(REPOS));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/edu-sharing/rest/_about`;
});
after(() => {
  server.close();
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const newEndpoint = () => ({ url: base, failCount: 0, lastStatus: 'pending', error: null });

test('success: ok status, version/services/rs2, repos (home filtered), network tags', async () => {
  state.about = 'ok';
  state.repos = 'ok';
  const ep = newEndpoint();
  await fetchEndpoint(ep, RANGES);
  assert.equal(ep.lastStatus, 'ok');
  assert.equal(ep.version, '9.0');
  assert.deepEqual(ep.services, ['CONFIG']);
  assert.equal(ep.rs2, true);
  assert.equal(ep.failCount, 0);
  assert.equal(ep.resolvedIp, '127.0.0.1');
  assert.deepEqual(ep.networkTags, ['LOCAL']); // DNS(127.0.0.1) matched 127.0.0.0/8
  assert.deepEqual(ep.repositories, [{ type: 'PIXABAY', title: 'Pixabay' }]);
});

test('repositories 403 is tolerated: status stays ok, previous list kept', async () => {
  state.about = 'ok';
  state.repos = 'forbidden';
  const ep = newEndpoint();
  ep.repositories = [{ type: 'OLD', title: 'Old' }];
  await fetchEndpoint(ep, RANGES);
  assert.equal(ep.lastStatus, 'ok'); // secondary failure never flips status
  assert.deepEqual(ep.repositories, [{ type: 'OLD', title: 'Old' }]); // unchanged
});

test('resilience: flips to error only AFTER more than FAIL_THRESHOLD failures, then recovers', async () => {
  state.about = 'fail';
  const ep = newEndpoint();
  ep.lastStatus = 'ok'; // previously healthy

  await fetchEndpoint(ep, RANGES); // failure 1 (<= threshold)
  assert.equal(ep.failCount, 1);
  assert.equal(ep.lastStatus, 'ok'); // last known-good kept
  assert.ok(ep.lastError); // last error always recorded
  assert.equal(ep.error, null); // not surfaced yet

  await fetchEndpoint(ep, RANGES); // failure 2 (== threshold, not >)
  assert.equal(ep.failCount, 2);
  assert.equal(ep.lastStatus, 'ok');

  await fetchEndpoint(ep, RANGES); // failure 3 (> threshold)
  assert.equal(ep.failCount, 3);
  assert.equal(ep.lastStatus, 'error');
  assert.ok(ep.error);

  state.about = 'ok'; // recovery
  await fetchEndpoint(ep, RANGES);
  assert.equal(ep.failCount, 0);
  assert.equal(ep.lastStatus, 'ok');
});
