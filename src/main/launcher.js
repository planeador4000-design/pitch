'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Files that live next to the real executable in an Electron/NW.js export but are not the game.
const HELPER_RE = /(uninstall|unins\d*|crashpad|crashreporter|updater?|vcredist|vc_redist|dxsetup|elevate|helper|chrome-sandbox|xdg-open)/i;
const SKIP_DIRS = new Set(['node_modules', 'resources', 'locales', 'swiftshader', '__macosx', 'lib', 'lib64']);
const MAX_DEPTH = 3;

function listFiles(root, wantDirs) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        if (wantDirs && e.name.toLowerCase().endsWith('.app')) {
          out.push({ rel, abs, name: e.name, depth, size: 0, isApp: true });
          continue; // Never look inside an .app bundle.
        }
        if (depth < MAX_DEPTH) walk(abs, depth + 1);
      } else if (e.isFile() || e.isSymbolicLink()) {
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.isFile()) out.push({ rel, abs, name: e.name, depth, size: st.size, mode: st.mode });
      }
    }
  };
  walk(root, 0);
  return out;
}

const bySizeDesc = (a, b) => b.size - a.size || a.depth - b.depth;

function findUnixEntry(files) {
  const appImage = files.filter((f) => /\.appimage$/i.test(f.name)).sort(bySizeDesc)[0];
  if (appImage) return appImage.rel;

  const candidates = files.filter((f) => {
    if (HELPER_RE.test(f.name)) return false;
    if (/\.(so(\.\d+)*|dll|pak|dat|bin|json|txt|md|png|jpe?g|ico|icns|html|js|css|asar|lic|pdf)$/i.test(f.name)) return false;
    const ext = path.extname(f.name);
    const executable = (f.mode & 0o111) !== 0;
    const looksLikeBinary = ext === '' && f.size > 512 * 1024;
    const isScript = /\.(sh|x86_64|x64|run)$/i.test(f.name) && executable;
    return executable || looksLikeBinary || isScript;
  });
  candidates.sort(bySizeDesc);
  return candidates.length ? candidates[0].rel : null;
}

// Returns the path (relative to `dir`) of the thing Pitch should run, or null.
function findEntry(dir, platform = process.platform) {
  if (platform === 'darwin') {
    const apps = listFiles(dir, true)
      .filter((f) => f.isApp)
      .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
    if (apps.length) return apps[0].rel;
    return findUnixEntry(listFiles(dir, false));
  }

  const files = listFiles(dir, false);
  if (platform === 'win32') {
    const exes = files.filter((f) => /\.exe$/i.test(f.name));
    const preferred = exes.filter((f) => !HELPER_RE.test(f.name)).sort(bySizeDesc);
    const list = preferred.length ? preferred : exes.sort(bySizeDesc);
    return list.length ? list[0].rel : null;
  }
  return findUnixEntry(files);
}

// Zip files created on some systems lose their executable bits; put them back.
function markExecutable(dir, entry, platform = process.platform) {
  if (platform === 'win32') return;
  const chmod = (target) => {
    try {
      fs.chmodSync(target, 0o755);
    } catch {
      /* best effort */
    }
  };
  const full = path.join(dir, entry);
  if (platform === 'darwin' && entry.toLowerCase().endsWith('.app')) {
    const macosDir = path.join(full, 'Contents', 'MacOS');
    try {
      for (const f of fs.readdirSync(macosDir)) chmod(path.join(macosDir, f));
    } catch {
      /* not a standard bundle */
    }
    return;
  }
  chmod(full);
}

function isElectronLayout(dir, entry) {
  try {
    return fs.existsSync(path.join(dir, path.dirname(entry), 'chrome-sandbox'));
  } catch {
    return false;
  }
}

// Starts the game and resolves with the child process once it has actually spawned.
// extraArgs are passed to the game itself (used to open a local debugging port when mods or the
// gamepad layer need to reach inside it). On macOS they go after --args, and -n forces a fresh
// instance, because `open` would otherwise hand them to an already-running copy and drop them.
function launch(dir, entry, { platform = process.platform, noSandbox = false, extraArgs = [] } = {}) {
  const full = path.join(dir, entry);
  let command;
  let args = [];
  let cwd = path.dirname(full);

  if (platform === 'darwin' && full.toLowerCase().endsWith('.app')) {
    // -W keeps `open` alive until the app quits, which lets Pitch track "playing" time.
    command = 'open';
    args = extraArgs.length ? ['-n', '-W', full, '--args', ...extraArgs] : ['-W', full];
    cwd = dir;
  } else {
    command = full;
    if (platform === 'linux' && noSandbox && isElectronLayout(dir, entry)) args.push('--no-sandbox');
    args.push(...extraArgs);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.on('error', () => {});
      child.unref();
      resolve(child);
    });
  });
}

module.exports = { findEntry, markExecutable, launch, listFiles };
