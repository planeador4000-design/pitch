'use strict';

// Keeps Pitch itself up to date from the GitHub Releases of the repo configured under
// build.publish in package.json (planeador4000-design/pitch). This is the app updating,
// not the games: the games have their own flow in library.js.
//
// It wraps electron-updater, which reads the latest*.yml files that electron-builder uploads
// next to each release, downloads the new build in the background and installs it when Pitch
// quits (or right away if the user asks).
//
// Platform reality, so nobody is surprised:
//   - Windows (NSIS installer) and Linux (AppImage): fully automatic.
//   - macOS: Apple only lets an app replace itself if the new build is code-signed. Pitch's
//     builds are unsigned unless you sign them, so by default macOS only gets a notice with a
//     link to the new release. Set "macAutoUpdate": true in pitch.config.json once you sign.
//   - Linux .deb: package managers own those files, so it also gets just the notice.

const { EventEmitter } = require('node:events');

const FIRST_CHECK_MS = 10 * 1000; // let the window come up first
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

class Updater extends EventEmitter {
  constructor({ autoUpdater, version, enabled, canInstall, releasesUrl, intervalMs = CHECK_EVERY_MS } = {}) {
    super();
    this.updater = autoUpdater || null;
    this.version = version || '0.0.0';
    this.enabled = !!enabled && !!autoUpdater;
    this.canInstall = !!canInstall;
    this.releasesUrl = releasesUrl || '';
    this.intervalMs = intervalMs;
    this.timers = [];
    this.current = { state: this.enabled ? 'idle' : 'disabled', version: this.version, newVersion: '', percent: 0, error: '', canInstall: this.canInstall, releasesUrl: this.releasesUrl };
    this._manual = false;
    if (this.enabled) this._wire();
  }

  _wire() {
    const u = this.updater;
    u.autoDownload = this.canInstall;
    u.autoInstallOnAppQuit = this.canInstall;
    u.allowPrerelease = false;
    u.allowDowngrade = false;

    u.on('checking-for-update', () => this._set({ state: 'checking', error: '' }));
    u.on('update-available', (info) => {
      this._set({ state: this.canInstall ? 'downloading' : 'available', newVersion: (info && info.version) || '', percent: 0 });
      // Without self-install (unsigned macOS, .deb) the user has to grab the new build themselves.
      if (!this.canInstall) this.emit('notice', { message: `Hay una versión nueva de Pitch (${this.current.newVersion}). Descárgala desde Ajustes.`, tone: 'green' });
    });
    u.on('update-not-available', () => {
      this._set({ state: 'idle', newVersion: '' });
      if (this._manual) this.emit('notice', { message: 'Pitch ya está en la última versión.', tone: 'green' });
      this._manual = false;
    });
    u.on('download-progress', (p) => this._set({ state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
    u.on('update-downloaded', (info) => {
      this._set({ state: 'ready', newVersion: (info && info.version) || this.current.newVersion, percent: 100 });
      this.emit('notice', { message: `Pitch ${this.current.newVersion} está listo: se instalará al cerrar Pitch, o reinicia desde Ajustes.`, tone: 'green' });
    });
    u.on('error', (err) => {
      const message = friendlyError(err);
      this._set({ state: 'error', error: message });
      // Background checks fail quietly (no internet, GitHub hiccup); only a manual one complains.
      if (this._manual) this.emit('notice', { message: `No se pudo buscar actualizaciones: ${message}`, tone: 'amber' });
      this._manual = false;
    });
  }

  _set(patch) {
    this.current = { ...this.current, ...patch };
    this.emit('change', this.current);
  }

  status() {
    return this.current;
  }

  start() {
    if (!this.enabled) return;
    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => this.check(), this.intervalMs));
    for (const t of this.timers) if (t.unref) t.unref();
  }

  stop() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  // Resolves to the status once the check has been started; the outcome arrives as 'change'.
  async check({ manual = false } = {}) {
    if (!this.enabled) return this.current;
    const busy = ['checking', 'downloading', 'ready'].includes(this.current.state);
    if (busy) return this.current;
    this._manual = manual;
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      // electron-updater also fires 'error', which already updated the state.
      if (this.current.state !== 'error') this._set({ state: 'error', error: friendlyError(err) });
    }
    return this.current;
  }

  // Quits Pitch and installs the downloaded update, relaunching afterwards.
  install() {
    if (!this.enabled || this.current.state !== 'ready') throw new Error('Todavía no hay una actualización descargada.');
    this.updater.quitAndInstall(false, true);
  }
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR/i.test(msg)) return 'Sin conexión con GitHub.';
  if (/404|Cannot find latest|HttpError: 404/i.test(msg)) return 'Todavía no hay ninguna versión publicada en GitHub Releases.';
  if (/rate limit|403/i.test(msg)) return 'GitHub limitó las consultas; se reintentará más tarde.';
  return msg.split('\n')[0].slice(0, 200) || 'Error desconocido.';
}

module.exports = { Updater, friendlyError };
