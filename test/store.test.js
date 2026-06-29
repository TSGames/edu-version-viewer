import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the store at a throwaway dir BEFORE it loads (it reads DATA_DIR at import).
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'evv-store-'));
process.env.DATA_DIR = DATA_DIR;
const store = await import('../src/store.js');

after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

test('loadConfig returns empty when the file is missing', async () => {
  assert.deepEqual(await store.loadConfig(), { endpoints: [] });
});

test('saveConfig/loadConfig strips fetch fields and defaults addedAt', async () => {
  await store.saveConfig({
    endpoints: [
      {
        id: 'a',
        label: 'A',
        url: 'http://x/_about',
        notes: 'n',
        pwLink: '',
        repoType: 'prod',
        hosting: 'docker',
        // fetch fields that must NOT be persisted into config.json:
        version: '9.0',
        raw: { big: 1 },
        lastStatus: 'ok',
      },
    ],
  });
  const e = (await store.loadConfig()).endpoints[0];
  assert.equal(e.repoType, 'prod');
  assert.equal(e.hosting, 'docker');
  assert.equal(e.addedAt, null); // defaulted
  assert.equal('version' in e, false);
  assert.equal('raw' in e, false);
  assert.equal('lastStatus' in e, false);
});

test('saveFetch/loadFetch keeps only fetch fields incl. raw', async () => {
  await store.saveFetch('a', {
    lastStatus: 'ok',
    version: '9.0',
    services: ['X'],
    repositories: [{ type: 'T', title: 'Ti' }],
    networkTags: ['GWDG'],
    resolvedIp: '1.2.3.4',
    raw: { a: 1 },
    label: 'should-not-persist', // non-fetch field
  });
  const f = await store.loadFetch('a');
  assert.equal(f.version, '9.0');
  assert.deepEqual(f.repositories, [{ type: 'T', title: 'Ti' }]);
  assert.deepEqual(f.networkTags, ['GWDG']);
  assert.deepEqual(f.raw, { a: 1 });
  assert.equal('label' in f, false);
});

test('loadMerged / loadMergedOne combine config + fetch; defaults + unknown id', async () => {
  await store.saveConfig({
    endpoints: [
      { id: 'a', label: 'A', url: 'http://x/_about' },
      { id: 'b', label: 'B', url: 'http://y/_about' },
    ],
  });
  const merged = await store.loadMerged();
  const a = merged.find((e) => e.id === 'a');
  const b = merged.find((e) => e.id === 'b');
  assert.equal(a.version, '9.0'); // from the fetch file saved above
  assert.equal(a.label, 'A'); // from config
  assert.equal(b.lastStatus, 'pending'); // defaultFetch (no fetch file)
  assert.deepEqual(b.networkTags, []);
  assert.equal(await store.loadMergedOne('nope'), null);
});

test('deleteFetch is idempotent', async () => {
  await store.deleteFetch('a');
  await store.deleteFetch('a'); // no throw on missing file
  assert.equal(await store.loadFetch('a'), null);
});

test('ensureConfig migrates legacy inline fetch fields and prunes orphans', async () => {
  // Legacy single-file config: the endpoint carries fetch fields inline.
  writeFileSync(
    store.getConfigPath(),
    JSON.stringify({
      endpoints: [
        { id: 'leg', label: 'Legacy', url: 'http://z/_about', version: '8.1', lastStatus: 'ok', raw: { r: 1 } },
      ],
    })
  );
  // An orphaned fetch file with no matching endpoint.
  mkdirSync(store.getFetchDir(), { recursive: true });
  writeFileSync(path.join(store.getFetchDir(), 'orphan.json'), JSON.stringify({ lastStatus: 'ok' }));

  await store.ensureConfig();

  const legFetch = await store.loadFetch('leg');
  assert.equal(legFetch.version, '8.1'); // migrated into its own fetch file
  assert.deepEqual(legFetch.raw, { r: 1 });
  const cfg = JSON.parse(readFileSync(store.getConfigPath(), 'utf8'));
  assert.equal('version' in cfg.endpoints[0], false); // config stripped to durable fields
  assert.equal(existsSync(path.join(store.getFetchDir(), 'orphan.json')), false); // pruned
});
