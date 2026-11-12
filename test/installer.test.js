'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installAsset } = require('../src/main/installer');

test('extracting reports real progress (files done / total) and installs the game', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-inst-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const src = path.join(root, 'src', 'Game');
  fs.mkdirSync(path.join(src, 'data'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Game.exe'), 'x'.repeat(2048));
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(src, 'data', `f${i}.bin`), String(i));
  const zip = path.join(root, 'game.zip');
  try {
    execFileSync('zip', ['-q', '-r', zip, 'Game'], { cwd: path.join(root, 'src') });
  } catch {
    t.skip('zip no disponible');
    return;
  }
  const size = fs.statSync(zip).size;

  const phases = [];
  const progress = [];
  const result = await installAsset({
    game: { id: 'g' },
    release: { tag: 'v1' },
    asset: { id: 7, name: 'Game-windows.zip', size, downloadUrl: 'http://x/game.zip' },
    gamesDir: path.join(root, 'games'),
    platform: 'win32',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(size) },
      body: require('node:stream').Readable.toWeb(fs.createReadStream(zip)),
    }),
    onPhase: (p) => phases.push(p),
    onProgress: (received, total) => progress.push([received, total]),
  });

  assert.deepEqual(phases, ['downloading', 'extracting']);
  const extracting = progress.filter(([, total]) => total > 0 && total < size); // entry counts, not bytes
  assert.ok(extracting.length > 1, 'debe haber varias actualizaciones de progreso al extraer');
  const last = extracting[extracting.length - 1];
  assert.equal(last[0], last[1], 'termina en 100%');
  assert.ok(fs.existsSync(path.join(root, 'games', result.relDir, 'Game', 'Game.exe')));
});
