'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, shell, safeStorage, powerMonitor, Menu, nativeTheme, Notification, session, dialog } = require('electron');

app.setName('Pitch');
// Handy for development and automated tests: run against a throwaway profile / a fake GitHub.
if (process.env.PITCH_USER_DATA) app.setPath('userData', process.env.PITCH_USER_DATA);

const { GitHubClient } = require('./github');
const { Settings } = require('./settings');
const { Library } = require('./library');
const { normalizeRepo } = require('./catalog');
const { DiscordClient } = require('./discord');
const { openDiscord } = require('./discord-window');
const { setLoginItem, getLoginItem, createGameShortcut } = require('./autostart');
const { showLoadingSplash } = require('./splash');
const { ModStore } = require('./mods/store');
const { ModService } = require('./mods/service');
const { DiscordPanel } = require('./discord-panel');
const { Updater } = require('./updater');

// pitch.config.json ships with the app: put your catalog repo there ("usuario/pitch-catalog")
// and a Discord application's id there (see README) and every user gets your store and
// Discord integration out of the box, with nothing to configure. It is readable by anyone who
// unpacks the app, so it must never hold a secret (Discord login uses PKCE for that reason).
let shippedConfig = {};
try {
  shippedConfig = require('../../pitch.config.json');
} catch {
  /* optional */
}

// --launch=<id> from a desktop shortcut, or the pitch://launch/<id> protocol.
const HIDDEN_FLAG = process.argv.includes('--hidden');
function launchIdFromArgv(argv) {
  for (const arg of argv) {
    const flag = arg.match(/^--launch=(.+)$/);
    if (flag) return flag[1];
    const proto = arg.match(/^pitch:\/\/launch\/([^/?#]+)/i);
    if (proto) return decodeURIComponent(proto[1]);
  }
  return null;
}

if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('pitch', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('pitch');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const userData = app.getPath('userData');
const gamesDir = path.join(userData, 'games');
fs.mkdirSync(gamesDir, { recursive: true });

// The GitHub token is encrypted with the OS keychain (DPAPI / Keychain / libsecret) when available.
const secrets = safeStorage.isEncryptionAvailable()
  ? {
      secure: true,
      encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
      decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
    }
  : undefined;

const settings = new Settings(path.join(userData, 'settings.json'), secrets, {
  defaultCatalog: typeof shippedConfig.catalog === 'string' ? shippedConfig.catalog.trim() : '',
});
const github = new GitHubClient({
  ...(process.env.PITCH_API_BASE ? { apiBase: process.env.PITCH_API_BASE } : {}),
  getToken: () => settings.getToken(),
  cacheFile: path.join(userData, 'http-cache.json'),
  userAgent: `Pitch/${app.getVersion()}`,
});
const library = new Library({ dataDir: userData, gamesDir, github, settings });

const discord = new DiscordClient({
  clientId: shippedConfig.discordClientId || '',
  getToken: () => settings.getDiscordToken(),
  setToken: (token) => settings.setDiscordToken(token),
  // Only turn this on once Discord has approved relationships.read for this specific
  // application — asking for it beforehand makes Discord reject the whole login.
  requestFriendsScope: shippedConfig.discordRequestFriendsScope === true,
});

let win = null;

function sendToWindow(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Mods: the store (installed mods, per-game profiles, approvals) and the service that decides
// what to inject when a game starts. Nothing here touches a game's own files.
const modStore = new ModStore({ dir: path.join(userData, 'mods'), stateFile: path.join(userData, 'mods-state.json'), pitchVersion: app.getVersion() });
let gamepadsConnected = 0; // reported by Pitch's own window (the Gamepad API lives in the renderer)
const mods = new ModService({
  store: modStore,
  settings,
  notify: (n) => notifyUser(n.message, n.tone),
});

// Discord docked on the side, like Opera GX's sidebar (see discord-panel.js).
const discordPanel = new DiscordPanel({ getWindow: () => win, onChange: (state) => sendToWindow('pitch:discordPanel', state) });

// Shown in Pitch's window, and also as a system notification when Pitch is hidden behind a game.
function notifyUser(message, tone = 'green') {
  sendToWindow('pitch:notice', { kind: 'toast', message, tone });
  const visible = win && !win.isDestroyed() && win.isVisible();
  if (!visible && tone !== 'green' && Notification.isSupported()) new Notification({ title: 'Pitch', body: message }).show();
}

// Pitch updating itself from the GitHub Releases named in package.json (build.publish). Only a
// packaged build checks; `npm start` never touches it. PITCH_NO_SELF_UPDATE=1 turns it off.
function createUpdater() {
  const pub = [].concat((require('../../package.json').build || {}).publish || [])[0] || {};
  const releasesUrl = pub.owner && pub.repo ? `https://github.com/${pub.owner}/${pub.repo}/releases/latest` : '';
  let autoUpdater = null;
  if (app.isPackaged && !process.env.PITCH_NO_SELF_UPDATE) {
    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.logger = null;
    } catch {
      autoUpdater = null;
    }
  }
  // macOS can only replace itself when the app is code-signed; AppImage is the only Linux
  // format that can. Everywhere else the user gets a notice with the download link instead.
  const canInstall =
    process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE) || (process.platform === 'darwin' && shippedConfig.macAutoUpdate === true);
  const u = new Updater({ autoUpdater, version: app.getVersion(), enabled: !!autoUpdater, canInstall, releasesUrl });
  u.on('change', (status) => sendToWindow('pitch:update', status));
  u.on('notice', (n) => notifyUser(n.message, n.tone));
  return u;
}
const updater = createUpdater();

let splash = null;
let refreshTimer = null;
let pushTimer = null;
let pendingLaunchId = launchIdFromArgv(process.argv);
let startedHidden = HIDDEN_FLAG;

function themeColor() {
  const chosen = settings.get().theme;
  const dark = chosen ? chosen === 'dark' : nativeTheme.shouldUseDarkColors;
  return dark ? '#05080c' : '#ffffff';
}

function createWindow({ startHidden = false } = {}) {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    title: 'Pitch',
    backgroundColor: themeColor(),
    autoHideMenuBar: true,
    show: false,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Cmd+Option+I (macOS) / Ctrl+Shift+I (Windows/Linux) opens the inspector, so a problem
  // can be diagnosed on the spot without relaunching from a terminal with a flag set.
  win.webContents.on('before-input-event', (_event, input) => {
    const combo = (process.platform === 'darwin' && input.meta && input.alt) || (process.platform !== 'darwin' && input.control && input.shift);
    if (combo && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.PITCH_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

// Runs a game: hide Pitch, show a small loading splash (like Steam does), and bring
// Pitch back once the game closes.
async function playWithSplash(id) {
  const game = library.findGame(id);
  const theme = settings.get().theme || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  const wasVisible = win && !win.isDestroyed() && win.isVisible();

  // Throws (with a readable message the UI shows) if the chosen mods can't run or still need
  // their permissions approved. For Vanilla with no controller this returns { inject: false }
  // and the game is launched exactly as before, with nothing opened or injected.
  const job = await mods.prepare(id, { gamepadsConnected });

  await library.play(id, {
    extraArgs: job.inject ? job.extraArgs : [],
    onBeforeLaunch: () => {
      splash = showLoadingSplash({ title: game && game.title, cover: game && game.cover, theme });
      if (win && !win.isDestroyed()) win.hide();
    },
    onLaunched: () => {
      // Give the game a moment to draw its own first frame before dropping the splash,
      // so there's no bare-desktop flash between "Pitch disappears" and "game appears".
      setTimeout(() => {
        if (splash && !splash.isDestroyed()) splash.close();
        splash = null;
      }, 2500);
      if (job.inject) startInjection(game, job);
    },
    onExit: () => {
      mods.detach();
      if (splash && !splash.isDestroyed()) splash.close();
      splash = null;
      if (win && !win.isDestroyed() && wasVisible) {
        win.show();
        win.focus();
      }
    },
  });
}

// Runs after the game process is up. Failing here never stops the game: it just keeps running
// without mods/controller support, and the user is told why.
function startInjection(game, job) {
  const title = game ? game.title : 'El juego';
  mods
    .attach(job)
    .then((result) => {
      const parts = [];
      if (result.loaded.length) parts.push(`${result.loaded.length} ${result.loaded.length === 1 ? 'mod activo' : 'mods activos'}`);
      if (result.gamepad) parts.push('mando activado');
      if (parts.length) notifyUser(`${title}: ${parts.join(' · ')}.`, 'green');
      for (const f of result.failed) notifyUser(`El mod ${f.id} no se cargó: ${f.error}`, 'amber');
      for (const w of result.warnings.slice(0, 3)) notifyUser(w, 'amber');
    })
    .catch((err) => notifyUser(`No se pudieron activar los mods ni el mando en ${title}: ${err.message} El juego sigue abierto sin ellos.`, 'amber'));
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('pitch:state', library.snapshot());
}

library.on('change', ({ progress }) => {
  // Download progress can fire hundreds of times per second; the UI only needs a few.
  if (pushTimer) return;
  pushTimer = setTimeout(
    () => {
      pushTimer = null;
      pushState();
    },
    progress ? 150 : 30,
  );
});

library.on('notice', (notice) => {
  if (win && !win.isDestroyed()) win.webContents.send('pitch:notice', notice);
  const focused = win && !win.isDestroyed() && win.isFocused();
  if (!focused && notice.auto && Notification.isSupported()) {
    new Notification({ title: 'Pitch', body: `${notice.title} se ha actualizado a ${notice.tag}.` }).show();
  }
});

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => library.refresh(), settings.get().checkIntervalMinutes * 60 * 1000);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const value = await fn(...args);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function requireId(id) {
  if (typeof id !== 'string' || !id) throw new Error('Juego no válido.');
  return id;
}

handle('pitch:getState', () => library.snapshot());
handle('pitch:refresh', () => {
  library.refresh();
});
handle('pitch:install', (id) => {
  // Fire and forget: progress arrives through pitch:state, errors are stored on the game.
  library.install(requireId(id)).catch(() => {});
});
handle('pitch:cancel', (id) => library.cancel(requireId(id)));
handle('pitch:play', (id) => playWithSplash(requireId(id)));
handle('pitch:uninstall', (id) => library.uninstall(requireId(id)));
handle('pitch:openFolder', async (id) => {
  const dir = library.gameFolder(requireId(id));
  if (!dir) throw new Error('El juego no está instalado.');
  const error = await shell.openPath(dir);
  if (error) throw new Error(error);
});
handle('pitch:openExternal', (url) => {
  const u = new URL(String(url));
  if (u.protocol !== 'https:' || !['github.com', 'discord.com'].includes(u.hostname)) throw new Error('Enlace no permitido.');
  return shell.openExternal(u.toString());
});
handle('pitch:createShortcut', async (id) => {
  const game = library.findGame(requireId(id));
  if (!game) throw new Error('Ese juego no existe.');
  if (!library.installed[id]) throw new Error('Instala el juego antes de crear un acceso directo.');
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  return createGameShortcut({
    app,
    gameId: id,
    title: game.title,
    iconPath: fs.existsSync(iconPath) ? iconPath : null,
  });
});
handle('pitch:getLaunchAtLogin', () => getLoginItem(app));
handle('pitch:setLaunchAtLogin', async (enabled) => {
  await setLoginItem(app, !!enabled);
  settings.update({ launchAtLogin: !!enabled });
});

// ---------- Pitch's own updates ----------

handle('pitch:updateStatus', () => updater.status());
handle('pitch:updateCheck', () => updater.check({ manual: true }));
handle('pitch:updateInstall', () => updater.install());

// ---------- Discord ----------

handle('pitch:discordStatus', () => discord.status());
handle('pitch:discordLink', () => discord.authorize({ openExternal: (u) => shell.openExternal(u) }));
handle('pitch:discordUnlink', () => discord.unlink());
handle('pitch:discordFriends', () => discord.friends());
handle('pitch:discordOpen', () => openDiscord());

// ---------- Discord side panel ----------

handle('pitch:discordPanelToggle', () => discordPanel.toggle());
handle('pitch:discordPanelCall', () => {
  const url = settings.get().discordCallUrl;
  discordPanel.show(url || undefined);
  return { needsSetup: !url };
});
handle('pitch:discordPanelLogout', () => discordPanel.logout());
handle('pitch:discordPanelSuspend', (on) => discordPanel.suspend(!!on));

// ---------- controller ----------

handle('pitch:gamepads', (count) => {
  gamepadsConnected = Math.max(0, Math.min(8, Number(count) || 0));
});

// ---------- mods ----------

const requireIds = (ids) => {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new Error('Lista de mods no válida.');
  return ids;
};
const requireName = (name) => {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Nombre no válido.');
  return name;
};

handle('pitch:modsGameState', (gameId) => mods.gameState(requireId(gameId)));
handle('pitch:modsInstall', async (kind) => {
  const zip = kind === 'zip';
  const picked = await dialog.showOpenDialog(win, {
    title: zip ? 'Elige el archivo .zip del mod' : 'Elige la carpeta del mod',
    properties: zip ? ['openFile'] : ['openDirectory'],
    filters: zip ? [{ name: 'Mod de Pitch (.zip)', extensions: ['zip'] }] : undefined,
  });
  if (picked.canceled || !picked.filePaths.length) return { canceled: true };
  const res = zip ? await modStore.installFromZip(picked.filePaths[0]) : await modStore.installFromFolder(picked.filePaths[0]);
  return { canceled: false, id: res.manifest.id, name: res.manifest.name, version: res.manifest.version, updatedFrom: res.updatedFrom };
});
handle('pitch:modsRemove', (id) => modStore.remove(requireId(id)));
handle('pitch:modsSetProfileMods', ({ gameId, profile, ids } = {}) => modStore.setProfileMods(requireId(gameId), requireName(profile), requireIds(ids)));
handle('pitch:modsCreateProfile', ({ gameId, name, copyFrom } = {}) => modStore.createProfile(requireId(gameId), requireName(name), { copyFrom: typeof copyFrom === 'string' ? copyFrom : null }));
handle('pitch:modsDeleteProfile', ({ gameId, name } = {}) => modStore.deleteProfile(requireId(gameId), requireName(name)));
handle('pitch:modsSetActiveProfile', ({ gameId, name } = {}) => modStore.setActiveProfile(requireId(gameId), requireName(name)));
handle('pitch:modsApprove', (ids) => mods.approve(requireIds(ids)));
handle('pitch:modsOpenFolder', async () => {
  const error = await shell.openPath(modStore.dir);
  if (error) throw new Error(error);
});
discord.on(() => {
  if (win && !win.isDestroyed()) win.webContents.send('pitch:discord', discord.status());
});
handle('pitch:saveSettings', async (patch) => {
  const before = settings.get();
  settings.update(patch || {});
  scheduleRefresh();
  if (before.catalog !== settings.get().catalog || (patch && patch.token !== undefined && patch.token !== null)) {
    library.refresh();
  }
  return library.snapshot();
});
handle('pitch:adminLoad', () => library.adminLoad());
handle('pitch:adminSave', async (payload) => {
  const { catalog, sha } = payload || {};
  const result = await library.adminSave(catalog, sha);
  library.refreshGames().catch(() => {});
  return result;
});
handle('pitch:adminLookup', async (input) => {
  const repo = normalizeRepo(input);
  if (!repo) throw new Error('Escribe el repositorio como usuario/repositorio.');
  const info = await github.repoInfo(repo).catch(() => null);
  if (!info) throw new Error('No se encontró ese repositorio en GitHub.');
  return info;
});

app.on('second-instance', (_event, argv) => {
  const launchId = launchIdFromArgv(argv);
  if (launchId) {
    playWithSplash(launchId).catch(() => {});
    return;
  }
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

// macOS delivers pitch:// links through this event instead of argv.
app.on('open-url', (event, url) => {
  event.preventDefault();
  const id = launchIdFromArgv([url]);
  if (id) app.whenReady().then(() => playWithSplash(id).catch(() => {}));
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  await library.startup();
  createWindow({ startHidden: startedHidden });
  scheduleRefresh();
  library.refresh();
  discord.start();
  updater.start();

  if (pendingLaunchId) {
    const id = pendingLaunchId;
    pendingLaunchId = null;
    library.refresh().finally(() => playWithSplash(id).catch(() => {}));
  }

  powerMonitor.on('resume', () => library.refresh());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (win) win.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  updater.stop();
  discord.stop();
  discordPanel.destroy();
  mods.detach();
});
