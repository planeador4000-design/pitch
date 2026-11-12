'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateManifest } = require('../src/main/mods/manifest');
const { resolveLoadPlan } = require('../src/main/mods/resolver');
const { ModStore, VANILLA } = require('../src/main/mods/store');

const base = (over = {}) => ({ id: 'zombie-expansion', name: 'Zombie Expansion', version: '1.0.0', author: 'Roud', description: 'x', main: 'main.js', pitchApi: '1.0', permissions: ['game', 'graphics'], ...over });
const mod = (over = {}) => validateManifest(base(over)).manifest;
const installedOf = (...ms) => new Map(ms.map((m) => [m.id, { manifest: m, errors: [] }]));

test('a complete manifest validates and keeps every field', () => {
  const { manifest, errors } = validateManifest(base({ dependencies: { 'pitch-combat-api': '>=1.2.0' }, category: 'gameplay' }));
  assert.deepEqual(errors, []);
  assert.equal(manifest.category, 'gameplay');
  assert.deepEqual(manifest.dependencies, { 'pitch-combat-api': '>=1.2.0' });
});

test('manifest errors are specific and never throw', () => {
  const bad = validateManifest({ id: 'Bad Id', version: 'nope', pitchApi: '2.0', main: '../evil.js', permissions: ['game', 'teleport', 'system'] });
  assert.equal(bad.manifest, null);
  const text = bad.errors.join('\n');
  assert.match(text, /"id"/);
  assert.match(text, /"name"/);
  assert.match(text, /versión semántica/);
  assert.match(text, /Mod API 2\.0/);
  assert.match(text, /"main"/);
  assert.match(text, /teleport/);
  assert.match(text, /"system" no está disponible/);
  assert.equal(validateManifest(null).manifest, null);
  assert.equal(validateManifest([]).manifest, null);
});

test('a newer minor of the Mod API is refused, an older one is fine', () => {
  assert.equal(validateManifest(base({ pitchApi: '1.1' })).manifest, null);
  assert.ok(validateManifest(base({ pitchApi: '1.0' })).manifest);
});

test('minPitchVersion is checked against the running Pitch', () => {
  assert.equal(validateManifest(base({ minPitchVersion: '2.0.0' }), { pitchVersion: '0.1.0' }).manifest, null);
  assert.ok(validateManifest(base({ minPitchVersion: '0.1.0' }), { pitchVersion: '0.1.0' }).manifest);
});

test('load order: framework -> content -> gameplay -> balance, user order inside a tier', () => {
  const a = mod({ id: 'aaa-balance', category: 'balance' });
  const b = mod({ id: 'bbb-content' });
  const c = mod({ id: 'ccc-framework', category: 'framework' });
  const d = mod({ id: 'ddd-content' });
  const plan = resolveLoadPlan({ enabled: ['ddd-content', 'aaa-balance', 'bbb-content', 'ccc-framework'], installed: installedOf(a, b, c, d) });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.order, ['ccc-framework', 'ddd-content', 'bbb-content', 'aaa-balance']);
});

test('a dependency always loads first, even across tiers', () => {
  const lib = mod({ id: 'combat-api', version: '1.3.0', category: 'balance' });
  const user = mod({ id: 'zombies', category: 'framework', dependencies: { 'combat-api': '>=1.2.0' } });
  const plan = resolveLoadPlan({ enabled: ['zombies', 'combat-api'], installed: installedOf(lib, user) });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.order, ['combat-api', 'zombies']);
});

test('dependency problems are reported precisely, with a fix when it is just disabled', () => {
  const lib = mod({ id: 'combat-api', version: '1.0.0' });
  const user = mod({ id: 'zombies', dependencies: { 'combat-api': '>=1.2.0', ghost: '*' } });
  let plan = resolveLoadPlan({ enabled: ['zombies'], installed: installedOf(lib, user) });
  const codes = plan.problems.map((p) => p.code).sort();
  assert.deepEqual(codes, ['DEP_MISSING', 'DEP_VERSION']);
  assert.equal(plan.ok, false);

  const lib2 = mod({ id: 'combat-api', version: '2.0.0' });
  const user2 = mod({ id: 'zombies', dependencies: { 'combat-api': '>=1.2.0' } });
  plan = resolveLoadPlan({ enabled: ['zombies'], installed: installedOf(lib2, user2) });
  assert.equal(plan.problems[0].code, 'DEP_DISABLED');
  assert.deepEqual(plan.problems[0].fix, { enable: 'combat-api' });
});

test('circular dependencies and declared incompatibilities block the launch', () => {
  const a = mod({ id: 'mod-a', dependencies: { 'mod-b': '*' } });
  const b = mod({ id: 'mod-b', dependencies: { 'mod-a': '*' } });
  assert.ok(resolveLoadPlan({ enabled: ['mod-a', 'mod-b'], installed: installedOf(a, b) }).problems.some((p) => p.code === 'DEP_CYCLE'));

  const c = mod({ id: 'mod-c', incompatibleWith: ['mod-d'] });
  const d = mod({ id: 'mod-d' });
  const plan = resolveLoadPlan({ enabled: ['mod-c', 'mod-d'], installed: installedOf(c, d) });
  assert.equal(plan.ok, false);
  assert.equal(plan.problems[0].code, 'INCOMPATIBLE');
});

test('two mods that modify the same thing produce a warning, not an error', () => {
  const a = mod({ id: 'better-weapons', name: 'Better Weapons', modifies: ['Weapon.damage'] });
  const b = mod({ id: 'weapon-rebalance', name: 'Weapon Rebalance', modifies: ['Weapon.damage'] });
  const plan = resolveLoadPlan({ enabled: ['better-weapons', 'weapon-rebalance'], installed: installedOf(a, b) });
  assert.equal(plan.ok, true);
  assert.equal(plan.problems[0].code, 'CONFLICT');
  assert.match(plan.problems[0].message, /Better Weapons y Weapon Rebalance modifican Weapon\.damage/);
});

test('game and runtime compatibility are enforced', () => {
  const only = mod({ id: 'only-mine', compatibility: { games: ['roud--space-cat'] } });
  assert.equal(resolveLoadPlan({ enabled: ['only-mine'], installed: installedOf(only), gameId: 'other--game' }).ok, false);
  assert.equal(resolveLoadPlan({ enabled: ['only-mine'], installed: installedOf(only), gameId: 'roud--space-cat' }).ok, true);
  const forker = mod({ id: 'forker', compatibility: { runtimes: ['forkphorus'] } });
  assert.equal(resolveLoadPlan({ enabled: ['forker'], installed: installedOf(forker) }).problems[0].code, 'INCOMPATIBLE_RUNTIME');
});

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-mods-'));
  return { root, store: new ModStore({ dir: path.join(root, 'mods'), stateFile: path.join(root, 'state.json'), pitchVersion: '0.1.0' }) };
}
function writeMod(dir, manifest = base(), files = { 'main.js': '// mod' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

test('install from folder copies the mod, and scan lists it', async (t) => {
  const { root, store } = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'src-mod');
  writeMod(src, base(), { 'main.js': 'x', 'assets/zombie.png': 'png' });
  const { manifest } = await store.installFromFolder(src);
  assert.equal(manifest.id, 'zombie-expansion');
  assert.ok(fs.existsSync(path.join(root, 'mods', 'zombie-expansion', 'assets', 'zombie.png')));
  const scanned = await store.scan();
  assert.equal(scanned.get('zombie-expansion').manifest.version, '1.0.0');
});

test('installing a newer version over an old one replaces it and reports the update', async (t) => {
  const { root, store } = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeMod(path.join(root, 'v1'), base({ version: '1.0.0' }));
  writeMod(path.join(root, 'v2'), base({ version: '1.1.0' }));
  await store.installFromFolder(path.join(root, 'v1'));
  const res = await store.installFromFolder(path.join(root, 'v2'));
  assert.equal(res.updatedFrom, '1.0.0');
  assert.equal((await store.scan()).get('zombie-expansion').manifest.version, '1.1.0');
});

test('invalid mods and symlinks are refused before anything is copied', async (t) => {
  const { root, store } = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeMod(path.join(root, 'bad'), base({ id: 'NOPE' }));
  await assert.rejects(store.installFromFolder(path.join(root, 'bad')), /no es válido/);

  writeMod(path.join(root, 'linky'), base());
  fs.symlinkSync('/etc/passwd', path.join(root, 'linky', 'leak.txt'));
  await assert.rejects(store.installFromFolder(path.join(root, 'linky')), /enlace simbólico/);
  assert.equal((await store.scan()).size, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, 'mods')), []); // no half-installed leftovers
});

test('a mod whose main file is missing is listed as broken, not hidden', async (t) => {
  const { root, store } = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeMod(path.join(root, 'mods', 'zombie-expansion'), base(), {});
  const entry = (await store.scan()).get('zombie-expansion');
  assert.equal(entry.manifest, null);
  assert.match(entry.errors.join(' '), /archivo principal/);
});

test('install from zip works with the files at the root or inside one folder', { skip: !require('node:child_process').spawnSync('which', ['zip']).stdout.length }, async (t) => {
  const { root, store } = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeMod(path.join(root, 'pack', 'zombie-expansion'), base());
  require('node:child_process').execFileSync('zip', ['-qr', path.join(root, 'm.zip'), 'zombie-expansion'], { cwd: path.join(root, 'pack') });
  const { manifest } = await store.installFromZip(path.join(root, 'm.zip'));
  assert.equal(manifest.id, 'zombie-expansion');
  await assert.rejects(store.installFromZip(path.join(root, 'nonexistent.zip')), /zip/);
});

test('profiles are per game, Vanilla is protected, and removing a mod cleans every profile', async (t) => {
  const { root, store } = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(store.getProfiles('g1'), { active: VANILLA, profiles: { [VANILLA]: [] } });
  assert.throws(() => store.setProfileMods('g1', VANILLA, ['x']), /Vanilla/);
  assert.throws(() => store.deleteProfile('g1', VANILLA), /Vanilla/);

  store.createProfile('g1', 'Survival');
  store.setProfileMods('g1', 'Survival', ['a', 'b', 'a', 7]);
  assert.deepEqual(store.activeMods('g1'), ['a', 'b']);
  assert.throws(() => store.createProfile('g1', 'survival'), /Ya existe/);
  assert.deepEqual(store.activeMods('g2'), []); // another game is untouched

  writeMod(path.join(root, 'src'), base({ id: 'zombie-expansion' }));
  await store.installFromFolder(path.join(root, 'src'));
  store.setProfileMods('g1', 'Survival', ['zombie-expansion', 'b']);
  await store.remove('zombie-expansion');
  assert.deepEqual(store.activeMods('g1'), ['b']);
  assert.equal(fs.existsSync(path.join(root, 'mods', 'zombie-expansion')), false);

  const reopened = new ModStore({ dir: path.join(root, 'mods'), stateFile: path.join(root, 'state.json') });
  assert.equal(reopened.getProfiles('g1').active, 'Survival'); // persisted
});

test('permissions need approval once, and again only when an update asks for more', () => {
  const { root, store } = tmp();
  const m1 = mod({ permissions: ['game', 'audio'] });
  assert.deepEqual(store.needsApproval(m1).sort(), ['audio', 'game']);
  store.approve(m1);
  assert.equal(store.isApproved(m1), true);
  assert.equal(store.isApproved(mod({ permissions: ['game'] })), true); // fewer is fine
  assert.deepEqual(store.needsApproval(mod({ permissions: ['game', 'audio', 'network'] })), ['network']);
  assert.equal(store.isApproved(mod({ id: 'no-perms', permissions: [] })), true);
  fs.rmSync(root, { recursive: true, force: true });
});
