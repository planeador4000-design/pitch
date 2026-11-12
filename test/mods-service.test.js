'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModStore } = require('../src/main/mods/store');
const { ModService } = require('../src/main/mods/service');

const PAD = { enabled: true, stick: 'arrows', deadzone: 0.35, buttons: { a: 'space' } };

async function setup(t, { pad = PAD } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-svc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ModStore({ dir: path.join(root, 'mods'), stateFile: path.join(root, 's.json'), pitchVersion: '0.1.0' });
  const service = new ModService({ store, settings: { get: () => ({ gamepad: pad }) } });
  const install = async (id, extra = {}) => {
    const dir = path.join(root, 'src-' + id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ id, name: id.toUpperCase(), version: '1.0.0', main: 'main.js', pitchApi: '1.0', permissions: ['game'], ...extra }));
    fs.writeFileSync(path.join(dir, 'main.js'), '// mod');
    await store.installFromFolder(dir);
  };
  return { store, service, install };
}

test('Vanilla with no controller: nothing is injected and no port is opened', async (t) => {
  const { service } = await setup(t);
  assert.deepEqual(await service.prepare('g1', { gamepadsConnected: 0 }), { inject: false });
});

test('a connected controller (and the setting on) is enough to open a port, with no mods', async (t) => {
  const { service } = await setup(t);
  const job = await service.prepare('g1', { gamepadsConnected: 1 });
  assert.equal(job.inject, true);
  assert.equal(job.mods.length, 0);
  assert.deepEqual(job.gamepad, PAD);
  assert.match(job.extraArgs[0], /^--remote-debugging-port=\d+$/);
});

test('with the gamepad setting off, a connected controller does not open a port', async (t) => {
  const { service } = await setup(t, { pad: { ...PAD, enabled: false } });
  assert.deepEqual(await service.prepare('g1', { gamepadsConnected: 2 }), { inject: false });
});

test('active mods are resolved in load order once their permissions are approved', async (t) => {
  const { service, store, install } = await setup(t);
  await install('late-balance', { category: 'balance' });
  await install('early-framework', { category: 'framework' });
  store.createProfile('g1', 'Survival');
  store.setProfileMods('g1', 'Survival', ['late-balance', 'early-framework']);

  await assert.rejects(service.prepare('g1'), (e) => e.code === 'APPROVAL' && /LATE-BALANCE|EARLY-FRAMEWORK/.test(e.message));

  await service.approve(['late-balance', 'early-framework']);
  const job = await service.prepare('g1');
  assert.deepEqual(job.mods.map((m) => m.id), ['early-framework', 'late-balance']);
  assert.equal(job.gamepad, null);
});

test('a plan with errors blocks the launch and says exactly why', async (t) => {
  const { service, store, install } = await setup(t);
  await install('needs-lib', { dependencies: { 'missing-lib': '>=1.0.0' } });
  store.createProfile('g1', 'Broken');
  store.setProfileMods('g1', 'Broken', ['needs-lib']);
  await assert.rejects(service.prepare('g1'), (e) => e.code === 'PLAN' && /missing-lib/.test(e.message));
});

test('gameState tells the UI what to show: order, problems, who still needs approval', async (t) => {
  const { service, store, install } = await setup(t);
  await install('alpha');
  await install('beta', { permissions: ['game', 'audio'] });
  store.createProfile('g1', 'P');
  store.setProfileMods('g1', 'P', ['alpha', 'beta']);
  await service.approve(['alpha']);
  const st = await service.gameState('g1');
  assert.equal(st.active, 'P');
  assert.equal(st.canPlay, true);
  assert.deepEqual(st.order, ['alpha', 'beta']);
  assert.deepEqual(st.pendingApproval.map((p) => p.id), ['beta']);
  assert.deepEqual(st.pendingApproval[0].needs.sort(), ['audio', 'game']);
  assert.equal(st.installed.length, 2);
});
