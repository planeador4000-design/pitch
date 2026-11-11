'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findEntry } = require('../src/main/launcher');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-launcher-'));
  for (const [rel, { size = 10, mode = 0o644 } = {}] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(size));
    fs.chmodSync(full, mode);
  }
  return root;
}

test('windows: picks the game exe and skips helpers', () => {
  const dir = tree({
    'MyGame/MyGame.exe': { size: 5000 },
    'MyGame/unins000.exe': { size: 9000 },
    'MyGame/crashpad_handler.exe': { size: 8000 },
    'MyGame/resources/app.exe': { size: 99999 },
  });
  assert.equal(findEntry(dir, 'win32'), path.join('MyGame', 'MyGame.exe'));
});

test('macOS: returns the .app bundle', () => {
  const dir = tree({ 'Game.app/Contents/MacOS/Game': { size: 100, mode: 0o755 }, '__MACOSX/._Game.app': {} });
  assert.equal(findEntry(dir, 'darwin'), 'Game.app');
});

test('linux: picks the biggest executable of an Electron layout', () => {
  const dir = tree({
    'game/game': { size: 4_000_000, mode: 0o755 },
    'game/chrome-sandbox': { size: 100_000, mode: 0o4755 },
    'game/chrome_crashpad_handler': { size: 300_000, mode: 0o755 },
    'game/libffmpeg.so': { size: 9_000_000, mode: 0o755 },
    'game/resources.pak': { size: 6_000_000, mode: 0o644 },
    'game/LICENSE': { size: 1000 },
  });
  assert.equal(findEntry(dir, 'linux'), path.join('game', 'game'));
});

test('linux: still finds the binary when the zip lost its executable bits', () => {
  const dir = tree({ 'game/game': { size: 4_000_000, mode: 0o644 }, 'game/LICENSE': { size: 1000 } });
  assert.equal(findEntry(dir, 'linux'), path.join('game', 'game'));
});

test('linux: prefers an AppImage', () => {
  const dir = tree({ 'Game.AppImage': { size: 100, mode: 0o755 }, 'other': { size: 5000, mode: 0o755 } });
  assert.equal(findEntry(dir, 'linux'), 'Game.AppImage');
});

test('returns null when there is nothing to run', () => {
  const dir = tree({ 'readme.txt': {}, 'data/level1.json': {} });
  assert.equal(findEntry(dir, 'linux'), null);
  assert.equal(findEntry(dir, 'win32'), null);
});
