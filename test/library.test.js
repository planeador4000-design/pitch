'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MockGitHub } = require('./helpers/mock-github');
const { makeZip } = require('./helpers/zip');
const { GitHubClient } = require('../src/main/github');
const { Settings } = require('../src/main/settings');
const { Library } = require('../src/main/library');

const PLATFORM = process.platform;
const ARCH = process.arch;
const REPO = 'roud/space-cat';
const OS_WORD = { win32: 'windows', darwin: 'macos', linux: 'linux' }[PLATFORM];

// A game archive shaped like a real export for the machine running the tests.
function gameZip(version, script = '#!/bin/sh\nexit 0\n') {
  const filler = Buffer.alloc(600 * 1024, version.length);
  if (PLATFORM === 'win32') return makeZip([{ name: 'SpaceCat/SpaceCat.exe', data: filler, mode: 0o755 }]);
  if (PLATFORM === 'darwin') {
    return makeZip([{ name: 'SpaceCat.app/Contents/MacOS/SpaceCat', data: script, mode: 0o644 }]);
  }
  return makeZip([
    { name: 'SpaceCat/SpaceCat', data: Buffer.concat([Buffer.from(script), filler]), mode: 0o755 },
    { name: 'SpaceCat/chrome-sandbox', data: Buffer.alloc(1000), mode: 0o755 },
  ]);
}

async function setup(t) {
  const mock = new MockGitHub();
  await mock.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-lib-'));
  const settings = new Settings(path.join(root, 'settings.json'));
  settings.addCustomGame({ repo: REPO, title: 'Space Cat' });
  const github = new GitHubClient({ apiBase: mock.base, timeoutMs: 5000 });
  const library = new Library({ dataDir: root, gamesDir: path.join(root, 'games'), github, settings });
  t.after(async () => {
    await mock.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { mock, root, settings, library };
}

const asset = (version, zip) => ({ [`SpaceCat-${OS_WORD}.zip`]: zip || gameZip(version) });

test('installs the latest release and verifies its SHA-256', async (t) => {
  const { mock, library, root } = await setup(t);
  mock.publish(REPO, 'v1.0.0', asset('v1.0.0'));
  await library.refresh();

  let view = library.snapshot().games[0];
  assert.equal(view.installed, null);
  assert.equal(view.latest.tag, 'v1.0.0');

  await library.install('roud--space-cat');
  view = library.snapshot().games[0];
  assert.equal(view.installed.tag, 'v1.0.0');
  assert.equal(view.updateAvailable, false);
  assert.ok(fs.existsSync(path.join(root, 'games', library.installed['roud--space-cat'].dir)));
  assert.equal(fs.existsSync(path.join(root, 'games', '.tmp', 'x')), false);
});

test('a corrupted download is rejected and leaves nothing installed', async (t) => {
  const { mock, library, root } = await setup(t);
  mock.publish(REPO, 'v1.0.0', asset('v1.0.0'));
  const name = Object.keys(mock.files)[0];
  mock.files[name] = Buffer.concat([mock.files[name].subarray(0, 100), Buffer.from('CORRUPT'), mock.files[name].subarray(107)]);
  await library.refresh();
  await assert.rejects(library.install('roud--space-cat'), /SHA-256/);
  assert.equal(library.snapshot().games[0].installed, null);
  assert.match(library.snapshot().games[0].error, /SHA-256/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'games', '.tmp')), []);
});

test('auto-update installs a newer release and removes the old version', async (t) => {
  const { mock, library, root } = await setup(t);
  const notices = [];
  library.on('notice', (n) => notices.push(n));

  mock.publish(REPO, 'v1.0.0', asset('v1.0.0'));
  await library.refresh();
  await library.install('roud--space-cat');
  const firstDir = library.installed['roud--space-cat'].dir;

  mock.publish(REPO, 'v1.1.0', asset('v1.1.0'));
  await library.refresh(); // autoUpdate is on by default

  const inst = library.installed['roud--space-cat'];
  assert.equal(inst.tag, 'v1.1.0');
  assert.notEqual(inst.dir, firstDir);
  assert.equal(fs.existsSync(path.join(root, 'games', firstDir)), false);
  assert.equal(notices.at(-1).kind, 'updated');
  assert.equal(notices.at(-1).auto, true);
});

test('with auto-update off, a new release is only reported', async (t) => {
  const { mock, library, settings } = await setup(t);
  mock.publish(REPO, 'v1.0.0', asset('v1.0.0'));
  await library.refresh();
  await library.install('roud--space-cat');

  settings.update({ autoUpdate: false });
  mock.publish(REPO, 'v1.1.0', asset('v1.1.0'));
  await library.refresh();
  const view = library.snapshot().games[0];
  assert.equal(view.installed.tag, 'v1.0.0');
  assert.equal(view.updateAvailable, true);
  assert.equal(view.latest.tag, 'v1.1.0');
});

test('re-uploading an asset under the same tag counts as an update', async (t) => {
  const { mock, library } = await setup(t);
  mock.publish(REPO, 'v1.0.0', asset('v1.0.0'));
  await library.refresh();
  await library.install('roud--space-cat');
  const assetId = library.installed['roud--space-cat'].assetId;

  mock.publish(REPO, 'v1.0.0', asset('v1.0.0-fixed'));
  await library.refresh();
  assert.notEqual(library.installed['roud--space-cat'].assetId, assetId);
});

test('unchanged releases are answered with 304 (no rate limit cost)', async (t) => {
  const { mock, library } = await setup(t);
  mock.publish(REPO, 'v1.0.0', asset('v1.0.0'));
  await library.refresh();
  mock.hits.length = 0;
  await library.refresh();
  const api = mock.hits.filter((h) => h.url.includes('/releases/latest'));
  assert.equal(api.length, 1);
  assert.ok(api[0].ifNoneMatch, 'second request must be conditional');
  assert.equal(library.snapshot().games[0].latest.tag, 'v1.0.0');
});

test('reports when a release has nothing for this system', async (t) => {
  const { mock, library } = await setup(t);
  const other = PLATFORM === 'win32' ? 'linux' : 'windows';
  mock.publish(REPO, 'v1.0.0', { [`SpaceCat-${other}.zip`]: gameZip('x') });
  await library.refresh();
  const view = library.snapshot().games[0];
  assert.match(view.unavailable, /aún no tiene versión para/);
  await assert.rejects(library.install('roud--space-cat'));
});

test('a repo without releases is reported, not crashed on', async (t) => {
  const { library } = await setup(t);
  await library.refresh();
  assert.match(library.snapshot().games[0].unavailable, /Todavía no hay versiones/);
});

test('GitHub rate limits are surfaced with a retry time', async (t) => {
  const { mock, library } = await setup(t);
  mock.rateLimited = true;
  await library.refresh();
  const { sync } = library.snapshot();
  assert.match(sync.error, /limitado/);
  assert.ok(sync.retryAt > Date.now());
});

test('cancelling a download leaves no trace and is not an error', async (t) => {
  const { mock, library, root } = await setup(t);
  mock.publish(REPO, 'v1.0.0', asset('v1.0.0'));
  mock.downloadDelayMs = 1500;
  await library.refresh();
  const job = library.install('roud--space-cat');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(library.snapshot().games[0].busy);
  library.cancel('roud--space-cat');
  await job; // resolves quietly
  const view = library.snapshot().games[0];
  assert.equal(view.installed, null);
  assert.equal(view.busy, null);
  assert.equal(view.error, '');
  assert.deepEqual(fs.readdirSync(path.join(root, 'games', '.tmp')), []);
});

test('uninstall removes the game from disk', async (t) => {
  const { mock, library, root } = await setup(t);
  mock.publish(REPO, 'v1.0.0', asset('v1.0.0'));
  await library.refresh();
  await library.install('roud--space-cat');
  await library.uninstall('roud--space-cat');
  assert.equal(library.snapshot().games[0].installed, null);
  assert.equal(fs.existsSync(path.join(root, 'games', 'roud--space-cat')), false);
});

test('playing tracks the running state and play time', { skip: PLATFORM !== 'linux' }, async (t) => {
  const { mock, library } = await setup(t);
  mock.publish(REPO, 'v1.0.0', asset('v1.0.0', gameZip('v1.0.0', '#!/bin/sh\nsleep 1\n')));
  await library.refresh();
  await library.install('roud--space-cat');
  await library.play('roud--space-cat');
  assert.equal(library.snapshot().games[0].running, true);
  await new Promise((resolve) => library.once('change', resolve));
  for (let i = 0; i < 40 && library.running.size; i++) await new Promise((r) => setTimeout(r, 100));
  const view = library.snapshot().games[0];
  assert.equal(view.running, false);
  assert.ok(view.installed.lastPlayedAt > 0);
  assert.ok(view.installed.playtimeSec >= 1);
});

test('a game that dies right after starting shows an error', { skip: PLATFORM !== 'linux' }, async (t) => {
  const { mock, library } = await setup(t);
  mock.publish(REPO, 'v1.0.0', asset('v1.0.0', gameZip('v1.0.0', '#!/bin/sh\nexit 3\n')));
  await library.refresh();
  await library.install('roud--space-cat');
  await library.play('roud--space-cat');
  for (let i = 0; i < 40 && library.running.size; i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(library.snapshot().games[0].error, /código 3/);
});

test('installed games survive a restart and stay playable when removed from the catalog', async (t) => {
  const { mock, library, root, settings } = await setup(t);
  mock.publish(REPO, 'v1.0.0', asset('v1.0.0'));
  await library.refresh();
  await library.install('roud--space-cat');

  settings.removeCustomGame('roud--space-cat');
  const restarted = new Library({
    dataDir: root,
    gamesDir: path.join(root, 'games'),
    github: new GitHubClient({ apiBase: mock.base }),
    settings,
  });
  const view = restarted.snapshot().games[0];
  assert.equal(view.title, 'Space Cat');
  assert.equal(view.orphan, true);
  assert.equal(view.installed.tag, 'v1.0.0');
});
