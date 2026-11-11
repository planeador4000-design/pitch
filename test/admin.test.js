'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MockGitHub } = require('./helpers/mock-github');
const { GitHubClient } = require('../src/main/github');
const { Settings } = require('../src/main/settings');
const { Library } = require('../src/main/library');

const CATALOG_REPO = 'roud/pitch-catalog';

async function setup(t, { token = 'admin-token' } = {}) {
  const mock = new MockGitHub();
  await mock.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-admin-'));
  const settings = new Settings(path.join(root, 'settings.json'));
  settings.update({ catalog: CATALOG_REPO, token });
  const github = new GitHubClient({ apiBase: mock.base, getToken: () => settings.getToken(), timeoutMs: 5000 });
  const library = new Library({ dataDir: root, gamesDir: path.join(root, 'games'), github, settings });
  t.after(async () => {
    await mock.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { mock, library, settings, root };
}

test('the admin panel is only available to a token that can push to the catalog repo', async (t) => {
  const { mock, library, settings } = await setup(t);
  await library.checkAdmin();
  assert.equal(library.snapshot().admin.canEdit, true);
  assert.equal(library.snapshot().admin.repo, CATALOG_REPO);

  mock.canPush = false;
  await library.checkAdmin();
  assert.equal(library.snapshot().admin.canEdit, false);
  await assert.rejects(library.adminLoad(), /solo para administradores/);

  mock.canPush = true;
  settings.update({ token: '' });
  await library.checkAdmin();
  assert.equal(library.snapshot().admin.canEdit, false);
});

test('a brand new catalog repo can be initialised from the panel', async (t) => {
  const { mock, library } = await setup(t);
  await library.checkAdmin();

  const first = await library.adminLoad();
  assert.deepEqual(first.catalog.games, []);
  assert.equal(first.sha, null);

  const catalog = { name: 'Mi tienda', games: [{ repo: 'roud/space-cat', title: 'Space Cat', featured: true, tags: ['arcade'] }] };
  const saved = await library.adminSave(catalog, first.sha);
  assert.ok(saved.sha);
  assert.equal(mock.commits.length, 1);
  assert.match(mock.commits[0].message, /Pitch/);

  const written = JSON.parse(mock.contents[`${CATALOG_REPO}:catalog.json`].text);
  assert.equal(written.games[0].repo, 'roud/space-cat');

  const view = library.snapshot();
  assert.equal(view.catalogName, 'Mi tienda');
  assert.equal(view.games[0].featured, true);
});

test('editing keeps unknown fields and uses the latest sha', async (t) => {
  const { mock, library } = await setup(t);
  await library.checkAdmin();
  const { sha } = await library.adminSave({ name: 'X', games: [{ repo: 'a/b', assets: { linux: 'x' }, extra: 1 }] }, null);

  const loaded = await library.adminLoad();
  assert.equal(loaded.sha, sha);
  loaded.catalog.games[0].title = 'Nuevo título';
  await library.adminSave(loaded.catalog, loaded.sha);
  const written = JSON.parse(mock.contents[`${CATALOG_REPO}:catalog.json`].text);
  assert.equal(written.games[0].extra, 1);
  assert.equal(written.games[0].title, 'Nuevo título');
});

test('a stale sha is reported as a conflict instead of overwriting someone else\'s edit', async (t) => {
  const { library } = await setup(t);
  await library.checkAdmin();
  const { sha } = await library.adminSave({ name: 'X', games: [{ repo: 'a/b' }] }, null);
  await library.adminSave({ name: 'X', games: [{ repo: 'a/b' }, { repo: 'a/c' }] }, sha); // someone else
  await assert.rejects(library.adminSave({ name: 'X', games: [] }, sha), /cambió mientras lo editabas/);
});

test('invalid catalogs and duplicate ids are rejected before anything is committed', async (t) => {
  const { mock, library } = await setup(t);
  await library.checkAdmin();
  await assert.rejects(library.adminSave({ name: 'X' }, null), /games/);
  await assert.rejects(library.adminSave({ name: 'X', games: [{ repo: 'no es un repo' }] }, null), /repositorio válido/);
  await assert.rejects(
    library.adminSave({ name: 'X', games: [{ repo: 'a/b', id: 'same' }, { repo: 'c/d', id: 'same' }] }, null),
    /mismo identificador/,
  );
  assert.equal((mock.commits || []).length, 0);
});

test('right after publishing, a refresh does not bring back the stale CDN copy', async (t) => {
  const { library } = await setup(t);
  await library.checkAdmin();
  await library.adminSave({ name: 'Recién publicado', games: [{ repo: 'roud/space-cat' }] }, null);
  await library.loadCatalog(); // would hit raw.githubusercontent.com if it were not for the freshness window
  assert.equal(library.snapshot().catalogName, 'Recién publicado');
  assert.equal(library.snapshot().games.length, 1);
});
