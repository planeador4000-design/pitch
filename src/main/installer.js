'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { kindOf } = require('./assets');
const { findEntry, markExecutable } = require('./launcher');

class InstallError extends Error {
  constructor(message, code = 'INSTALL') {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_').slice(0, 80) || '_';
}

function friendlyFsError(err) {
  if (err && err.code === 'ENOSPC') return new InstallError('No queda espacio en el disco.', 'NO_SPACE');
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
    return new InstallError('Pitch no tiene permiso para escribir en la carpeta de juegos.', 'PERMISSION');
  }
  return err;
}

async function download({ url, headers, dest, expectedSize, expectedSha256, onProgress, signal, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(url, { headers, signal, redirect: 'follow' });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    throw new InstallError('No se pudo conectar para descargar el juego.', 'NETWORK');
  }
  if (!res.ok || !res.body) {
    const e = new InstallError(`La descarga falló (error ${res.status}).`, 'HTTP');
    e.status = res.status;
    throw e;
  }

  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  const hash = crypto.createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      hash.update(chunk);
      if (onProgress) onProgress(received, total);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest), { signal });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    const mapped = friendlyFsError(err);
    if (mapped !== err) throw mapped;
    throw new InstallError('La descarga se interrumpió.', 'NETWORK');
  }

  if (expectedSize && received !== expectedSize) {
    throw new InstallError('El archivo descargado está incompleto. Inténtalo de nuevo.', 'SIZE');
  }
  if (expectedSha256 && hash.digest('hex') !== expectedSha256) {
    throw new InstallError('El archivo descargado no coincide con el publicado en GitHub (SHA-256).', 'CHECKSUM');
  }
  return received;
}

async function extractArchive(kind, file, destDir, assetName, onProgress = () => {}) {
  await fsp.mkdir(destDir, { recursive: true });
  if (kind === 'zip') {
    const extract = require('extract-zip');
    // Reports files extracted so far, so the UI can show a real percentage instead of a
    // spinner that looks identical whether Pitch is working or stuck.
    let done = 0;
    await extract(file, {
      dir: path.resolve(destDir),
      onEntry: (_entry, zipfile) => {
        done += 1;
        if (done === 1 || done % 25 === 0 || done === zipfile.entryCount) onProgress(done, zipfile.entryCount);
      },
    });
  } else if (kind === 'tar') {
    const tar = require('tar');
    await tar.x({ file, cwd: destDir });
  } else {
    // A single portable file (.AppImage / .exe): it is the game.
    const target = path.join(destDir, safeSegment(assetName));
    await fsp.copyFile(file, target);
    await fsp.chmod(target, 0o755);
  }
}

function stripQuarantine(dir) {
  // Best effort and time-boxed: on a big Electron .app (tens of thousands of files) this must
  // never be what keeps an install from finishing. Files fetched by Pitch aren't quarantined anyway.
  return new Promise((resolve) => {
    execFile('xattr', ['-dr', 'com.apple.quarantine', dir], { timeout: 30000 }, () => resolve());
  });
}

async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* file vanished */
        }
      }
    }
  }
  return total;
}

// Installs one release asset into <gamesDir>/<game.id>/<tag>-<assetId>/ and returns
// where it landed. The version folder only appears (via rename) once it is complete,
// so a crash or a cancelled download never leaves a half-installed game behind.
async function installAsset({
  game,
  release,
  asset,
  gamesDir,
  token = '',
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  signal,
  onPhase = () => {},
  onProgress = () => {},
}) {
  const kind = kindOf(asset.name);
  if (!kind) throw new InstallError(`Pitch no sabe instalar "${asset.name}". Publica el juego como .zip.`, 'UNSUPPORTED');

  const relDir = path.join(safeSegment(game.id), `${safeSegment(release.tag)}-${asset.id}`);
  const finalDir = path.join(gamesDir, relDir);
  const tmpRoot = path.join(gamesDir, '.tmp');
  const stamp = `${safeSegment(game.id)}-${Date.now()}`;
  const partFile = path.join(tmpRoot, `${stamp}.part`);
  const stagingDir = path.join(tmpRoot, `${stamp}.dir`);

  try {
    await fsp.mkdir(tmpRoot, { recursive: true });

    onPhase('downloading');
    const expectedSha256 = asset.digest && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : '';
    const common = { dest: partFile, expectedSize: asset.size, expectedSha256, onProgress, signal, fetchImpl };
    try {
      await download({ ...common, url: asset.downloadUrl, headers: { 'User-Agent': 'Pitch', Accept: 'application/octet-stream' } });
    } catch (err) {
      // Private repos: the public download link is a 404 without auth, the API link works with a token.
      if (err.status === 404 && token && asset.apiUrl) {
        await download({
          ...common,
          url: asset.apiUrl,
          headers: { 'User-Agent': 'Pitch', Accept: 'application/octet-stream', Authorization: `Bearer ${token}` },
        });
      } else {
        throw err;
      }
    }

    onPhase('extracting');
    onProgress(0, 0);
    await extractArchive(kind, partFile, stagingDir, asset.name, onProgress);
    if (platform === 'darwin') await stripQuarantine(stagingDir);

    const entry = findEntry(stagingDir, platform);
    if (!entry) {
      throw new InstallError('No se encontró ningún ejecutable dentro del archivo del juego para este sistema.', 'NO_ENTRY');
    }
    markExecutable(stagingDir, entry, platform);
    const size = await dirSize(stagingDir);

    await fsp.mkdir(path.dirname(finalDir), { recursive: true });
    await fsp.rm(finalDir, { recursive: true, force: true });
    await fsp.rename(stagingDir, finalDir);
    return { relDir, entry, size };
  } catch (err) {
    throw friendlyFsError(err);
  } finally {
    await fsp.rm(partFile, { force: true }).catch(() => {});
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { installAsset, download, InstallError, safeSegment };
