'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { selectAdapter } = require('./adapters');
const { MAX_MAIN_BYTES } = require('./manifest');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.json': 'application/json', '.txt': 'text/plain',
};

// Reads a file out of one mod's own folder for the page. The page asks by (modId, relative
// path); anything that resolves outside that folder, goes through a symlink, or is too big
// is refused, so a mod can never read the rest of the disk through Pitch.
async function readModFile(mod, rel) {
  const root = await fsp.realpath(mod.dir);
  const abs = path.resolve(mod.dir, String(rel));
  let real;
  try {
    real = await fsp.realpath(abs);
  } catch {
    return { ok: false, error: `No existe el archivo "${rel}" en el mod.` };
  }
  if (real !== root && !real.startsWith(root + path.sep)) return { ok: false, error: `"${rel}" queda fuera de la carpeta del mod.` };
  const st = await fsp.lstat(abs);
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: `"${rel}" no es un archivo normal.` };
  if (st.size > MAX_FILE_BYTES) return { ok: false, error: `"${rel}" es demasiado grande (máximo 25 MB).` };
  const buf = await fsp.readFile(abs);
  return { ok: true, mime: MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', b64: buf.toString('base64') };
}

function wrapperFor(mod, code) {
  const m = mod.manifest;
  const meta = { id: m.id, name: m.name, version: m.version, permissions: m.permissions };
  const net = m.permissions.includes('network');
  // Shadowing is a best-effort convenience: it stops an honest mod from using the network by
  // accident, it is NOT a security boundary (see MODDING.md). Mod code is a plain script
  // evaluated through the debugger, so it works even when the game's CSP forbids eval.
  return (
    `(function (Pitch, fetch, XMLHttpRequest, WebSocket, require, process) { "use strict";\n${code}\n}).call(undefined, ` +
    `window.__PitchCore.forMod(${JSON.stringify(meta)}), ` +
    `${net ? 'window.fetch.bind(window)' : 'undefined'}, ${net ? 'window.XMLHttpRequest' : 'undefined'}, ${net ? 'window.WebSocket' : 'undefined'}, undefined, undefined);\n` +
    `//# sourceURL=pitch-mod://${m.id}/${m.main}`
  );
}

// Installs the core into an already-connected game and loads `mods` (already resolved and
// ordered by resolver.js) in order. Returns what happened, never throws for a single bad mod:
// one mod failing must not take the others, or the game, down with it.
async function runMods({ session, mods = [], gamepad = null, onReport = () => {} }) {
  const { adapter, detection } = await selectAdapter(session);

  const byId = new Map(mods.map((m) => [m.id, m]));
  const result = { runtime: { adapter: adapter.id, label: adapter.label, flavor: detection.flavor, path: detection.path }, loaded: [], failed: [], warnings: [] };

  await session.onBinding('__pitchReport', (payload) => {
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.type === 'patchConflict') result.warnings.push(`Varios mods interceptan ${msg.path}: ${msg.mods.join(', ')}. El último en cargar prevalece.`);
    onReport(msg);
  });

  await session.onBinding('__pitchReadFile', async (payload) => {
    let req;
    try {
      req = JSON.parse(payload);
    } catch {
      return;
    }
    const mod = byId.get(req.modId);
    let reply;
    try {
      reply = mod ? await readModFile(mod, req.path) : { ok: false, error: 'Mod desconocido.' };
    } catch (err) {
      reply = { ok: false, error: `No se pudo leer el archivo: ${err.message}` };
    }
    try {
      await session.evaluate(`window.__pitchFileReply(${Number(req.id)}, ${JSON.stringify(reply)})`);
    } catch {
      /* game closed while reading */
    }
  });

  await session.evaluate(adapter.coreScript(detection));
  await session.evaluate(adapter.uiScript());
  if (gamepad && gamepad.enabled) await session.evaluate(adapter.gamepadScript(gamepad));
  await session.evaluate('window.__PitchCore.syncStarted()');

  const failedIds = new Set();
  for (const mod of mods) {
    const m = mod.manifest;
    const blocked = Object.keys(m.dependencies).find((d) => failedIds.has(d));
    if (blocked) {
      failedIds.add(m.id);
      result.failed.push({ id: m.id, error: `No se cargó porque "${blocked}" falló.` });
      continue;
    }
    try {
      const file = path.join(mod.dir, m.main);
      if ((await fsp.stat(file)).size > MAX_MAIN_BYTES) throw new Error('El archivo principal es demasiado grande.');
      await session.evaluate(wrapperFor(mod, await fsp.readFile(file, 'utf8')), { awaitPromise: false });
      result.loaded.push(m.id);
    } catch (err) {
      failedIds.add(m.id);
      result.failed.push({ id: m.id, error: err.message });
    }
  }

  return result;
}

module.exports = { runMods, readModFile, wrapperFor };
