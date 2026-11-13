'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Updater, friendlyError, releasesUrlFromPackage } = require('../src/main/updater');

function fakeAutoUpdater(onCheck) {
  const u = new EventEmitter();
  u.checkForUpdates = async () => onCheck(u);
  u.quitAndInstall = (...args) => {
    u.quit = args;
  };
  return u;
}

test('disabled when there is no autoUpdater (dev run): never checks, never throws', async () => {
  const up = new Updater({ autoUpdater: null, version: '1.0.0', enabled: true });
  assert.equal(up.status().state, 'disabled');
  await up.check({ manual: true });
  assert.equal(up.status().state, 'disabled');
});

test('a newer release is downloaded automatically and ends up ready to install', async () => {
  const au = fakeAutoUpdater((u) => {
    u.emit('checking-for-update');
    u.emit('update-available', { version: '1.1.0' });
    u.emit('download-progress', { percent: 42.4 });
    u.emit('update-downloaded', { version: '1.1.0' });
  });
  const up = new Updater({ autoUpdater: au, version: '1.0.0', enabled: true, canInstall: true });
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, true);
  const notices = [];
  up.on('notice', (n) => notices.push(n.message));

  await up.check();
  assert.equal(up.status().state, 'ready');
  assert.equal(up.status().newVersion, '1.1.0');
  assert.match(notices[0], /1\.1\.0/);

  up.install();
  assert.deepEqual(au.quit, [false, true]);
});

test('without self-install (unsigned macOS, .deb) it only announces the new version', async () => {
  const au = fakeAutoUpdater((u) => u.emit('update-available', { version: '2.0.0' }));
  const up = new Updater({ autoUpdater: au, version: '1.0.0', enabled: true, canInstall: false, releasesUrl: 'https://github.com/o/r/releases/latest' });
  assert.equal(au.autoDownload, false);
  assert.equal(au.autoInstallOnAppQuit, false);
  const notices = [];
  up.on('notice', (n) => notices.push(n.message));
  await up.check();
  assert.equal(up.status().state, 'available');
  assert.equal(up.status().releasesUrl, 'https://github.com/o/r/releases/latest');
  assert.match(notices[0], /2\.0\.0/);
  assert.throws(() => up.install(), /descargada/);
});

test('"up to date" only speaks when the check was manual', async () => {
  const au = fakeAutoUpdater((u) => u.emit('update-not-available', {}));
  const up = new Updater({ autoUpdater: au, version: '1.0.0', enabled: true, canInstall: true });
  const notices = [];
  up.on('notice', (n) => notices.push(n.message));
  await up.check();
  assert.equal(notices.length, 0);
  await up.check({ manual: true });
  assert.equal(notices.length, 1);
  assert.equal(up.status().state, 'idle');
});

test('background errors stay quiet, manual ones are reported, and the state is retryable', async () => {
  let fail = true;
  const au = fakeAutoUpdater((u) => {
    if (fail) u.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));
    else u.emit('update-not-available', {});
  });
  const up = new Updater({ autoUpdater: au, version: '1.0.0', enabled: true, canInstall: true });
  const notices = [];
  up.on('notice', (n) => notices.push(n));
  await up.check();
  assert.equal(up.status().state, 'error');
  assert.equal(notices.length, 0);
  await up.check({ manual: true });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].tone, 'amber');
  fail = false;
  await up.check();
  assert.equal(up.status().state, 'idle');
});

test('does not start a second check while one is running or an update is ready', async () => {
  let calls = 0;
  const au = fakeAutoUpdater((u) => {
    calls++;
    u.emit('checking-for-update');
  });
  const up = new Updater({ autoUpdater: au, version: '1.0.0', enabled: true, canInstall: true });
  await up.check();
  await up.check();
  assert.equal(calls, 1);
});

test('friendlyError turns network and missing-release failures into plain Spanish', () => {
  assert.match(friendlyError(new Error('net::ERR_INTERNET_DISCONNECTED')), /Sin conexión/);
  assert.match(friendlyError(new Error('Cannot find latest.yml in the latest release artifacts (HttpError: 404)')), /Releases/);
});

test('the download link comes from package.json "repository" and never ends up empty', () => {
  assert.equal(releasesUrlFromPackage({ repository: { type: 'git', url: 'https://github.com/planeador4000-design/pitch.git' } }), 'https://github.com/planeador4000-design/pitch/releases/latest');
  assert.equal(releasesUrlFromPackage({ repository: 'github:o/r' }), 'https://github.com/o/r/releases/latest');
  assert.equal(releasesUrlFromPackage({}), 'https://github.com/planeador4000-design/pitch/releases/latest'); // the installed app has no "build" block either
  assert.equal(releasesUrlFromPackage(require('../package.json')), 'https://github.com/planeador4000-design/pitch/releases/latest');
});
