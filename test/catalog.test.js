'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCatalogSource, normalizeCatalog, normalizeGame, sanitizeId, CatalogError } = require('../src/main/catalog');

test('parses catalog sources', () => {
  assert.equal(parseCatalogSource('roud/pitch-catalog').url, 'https://raw.githubusercontent.com/roud/pitch-catalog/HEAD/catalog.json');
  assert.equal(parseCatalogSource('roud/pitch-catalog@dev').url, 'https://raw.githubusercontent.com/roud/pitch-catalog/dev/catalog.json');
  assert.equal(parseCatalogSource('roud/cat@main:games/list.json').url, 'https://raw.githubusercontent.com/roud/cat/main/games/list.json');
  assert.equal(
    parseCatalogSource('https://github.com/roud/cat/blob/main/x.json').url,
    'https://raw.githubusercontent.com/roud/cat/main/x.json',
  );
  assert.equal(parseCatalogSource('https://example.com/c.json').url, 'https://example.com/c.json');
  assert.equal(parseCatalogSource(''), null);
});

test('rejects unsafe or malformed catalog sources', () => {
  assert.throws(() => parseCatalogSource('http://example.com/c.json'), CatalogError);
  assert.throws(() => parseCatalogSource('no es un repo'), CatalogError);
});

test('normalises games and drops invalid ones', () => {
  const catalog = normalizeCatalog({
    name: 'Mis juegos',
    games: [
      { repo: 'roud/space-cat', title: 'Space Cat', tags: ['arcade'], cover: 'https://x.test/c.png', assets: { windows: 'win', mac: 'mac' } },
      { repo: 'roud/space-cat' }, // duplicate id
      { repo: 'not a repo' },
      { repo: 'https://github.com/roud/lava-run.git' },
      null,
    ],
  });
  assert.equal(catalog.name, 'Mis juegos');
  assert.equal(catalog.games.length, 2);
  assert.deepEqual(catalog.games[0].assets, { win32: 'win', darwin: 'mac' });
  assert.equal(catalog.games[1].repo, 'roud/lava-run');
  assert.equal(catalog.games[1].title, 'Lava run');
  assert.equal(catalog.games[1].author, 'roud');
});

test('ids are safe folder names', () => {
  assert.equal(sanitizeId('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeId('..'), '');
  assert.equal(sanitizeId('Space Cat!'), 'space-cat');
  assert.equal(normalizeGame({ repo: 'a/b', id: '../x' }).id, 'x');
});

test('only https covers are accepted', () => {
  assert.equal(normalizeGame({ repo: 'a/b', cover: 'http://x.test/c.png' }).cover, '');
  assert.equal(normalizeGame({ repo: 'a/b', cover: 'javascript:alert(1)' }).cover, '');
});

test('a catalog without a games list is an error', () => {
  assert.throws(() => normalizeCatalog({}), CatalogError);
});
