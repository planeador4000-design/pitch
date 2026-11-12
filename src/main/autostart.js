'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

// ---------- start Pitch when the user logs in ----------

function setLoginItem(app, enabled) {
  if (process.platform === 'linux') return setLinuxAutostart(app, enabled);
  app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ['--hidden'] : [] });
  return Promise.resolve();
}

function getLoginItem(app) {
  if (process.platform === 'linux') return linuxAutostartEnabled();
  return app.getLoginItemSettings().openAtLogin;
}

function autostartDir() {
  return path.join(os.homedir(), '.config', 'autostart');
}

async function setLinuxAutostart(app, enabled) {
  const file = path.join(autostartDir(), 'pitch.desktop');
  if (!enabled) {
    await fsp.rm(file, { force: true });
    return;
  }
  await fsp.mkdir(autostartDir(), { recursive: true });
  const exec = process.env.APPIMAGE || app.getPath('exe');
  await fsp.writeFile(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Pitch',
      `Exec="${exec}" --hidden`,
      'X-GNOME-Autostart-enabled=true',
      'Terminal=false',
    ].join('\n') + '\n',
  );
}

function linuxAutostartEnabled() {
  try {
    return fs.existsSync(path.join(autostartDir(), 'pitch.desktop'));
  } catch {
    return false;
  }
}

// ---------- desktop shortcuts to a single game ----------

function safeName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 80) || 'Juego';
}

// desktopDir: where to place the shortcut (defaults to the user's Desktop).
async function createGameShortcut({ app, gameId, title, iconPath, desktopDir }) {
  const dir = desktopDir || app.getPath('desktop');
  await fsp.mkdir(dir, { recursive: true });
  const exe = process.env.APPIMAGE || app.getPath('exe');
  const name = safeName(title);

  if (process.platform === 'win32') {
    const file = path.join(dir, `${name}.lnk`);
    // WScript.Shell is the standard, dependency-free way to write a .lnk on Windows.
    const script = `
      $s = New-Object -ComObject WScript.Shell
      $sc = $s.CreateShortcut('${file.replace(/'/g, "''")}')
      $sc.TargetPath = '${exe.replace(/'/g, "''")}'
      $sc.Arguments = '--launch=${gameId}'
      ${iconPath ? `$sc.IconLocation = '${iconPath.replace(/'/g, "''")}'` : ''}
      $sc.Description = 'Abrir ${name.replace(/'/g, "''")} con Pitch'
      $sc.Save()
    `;
    await run('powershell', ['-NoProfile', '-Command', script]);
    return file;
  }

  if (process.platform === 'darwin') {
    // A tiny shell app bundle: no signing needed for a personal launch shortcut.
    const bundle = path.join(dir, `${name}.app`);
    const macos = path.join(bundle, 'Contents', 'MacOS');
    await fsp.mkdir(macos, { recursive: true });
    await fsp.writeFile(path.join(macos, 'run'), `#!/bin/sh\nopen -a "${exe}" --args --launch=${gameId}\n`, { mode: 0o755 });
    await fsp.writeFile(
      path.join(bundle, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>run</string><key>CFBundleName</key><string>${name}</string></dict></plist>\n`,
    );
    if (iconPath && fs.existsSync(iconPath)) {
      await fsp.mkdir(path.join(bundle, 'Contents', 'Resources'), { recursive: true }).catch(() => {});
    }
    return bundle;
  }

  // Linux: a standard .desktop launcher.
  const file = path.join(dir, `${name}.desktop`);
  await fsp.writeFile(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${name}`,
      `Exec="${exe}" --launch=${gameId}`,
      iconPath ? `Icon=${iconPath}` : '',
      'Terminal=false',
      'Categories=Game;',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );
  await fsp.chmod(file, 0o755);
  // Most file managers only treat a .desktop file as launchable (not "untrusted") once
  // it is marked executable and, on GNOME/Nautilus, carries this attribute.
  await run('gio', ['set', file, 'metadata::trusted', 'true']).catch(() => {});
  return file;
}

module.exports = { setLoginItem, getLoginItem, createGameShortcut };
