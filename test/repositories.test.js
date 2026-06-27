import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repositoriesUrl } from '../src/url.js';
import { extractRepositories } from '../src/fetcher.js';

test('repositoriesUrl swaps the _about segment', () => {
  assert.equal(
    repositoriesUrl('https://stable.demo.edu-sharing.net/edu-sharing/rest/_about'),
    'https://stable.demo.edu-sharing.net/edu-sharing/rest/network/v1/repositories'
  );
  // trailing slash
  assert.equal(
    repositoriesUrl('https://host.example/edu-sharing/rest/_about/'),
    'https://host.example/edu-sharing/rest/network/v1/repositories'
  );
  // path prefix is preserved
  assert.equal(
    repositoriesUrl('https://host.example/foo/edu-sharing/rest/_about'),
    'https://host.example/foo/edu-sharing/rest/network/v1/repositories'
  );
  // query/hash are dropped
  assert.equal(
    repositoriesUrl('https://host.example/edu-sharing/rest/_about?x=1#y'),
    'https://host.example/edu-sharing/rest/network/v1/repositories'
  );
});

test('extractRepositories drops the home repo and keeps type + title', () => {
  const raw = {
    repositories: [
      { repositoryType: 'ALFRESCO', title: 'local', isHomeRepo: true },
      { repositoryType: 'PIXABAY', title: 'Pixabay', isHomeRepo: false },
      { repositoryType: 'LEARNINGAPPS', title: 'LearningApps' },
      { repositoryType: 'BROCKHAUS', title: 'Brockhaus', isHomeRepo: false },
    ],
  };
  assert.deepEqual(extractRepositories(raw), [
    { type: 'PIXABAY', title: 'Pixabay' },
    { type: 'LEARNINGAPPS', title: 'LearningApps' },
    { type: 'BROCKHAUS', title: 'Brockhaus' },
  ]);
});

test('extractRepositories tolerates missing/odd shapes', () => {
  assert.deepEqual(extractRepositories(null), []);
  assert.deepEqual(extractRepositories({}), []);
  assert.deepEqual(extractRepositories({ repositories: 'nope' }), []);
  assert.deepEqual(extractRepositories({ repositories: [{ isHomeRepo: true }] }), []);
  assert.deepEqual(extractRepositories({ repositories: [{ title: 'X' }] }), [{ type: null, title: 'X' }]);
});
