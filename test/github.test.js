'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubClient } = require('../src/main/github');
const { CatalogError } = require('../src/main/catalog');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    const route = routes[url];
    if (!route) return new Response('nope', { status: 404 });
    return new Response(route.body, { status: route.status || 200, headers: route.headers || {} });
  };
  impl.calls = calls;
  return impl;
}

const CATALOG = JSON.stringify({ name: 'Demo', games: [{ repo: 'roud/space-cat' }] });

test('downloads and validates a catalog from a GitHub repo', async () => {
  const fetchImpl = fakeFetch({ 'https://raw.githubusercontent.com/roud/cat/HEAD/catalog.json': { body: CATALOG } });
  const gh = new GitHubClient({ fetchImpl });
  const catalog = await gh.fetchCatalog('roud/cat');
  assert.equal(catalog.name, 'Demo');
  assert.equal(catalog.games[0].id, 'roud--space-cat');
});

test('explains a missing or broken catalog', async () => {
  const gh = new GitHubClient({ fetchImpl: fakeFetch({ 'https://raw.githubusercontent.com/roud/bad/HEAD/catalog.json': { body: '{oops' } }) });
  await assert.rejects(gh.fetchCatalog('roud/missing'), (e) => e instanceof CatalogError && /No se encontró catalog.json/.test(e.message));
  await assert.rejects(gh.fetchCatalog('roud/bad'), /no es un JSON válido/);
});

test('the token is sent to GitHub but never to a custom catalog host', async () => {
  const fetchImpl = fakeFetch({
    'https://raw.githubusercontent.com/roud/cat/HEAD/catalog.json': { body: CATALOG },
    'https://example.com/catalog.json': { body: CATALOG },
  });
  const gh = new GitHubClient({ fetchImpl, getToken: () => 'secret-token' });
  await gh.fetchCatalog('roud/cat');
  await gh.fetchCatalog('https://example.com/catalog.json');
  const [github, custom] = fetchImpl.calls;
  assert.match(github.headers.Authorization, /secret-token/);
  assert.equal(custom.headers.Authorization, undefined);
});

test('network failures are reported in plain language', async () => {
  const gh = new GitHubClient({
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(gh.latestRelease('roud/space-cat'), /No hay conexión/);
});
