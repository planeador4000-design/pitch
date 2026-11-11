'use strict';

// Discord inside Pitch, the way Opera GX's sidebar does it: the real Discord web client in a
// web view docked to the side of the window. This is NOT an iframe (Discord refuses to be
// framed, and that is why an iframe could never work): it is a separate top-level web view
// with its own persistent session, so you stay logged in and a voice call keeps running while
// the panel is hidden.
//
// Everything about it is deliberately boxed in:
//   - its own session partition: Discord's cookies/storage never mix with Pitch's
//   - microphone/camera allowed for Discord pages only; every other permission is denied
//   - top-level navigation limited to Discord; any other https link opens in the system browser
//   - no Node, no preload, sandboxed, context-isolated

const { WebContentsView, session, shell, systemPreferences } = require('electron');

const PARTITION = 'persist:pitch-discord';
const DEFAULT_URL = 'https://discord.com/app';
const DISCORD_HOSTS = ['discord.com', 'discordapp.com'];
const PANEL_WIDTH = 400;
const TOP_BAR = 72; // height of Pitch's top bar, which stays above the panel
const ALLOWED_PERMISSIONS = new Set(['media', 'fullscreen', 'notifications', 'clipboard-sanitized-write']);

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

class DiscordPanel {
  constructor({ getWindow, onChange = () => {}, allowedHosts = DISCORD_HOSTS, defaultUrl = DEFAULT_URL, topBar = TOP_BAR, width = PANEL_WIDTH }) {
    this.getWindow = getWindow;
    this.onChange = onChange;
    this.allowedHosts = allowedHosts;
    this.defaultUrl = defaultUrl;
    this.topBar = topBar;
    this.width = width;
    this.view = null;
    this.visible = false;
  }

  isAllowedHost(host) {
    return this.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  _state() {
    return { open: this.visible, width: this.width };
  }

  _create() {
    if (this.view) return this.view;
    const ses = session.fromPartition(PARTITION);

    // A normal browser identity: Discord serves its regular web app to browsers, and an
    // "Electron/..." token in the user agent is the usual reason embedded pages get odd treatment.
    const ua = ses.getUserAgent().replace(/\s?Electron\/\S+/i, '').replace(/\s?Pitch\/\S+/i, '');
    ses.setUserAgent(ua);

    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const ok = ALLOWED_PERMISSIONS.has(permission) && this.isAllowedHost(hostOf(details.requestingUrl || wc.getURL()));
      if (!ok) return callback(false);
      if (permission === 'media' && process.platform === 'darwin') {
        // macOS asks the user for microphone/camera access the first time; wait for that answer.
        const types = (details.mediaTypes || ['audio']).filter((t) => t === 'audio' || t === 'video');
        Promise.all(types.map((t) => systemPreferences.askForMediaAccess(t === 'audio' ? 'microphone' : 'camera').catch(() => false)))
          .then((results) => callback(results.every(Boolean)))
          .catch(() => callback(false));
        return undefined;
      }
      return callback(true);
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && this.isAllowedHost(hostOf(origin || '')));

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false, // keep a call stable while the panel is hidden or Pitch is behind a game
      },
    });
    const wc = view.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (!this.isAllowedHost(hostOf(url))) {
        event.preventDefault();
        if (/^https:\/\//i.test(url)) shell.openExternal(url);
      }
    });

    this.view = view;
    return view;
  }

  layout() {
    const win = this.getWindow();
    if (!this.view || !win || win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    const w = Math.min(this.width, Math.max(0, width - 480));
    this.view.setBounds({ x: width - w, y: this.topBar, width: w, height: Math.max(0, height - this.topBar) });
  }

  // Shows the panel (creating it the first time). With a URL it navigates there, e.g. to a voice channel.
  show(url) {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const created = !this.view;
    const view = this._create();
    if (created) {
      win.contentView.addChildView(view);
      win.on('resize', () => this.layout());
    }
    view.setVisible(true);
    this.visible = true;
    this.layout();
    const target = url || (created ? this.defaultUrl : null);
    if (target && /^https:\/\//i.test(target) && this.isAllowedHost(hostOf(target))) {
      view.webContents.loadURL(target).catch(() => {});
    }
    this.onChange(this._state());
  }

  // Hiding keeps the page alive on purpose: an ongoing call must not drop when the panel is closed.
  hide() {
    if (this.view) this.view.setVisible(false);
    this.visible = false;
    this.onChange(this._state());
  }

  // Temporarily hides the panel without forgetting it was open (a native view is always drawn above
  // the page, so it would cover a dialog opened in Pitch's own window).
  suspend(on) {
    if (this.view && this.visible) this.view.setVisible(!on);
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
    return this.visible;
  }

  // Forgets the Discord login and frees the page (also ends any call).
  async logout() {
    const win = this.getWindow();
    if (this.view) {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(this.view);
      this.view.webContents.close();
      this.view = null;
    }
    this.visible = false;
    await session.fromPartition(PARTITION).clearStorageData().catch(() => {});
    this.onChange(this._state());
  }

  destroy() {
    if (this.view) {
      try {
        this.view.webContents.close();
      } catch {
        /* already closed */
      }
      this.view = null;
    }
    this.visible = false;
  }
}

module.exports = { DiscordPanel, PANEL_WIDTH, TOP_BAR, DISCORD_HOSTS };
