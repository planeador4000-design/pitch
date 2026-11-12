'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGameShortcut } = require('../src/main/autostart');

function fakeApp(exePath, desktopDir) {
  return {
    getPath: (name) => (name === 'desktop' ? desktopDir : exePath),
  };
}

test('creates a Linux .desktop shortcut that launches the right game', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-shortcut-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = fakeApp('/usr/bin/pitch', dir);

  const file = await createGameShortcut({ app, gameId: 'roud--space-cat', title: 'Space Cat: Rescue!' });
  assert.ok(fs.existsSync(file));
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /Exec="\/usr\/bin\/pitch" --launch=roud--space-cat/);
  assert.match(content, /Name=Space Cat Rescue!/); // ":" is stripped: it isn't safe in a filename on every OS
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode & 0o111, 0o111); // executable
});

test('shortcut names strip characters unsafe for filenames', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-shortcut-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = fakeApp('/usr/bin/pitch', dir);
  const file = await createGameShortcut({ app, gameId: 'x', title: 'Weird/Name:*?"<>|' });
  assert.equal(path.basename(file), 'WeirdName.desktop');
});
