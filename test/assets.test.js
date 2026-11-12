'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickAsset, describeAsset } = require('../src/main/assets');

const names = (...list) => list.map((name, i) => ({ id: i + 1, name }));
const pick = (assets, opts) => {
  const a = pickAsset(assets, opts);
  return a ? a.name : null;
};

test('picks the asset for each operating system', () => {
  const assets = names('Game-windows.zip', 'Game-macos.zip', 'Game-linux.zip');
  assert.equal(pick(assets, { platform: 'win32', arch: 'x64' }), 'Game-windows.zip');
  assert.equal(pick(assets, { platform: 'darwin', arch: 'arm64' }), 'Game-macos.zip');
  assert.equal(pick(assets, { platform: 'linux', arch: 'x64' }), 'Game-linux.zip');
});

test('understands common naming variants', () => {
  const assets = names('MyGame_Win64.zip', 'MyGame-OSX.zip', 'MyGame.x86_64.AppImage', 'MyGameMac.zip');
  assert.equal(pick(assets, { platform: 'win32', arch: 'x64' }), 'MyGame_Win64.zip');
  assert.equal(pick(assets, { platform: 'linux', arch: 'x64' }), 'MyGame.x86_64.AppImage');
  assert.equal(describeAsset('MyGameMac.zip').os, 'darwin');
});

test('the platform suffix wins over words inside the game name', () => {
  const assets = names('Win the Game-linux.zip', 'Win the Game-windows.zip');
  assert.equal(pick(assets, { platform: 'linux', arch: 'x64' }), 'Win the Game-linux.zip');
  assert.equal(pick(assets, { platform: 'win32', arch: 'x64' }), 'Win the Game-windows.zip');
});

test('"machine" is not mistaken for "mac"', () => {
  assert.equal(describeAsset('MachineGame-windows.zip').os, 'win32');
});

test('prefers the exact CPU, then universal, then emulated x64', () => {
  const assets = names('G-macos-x64.zip', 'G-macos-arm64.zip', 'G-macos-universal.zip');
  assert.equal(pick(assets, { platform: 'darwin', arch: 'arm64' }), 'G-macos-arm64.zip');
  assert.equal(pick(assets, { platform: 'darwin', arch: 'x64' }), 'G-macos-x64.zip');
  assert.equal(pick(names('G-macos-universal.zip', 'G-macos-x64.zip'), { platform: 'darwin', arch: 'arm64' }), 'G-macos-universal.zip');
  assert.equal(pick(names('G-macos-x64.zip'), { platform: 'darwin', arch: 'arm64' }), 'G-macos-x64.zip');
  assert.equal(pick(names('G-macos-arm64.zip'), { platform: 'darwin', arch: 'x64' }), null);
});

test('ignores files that are not installable', () => {
  const assets = names('Game-linux.zip.sha256', 'latest.yml', 'Game-Setup.exe', 'Game-windows.zip.blockmap', 'notes.txt');
  assert.equal(pick(assets, { platform: 'win32', arch: 'x64' }), null);
  assert.equal(pick(assets, { platform: 'linux', arch: 'x64' }), null);
});

test('a single generic zip works everywhere, but a platform-specific one wins', () => {
  assert.equal(pick(names('game.zip'), { platform: 'linux', arch: 'x64' }), 'game.zip');
  assert.equal(pick(names('game.zip', 'game-linux.zip'), { platform: 'linux', arch: 'x64' }), 'game-linux.zip');
});

test('catalog patterns override automatic matching', () => {
  const assets = names('a-windows.zip', 'special_build_final.zip');
  const patterns = { win32: '^special_.*\\.zip$' };
  assert.equal(pick(assets, { platform: 'win32', arch: 'x64', patterns }), 'special_build_final.zip');
  assert.equal(pick(assets, { platform: 'win32', arch: 'x64', patterns: { win32: 'nothing' } }), null);
  assert.equal(pick(assets, { platform: 'win32', arch: 'x64', patterns: { win32: '(' } }), 'a-windows.zip'); // invalid regex -> automatic
});
