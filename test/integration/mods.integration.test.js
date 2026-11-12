'use strict';

// Drives the REAL pipeline: a real Chromium running a real TurboWarp scratch-vm game, and
// Pitch's own injector/host talking to it over the Chrome DevTools Protocol, exactly as it
// does with an exported game. Skipped automatically when no Chromium is available.
//
//   PITCH_CHROMIUM=/path/to/chrome npm test
//
// (also found automatically in Playwright's default location)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { connectToGame, findFreePort } = require('../../src/main/mods/injector');
const { runMods } = require('../../src/main/mods/host');
const { ModStore } = require('../../src/main/mods/store');
const { resolveLoadPlan } = require('../../src/main/mods/resolver');

function findChromium() {
  const candidates = [
    process.env.PITCH_CHROMIUM,
    '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}
const CHROMIUM = findChromium();
const SCAFFOLDING = path.join(__dirname, '../../node_modules/@turbowarp/scaffolding/dist/scaffolding-min.js');
const FIXTURE = path.join(__dirname, '../fixtures/game');
const EXAMPLE = path.join(__dirname, '../../mods-example/zombie-expansion');
const skip = !CHROMIUM || !fs.existsSync(SCAFFOLDING) ? 'No hay Chromium o @turbowarp/scaffolding disponible' : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(session, expression, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await session.evaluate(expression);
      if (last) return last;
    } catch {
      /* page not ready yet */
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timeout esperando: ${expression} (último valor: ${last})`);
}

// A fresh browser + game per test, so one test's patches never leak into the next.
async function withGame(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-int-'));
  const server = http.createServer((req, res) => {
    const file = req.url.startsWith('/scaffolding-min.js') ? SCAFFOLDING : path.join(FIXTURE, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const httpPort = server.address().port;
  const debugPort = await findFreePort();
  const browser = spawn(
    CHROMIUM,
    [
      `--remote-debugging-port=${debugPort}`, '--no-sandbox', '--disable-dev-shm-usage', '--headless=new',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${path.join(root, 'profile')}`, `http://127.0.0.1:${httpPort}/`,
    ],
    { stdio: 'ignore' },
  );
  let session;
  const store = new ModStore({ dir: path.join(root, 'mods'), stateFile: path.join(root, 'state.json'), pitchVersion: '0.1.0' });
  t.after(async () => {
    if (session) await session.close().catch(() => {});
    const exited = new Promise((r) => browser.once('exit', r));
    browser.kill('SIGKILL');
    await exited; // Chromium must be gone before its profile folder can be removed
    server.close();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    } catch {
      /* Chromium helper processes can still be flushing their cache; a leftover temp folder must not fail the test */
    }
  });
  session = await connectToGame({ port: debugPort, timeoutMs: 20000 });
  return { session, store, root };
}

// Installs a throwaway mod from source text.
async function makeMod(ctx, id, code, { permissions = ['game'], files = {}, extra = {} } = {}) {
  const dir = path.join(ctx.root, 'src-' + id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ id, name: id, version: '1.0.0', author: 't', description: 't', main: 'main.js', pitchApi: '1.0', permissions, ...extra }));
  fs.writeFileSync(path.join(dir, 'main.js'), code);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  await ctx.store.installFromFolder(dir);
}

async function load(ctx, ids, options = {}) {
  const installed = await ctx.store.scan();
  const plan = resolveLoadPlan({ enabled: ids, installed });
  assert.equal(plan.ok, true, JSON.stringify(plan.problems));
  const reports = [];
  const result = await runMods({ session: ctx.session, mods: plan.order.map((id) => installed.get(id)), onReport: (r) => reports.push(r), ...options });
  return { result, reports, plan };
}

const firstSprite = 'window.vm.runtime.targets.find(t => !t.isStage)';

// ---------------------------------------------------------------------------------------

test('detects the scratch-vm runtime and installs the core without any mod', { skip }, async (t) => {
  const ctx = await withGame(t);
  const { result } = await load(ctx, []);
  assert.equal(result.runtime.adapter, 'scratch-vm');
  assert.match(result.runtime.flavor, /scratch|turbowarp/);
  assert.equal(await ctx.session.evaluate('typeof window.__PitchCore'), 'object');
  assert.equal(await ctx.session.evaluate('typeof window.Pitch'), 'undefined'); // the game's own globals are not touched
});

test('step 1-2: a mod changes a variable and a sprite property while the game keeps running', { skip }, async (t) => {
  const ctx = await withGame(t);
  await makeMod(ctx, 'tweaker', `
    var s = Pitch.sprites.find('Sprite1');
    s.setVariable('score', 5000);
    s.setSize(250);
  `);
  const { result } = await load(ctx, ['tweaker']);
  assert.deepEqual(result.failed, []);
  const score = await ctx.session.evaluate(`${firstSprite}.variables.scoreVarId.value`);
  assert.ok(score >= 5000, `score=${score}`); // the game's own forever-loop keeps incrementing from our value
  assert.equal(await ctx.session.evaluate(`${firstSprite}.size`), 250);
});

test('step 2: Pitch.patch changes a sprite behaviour and is reversible', { skip }, async (t) => {
  const ctx = await withGame(t);
  await makeMod(ctx, 'patcher', `
    window.__unpatch = Pitch.patch('Target.setXY', function (orig) {
      return function (x, y, f) { return orig.call(this, x * 2, y, f); };
    });
  `);
  const { result } = await load(ctx, ['patcher']);
  assert.deepEqual(result.failed, []);
  const move = (x) => ctx.session.evaluate(`(function(){ var t = ${firstSprite}; t.setXY(${x}, 10); return t.x; })()`);
  assert.equal(await move(10), 20);
  await ctx.session.evaluate('window.__unpatch(); undefined');
  assert.equal(await move(10), 10);
});

test('steps 3-5: a mod creates a new entity with an external image the project never had', { skip }, async (t) => {
  const ctx = await withGame(t);
  await makeMod(
    ctx, 'spawner',
    `Pitch.assets.register('zombie', 'assets/zombie.png').then(function () {
       return Pitch.entities.create({ id: 'zombie', sprite: 'zombie', x: 100, y: -50, health: 50, speed: 3 });
     }).then(function (z) { window.__zombie = z; });`,
    { permissions: ['game', 'graphics'], files: { 'assets/zombie.png': fs.readFileSync(path.join(EXAMPLE, 'assets/zombie.png')) } },
  );
  const { result } = await load(ctx, ['spawner']);
  assert.deepEqual(result.failed, []);
  await waitFor(ctx.session, 'window.__zombie && window.__zombie.exists');
  const z = JSON.parse(await ctx.session.evaluate(`JSON.stringify((function () {
    var z = window.__zombie;
    return { name: z.name, x: z.x, y: z.y, health: z.getHealth(), speed: z.getSpeed(), costumes: z.raw.getCostumes().length,
             scripts: z.raw.blocks.getScripts().length, sprites: window.vm.runtime.targets.filter(t => !t.isStage).length };
  })())`));
  assert.equal(z.name, 'zombie');
  assert.equal(z.x, 100);
  assert.equal(z.y, -50);
  assert.equal(z.health, 50);
  assert.equal(z.speed, 3);
  assert.equal(z.costumes, 1, 'the entity looks like the new asset only');
  assert.equal(z.scripts, 0, 'the entity does not inherit the base sprite scripts');
  assert.equal(z.sprites, 2);
});

test('assets.replace swaps the picture but keeps the costume name that scripts refer to', { skip }, async (t) => {
  const ctx = await withGame(t);
  await makeMod(ctx, 'reskin', `Pitch.assets.replace('Sprite1', 'assets/zombie.png').then(function () { window.__done = true; });`, {
    permissions: ['game', 'graphics'], files: { 'assets/zombie.png': fs.readFileSync(path.join(EXAMPLE, 'assets/zombie.png')) },
  });
  const { result } = await load(ctx, ['reskin']);
  assert.deepEqual(result.failed, []);
  await waitFor(ctx.session, 'window.__done === true');
  const names = JSON.parse(await ctx.session.evaluate(`JSON.stringify(${firstSprite}.getCostumes().map(c => c.name))`));
  assert.deepEqual(names, ['costume1']);
  assert.equal(await ctx.session.evaluate(`${firstSprite}.getCostumes()[0].dataFormat`), 'png');
});

test('step 6: a mod builds UI (window, HUD bar, text, button) isolated from the game page', { skip }, async (t) => {
  const ctx = await withGame(t);
  await makeMod(ctx, 'ui-mod', `
    var w = Pitch.ui.createWindow({ title: 'Zombie Expansion', width: 400, height: 300 });
    w.addText('Hola'); w.addButton('Pulsar', function () { window.__clicked = true; });
    Pitch.ui.bar({ x: 10, y: 10, max: 100, value: 40 });
    Pitch.ui.text({ x: 10, y: 30, text: 'HUD' });
  `, { permissions: ['game', 'ui'] });
  const { result } = await load(ctx, ['ui-mod']);
  assert.deepEqual(result.failed, []);
  const ui = JSON.parse(await ctx.session.evaluate(`JSON.stringify((function () {
    var host = document.querySelector('[data-pitch-ui]');
    var root = host.shadowRoot;
    root.querySelector('.win .btn').click();
    return { hasHost: !!host, windows: root.querySelectorAll('.win').length, title: root.querySelector('.bar .t').textContent,
             bars: root.querySelectorAll('.meter').length, texts: root.querySelectorAll('.txt').length,
             gameCanSeeInside: !!document.querySelector('.win'), clicked: window.__clicked === true };
  })())`));
  assert.equal(ui.hasHost, true);
  assert.equal(ui.windows, 1);
  assert.equal(ui.title, 'Zombie Expansion');
  assert.equal(ui.bars, 1);
  assert.ok(ui.texts >= 2);
  assert.equal(ui.gameCanSeeInside, false, 'mod UI is inside a shadow root');
  assert.equal(ui.clicked, true);
});

test('step 7: the complete example mod (zombie-expansion) runs end to end', { skip }, async (t) => {
  const ctx = await withGame(t);
  await ctx.store.installFromFolder(EXAMPLE);
  const { result, reports } = await load(ctx, ['zombie-expansion']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.loaded, ['zombie-expansion']);
  const zombies = `window.vm.runtime.targets.filter(t => !t.isStage && t.sprite.name.indexOf('zombie') === 0)`;
  await waitFor(ctx.session, `${zombies}.length >= 3`);
  await sleep(800); // an overlapping-wave bug would add more zombies right after the first ones
  assert.equal(JSON.parse(await ctx.session.evaluate(`JSON.stringify(${zombies}.length)`)), 3, 'exactly one wave of 3 zombies');
  assert.match(await ctx.session.evaluate(`document.querySelector('[data-pitch-ui]').shadowRoot.textContent`), /Oleada 1\b/);
  const pos = async () => JSON.parse(await ctx.session.evaluate(`JSON.stringify(${zombies}.map(t => [Math.round(t.x), Math.round(t.y)]))`));
  const first = await pos();
  await sleep(1200);
  const later = await pos();
  const dist = (p) => Math.hypot(p[0], p[1]);
  assert.ok(later.length >= 3);
  assert.ok(dist(later[0]) < dist(first[0]), 'zombies chase the player');
  const hud = await ctx.session.evaluate(`document.querySelector('[data-pitch-ui]').shadowRoot.querySelectorAll('.meter, .txt').length`);
  assert.ok(hud >= 2, 'health bar and wave text are on screen');
  assert.equal(reports.filter((r) => r.type === 'modError').length, 0, JSON.stringify(reports.filter((r) => r.type === 'modError')));
});

test('events: gameStart, keyDown, keyUp, broadcast, mouse and variableChanged are delivered', { skip }, async (t) => {
  const ctx = await withGame(t);
  await makeMod(ctx, 'listener', `
    window.__ev = {};
    ['gameStart','keyDown','keyUp','broadcast','variableChanged','mouseDown','mouseUp'].forEach(function (n) {
      Pitch.events.on(n, function (p) { (window.__ev[n] = window.__ev[n] || []).push(p); });
    });
  `);
  const { result } = await load(ctx, ['listener']);
  assert.deepEqual(result.failed, []);
  await ctx.session.evaluate(`
    window.vm.postIOData('keyboard', { key: 'ArrowLeft', isDown: true });
    window.vm.postIOData('keyboard', { key: 'ArrowLeft', isDown: false });
    window.vm.runtime.startHats('event_whenbroadcastreceived', { BROADCAST_OPTION: 'boss' });
    window.vm.postIOData('mouse', { x: 240, y: 180, canvasWidth: 480, canvasHeight: 360, isDown: true });
    window.vm.postIOData('mouse', { x: 240, y: 180, canvasWidth: 480, canvasHeight: 360, isDown: false });
    undefined`);
  await waitFor(ctx.session, `window.__ev.variableChanged && window.__ev.variableChanged.length > 0`, { timeoutMs: 5000 });
  const ev = JSON.parse(await ctx.session.evaluate(`JSON.stringify({
    start: (window.__ev.gameStart || []).length, key: window.__ev.keyDown && window.__ev.keyDown[0],
    up: (window.__ev.keyUp || []).length, bc: window.__ev.broadcast && window.__ev.broadcast[0],
    md: (window.__ev.mouseDown || []).length, mu: (window.__ev.mouseUp || []).length })`));
  assert.ok(ev.start >= 1, 'gameStart reaches a mod that subscribes after the project already started');
  assert.equal(ev.key.scratchKey, 'left arrow');
  assert.equal(ev.up, 1);
  assert.equal(ev.bc.name, 'boss');
  assert.equal(ev.md, 1);
  assert.equal(ev.mu, 1);
});

test('players: Scratch has no "player", so the mod declares it and Pitch derives damage/death from it', { skip }, async (t) => {
  const ctx = await withGame(t);
  await makeMod(ctx, 'hero', `
    window.__p = [];
    var s = Pitch.sprites.find('Sprite1');
    s.setVariable('score', 1000);                       // start with "full health"
    Pitch.players.define({ sprite: 'Sprite1', healthVariable: 'score', deathAt: 100 });
    ['playerSpawn','playerDamage','playerDeath','playerMove'].forEach(function (n) { Pitch.events.on(n, function (e) { window.__p.push(n); }); });
  `);
  const { result } = await load(ctx, ['hero']);
  assert.deepEqual(result.failed, []);
  await ctx.session.evaluate(`${firstSprite}.setXY(30, 30); undefined`);
  await sleep(250);
  await ctx.session.evaluate(`${firstSprite}.variables.scoreVarId.value = 500; undefined`);   // damage, still alive
  await sleep(250);
  assert.equal(JSON.parse(await ctx.session.evaluate('JSON.stringify(window.__p)')).includes('playerDeath'), false, 'not dead at 500');
  await ctx.session.evaluate(`${firstSprite}.variables.scoreVarId.value = 50; undefined`);    // below deathAt
  await waitFor(ctx.session, `window.__p.indexOf('playerDeath') >= 0`, { timeoutMs: 5000 });
  const seen = JSON.parse(await ctx.session.evaluate('JSON.stringify(window.__p)'));
  for (const n of ['playerSpawn', 'playerMove', 'playerDamage', 'playerDeath']) assert.ok(seen.includes(n), `${n} in ${seen}`);
  assert.equal(seen.filter((n) => n === 'playerDeath').length, 1, 'death is reported once');
});

test('pause freezes the frame loop and resume continues it', { skip }, async (t) => {
  const ctx = await withGame(t);
  await makeMod(ctx, 'pauser', `window.__game = Pitch.game;`);
  const { result } = await load(ctx, ['pauser']);
  assert.deepEqual(result.failed, []);
  const score = () => ctx.session.evaluate(`${firstSprite}.variables.scoreVarId.value`);
  await sleep(300);
  await ctx.session.evaluate('window.__game.pause(); undefined');
  const frozen = await score();
  await sleep(1500);
  assert.equal(await score(), frozen);
  assert.equal(await ctx.session.evaluate('window.__game.isPaused()'), true);
  await ctx.session.evaluate('window.__game.resume(); undefined');
  await waitFor(ctx.session, `${firstSprite}.variables.scoreVarId.value > ${frozen}`, { timeoutMs: 4000 });
});

test('permissions: a mod only gets the Pitch namespaces it declared', { skip }, async (t) => {
  const ctx = await withGame(t);
  await makeMod(ctx, 'no-perms', `Pitch.sprites.all();`, { permissions: [] });
  await makeMod(ctx, 'only-ui', `Pitch.storage.get('x');`, { permissions: ['ui'] });
  await makeMod(ctx, 'fine', `Pitch.sprites.all();`, { permissions: ['game'] });
  const { result } = await load(ctx, ['no-perms', 'only-ui', 'fine']);
  assert.deepEqual(result.loaded, ['fine']);
  const err = Object.fromEntries(result.failed.map((f) => [f.id, f.error]));
  assert.match(err['no-perms'], /necesita el permiso "game"/);
  assert.match(err['only-ui'], /necesita el permiso "storage"/);
});

test('a mod that throws does not stop the others, and dependents of a failed mod are skipped', { skip }, async (t) => {
  const ctx = await withGame(t);
  await makeMod(ctx, 'broken', `throw new Error('boom');`);
  await makeMod(ctx, 'needs-broken', `window.__ran = true;`, { extra: { dependencies: { broken: '*' } } });
  await makeMod(ctx, 'independent', `window.__ind = true;`);
  const { result } = await load(ctx, ['independent', 'needs-broken', 'broken']);
  assert.deepEqual(result.loaded, ['independent']);
  assert.equal(result.failed.length, 2);
  assert.match(result.failed.find((f) => f.id === 'broken').error, /boom/);
  assert.match(result.failed.find((f) => f.id === 'needs-broken').error, /"broken" falló/);
  assert.equal(await ctx.session.evaluate('window.__ran'), undefined);
  assert.equal(await ctx.session.evaluate('window.__ind'), true);
});

test('a mod cannot read files outside its own folder through Pitch', { skip }, async (t) => {
  const ctx = await withGame(t);
  fs.writeFileSync(path.join(ctx.root, 'secret.txt'), 'top secret');
  await makeMod(ctx, 'snoop', `
    window.__r = {};
    Pitch.files.readText('../../secret.txt').then(function (t) { window.__r.escape = t; }, function (e) { window.__r.escapeErr = e.message; });
    Pitch.files.readText('data.txt').then(function (t) { window.__r.own = t; });
    Pitch.files.readText('nope.txt').then(null, function (e) { window.__r.missing = e.message; });
  `, { files: { 'data.txt': 'mine' } });
  const { result } = await load(ctx, ['snoop']);
  assert.deepEqual(result.failed, []);
  await waitFor(ctx.session, 'window.__r.own && window.__r.escapeErr && window.__r.missing');
  const r = JSON.parse(await ctx.session.evaluate('JSON.stringify(window.__r)'));
  assert.equal(r.own, 'mine');
  assert.equal(r.escape, undefined);
  assert.match(r.escapeErr, /fuera de la carpeta del mod|No existe/);
  assert.match(r.missing, /No existe el archivo/);
});

test('two mods patching the same function are reported as a conflict', { skip }, async (t) => {
  const ctx = await withGame(t);
  const code = `Pitch.patch('Target.setXY', function (o) { return function (x, y, f) { return o.call(this, x, y, f); }; });`;
  await makeMod(ctx, 'patch-a', code);
  await makeMod(ctx, 'patch-b', code);
  const { result, reports } = await load(ctx, ['patch-a', 'patch-b']);
  assert.deepEqual(result.failed, []);
  assert.ok(reports.some((r) => r.type === 'patchConflict' && r.path === 'Target.setXY'));
  assert.match(result.warnings.join(' '), /Target\.setXY/);
});

test('gamepad: a controller drives the game through its keyboard device (stick, d-pad and buttons)', { skip }, async (t) => {
  const ctx = await withGame(t);
  const gamepad = { enabled: true, stick: 'arrows', deadzone: 0.35, buttons: { a: 'space', b: 'Enter', x: 'z' } };
  await makeMod(ctx, 'keys', `window.__keys = []; Pitch.events.on('keyDown', function (e) { window.__keys.push(e.scratchKey); });`);
  const { result } = await load(ctx, ['keys'], { gamepad });
  assert.deepEqual(result.failed, []);
  // headless Chromium has no controller, so provide a standard-mapping one to navigator.getGamepads()
  await ctx.session.evaluate(`
    window.__pad = { connected: true, id: 'Test Pad', index: 0, mapping: 'standard', axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, function () { return { pressed: false, value: 0 }; }) };
    navigator.getGamepads = function () { return [window.__pad]; };
    undefined`);
  const down = (k) => ctx.session.evaluate(`window.vm.runtime.ioDevices.keyboard.getKeyIsDown(${JSON.stringify(k)})`);
  await ctx.session.evaluate(`window.__pad.axes[0] = -0.9; window.__pad.buttons[0].pressed = true; undefined`);
  await waitFor(ctx.session, `window.vm.runtime.ioDevices.keyboard.getKeyIsDown('left arrow')`, { timeoutMs: 3000 });
  assert.equal(await down('space'), true, 'A -> space');
  assert.equal(await down('right arrow'), false);
  await ctx.session.evaluate(`window.__pad.axes[0] = 0.1; window.__pad.buttons[0].pressed = false; window.__pad.buttons[15].pressed = true; window.__pad.buttons[2].pressed = true; undefined`);
  await waitFor(ctx.session, `window.vm.runtime.ioDevices.keyboard.getKeyIsDown('right arrow')`, { timeoutMs: 3000 });
  assert.equal(await down('left arrow'), false, 'a released stick releases the key');
  assert.equal(await down('space'), false);
  assert.equal(await down('Z'), true, 'X -> z');
  const seen = JSON.parse(await ctx.session.evaluate('JSON.stringify(window.__keys)'));
  assert.ok(seen.includes('left arrow') && seen.includes('right arrow') && seen.includes('space'), `mods also see pad input: ${seen}`);
  await ctx.session.evaluate(`window.__pad.buttons[15].pressed = false; window.__pad.buttons[2].pressed = false; undefined`);
  await waitFor(ctx.session, `!window.vm.runtime.ioDevices.keyboard.getKeyIsDown('right arrow')`, { timeoutMs: 3000 });
});

test('Vanilla: connecting to a game without injecting anything leaves it untouched', { skip }, async (t) => {
  const ctx = await withGame(t);
  assert.equal(await ctx.session.evaluate('typeof window.__PitchCore'), 'undefined');
  assert.equal(await ctx.session.evaluate('document.querySelector("[data-pitch-ui]")'), null);
});

test('sounds: a mod adds a new sound to a sprite and replaces an existing one keeping its name', { skip }, async (t) => {
  const ctx = await withGame(t);
  const wav = fs.readFileSync(path.join(EXAMPLE, 'audio/groan.wav'));
  await makeMod(ctx, 'sound-mod', `
    window.__s = {};
    Pitch.assets.addSound('Sprite1', 'audio/groan.wav', 'groan')
      .then(function () { return Pitch.assets.replaceSound('Sprite1', 'groan', 'audio/groan.wav'); })
      .then(function () { window.__s.done = true; }, function (e) { window.__s.error = e.message; });
  `, { permissions: ['game', 'graphics'], files: { 'audio/groan.wav': wav } });
  const { result } = await load(ctx, ['sound-mod']);
  assert.deepEqual(result.failed, []);
  await waitFor(ctx.session, 'window.__s.done || window.__s.error', { timeoutMs: 10000 });
  const s = JSON.parse(await ctx.session.evaluate('JSON.stringify(window.__s)'));
  assert.equal(s.error, undefined, `sound error: ${s.error}`);
  const names = JSON.parse(await ctx.session.evaluate(`JSON.stringify(${firstSprite}.getSounds().map(x => x.name))`));
  assert.deepEqual(names, ['groan'], 'one sound, same name after the replace');
});
