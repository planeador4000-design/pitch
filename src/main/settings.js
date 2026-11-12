'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseCatalogSource, normalizeGame, CatalogError } = require('./catalog');

const DEFAULTS = {
  catalog: '',
  theme: '', // '' = follow the system until the user picks one
  autoUpdate: true,
  checkIntervalMinutes: 30,
  linuxNoSandbox: true,
  launchAtLogin: false,
  // Controller -> keyboard translation (applied inside games that Pitch can reach, see mods/page/gamepad.js).
  gamepad: { enabled: true, stick: 'arrows', deadzone: 0.35, buttons: { a: 'space', b: 'Enter', x: 'z', y: 'x', lb: 'q', rb: 'e', start: 'Enter' } },
  // A https://discord.com/channels/... link to the voice channel or DM the "Llamada" button opens.
  discordCallUrl: '',
  customGames: [],
};

const PAD_BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'back', 'start'];
const NAMED_KEYS = ['space', 'enter', 'up', 'down', 'left', 'right'];

function cleanKey(value) {
  const k = String(value === undefined || value === null ? '' : value).trim();
  if (NAMED_KEYS.includes(k.toLowerCase())) return k.toLowerCase() === 'enter' ? 'Enter' : k.toLowerCase();
  return k.length === 1 ? k.toLowerCase() : '';
}

function cleanGamepad(raw) {
  const d = DEFAULTS.gamepad;
  const src = raw && typeof raw === 'object' ? raw : {};
  const dz = Number(src.deadzone);
  const buttons = {};
  const given = src.buttons && typeof src.buttons === 'object' ? src.buttons : d.buttons;
  for (const name of PAD_BUTTONS) {
    if (name in given) {
      const key = cleanKey(given[name]);
      if (key) buttons[name] = key; // an empty/invalid value simply leaves that button unmapped
    }
  }
  return {
    enabled: src.enabled !== false,
    stick: src.stick === 'wasd' ? 'wasd' : 'arrows',
    deadzone: Number.isFinite(dz) ? Math.min(0.9, Math.max(0.1, dz)) : d.deadzone,
    buttons,
  };
}

function cleanCallUrl(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new CatalogError('El enlace de la llamada no es válido. Copia el enlace del canal desde Discord.');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'discord.com' || !/^\/channels\/(@me|\d+)\/\d+\/?$/.test(u.pathname)) {
    throw new CatalogError('Usa un enlace de canal de Discord, del tipo https://discord.com/channels/123.../456...');
  }
  return u.toString();
}

const identityCrypto = { encrypt: (s) => Buffer.from(s, 'utf8').toString('base64'), decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'), secure: false };

class Settings {
  // `secrets` = { encrypt(str) -> base64 str, decrypt(base64 str) -> str, secure: bool }
  constructor(file, secrets = identityCrypto, { defaultCatalog = '' } = {}) {
    this.file = file;
    this.secrets = secrets;
    this.defaultCatalog = defaultCatalog;
    this.data = { ...DEFAULTS };
    this.token = '';
    this._load();
  }

  _load() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* first run */
    }
    this.data = {
      catalog: typeof raw.catalog === 'string' ? raw.catalog : DEFAULTS.catalog,
      theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : '',
      autoUpdate: raw.autoUpdate !== false,
      checkIntervalMinutes: clampInterval(raw.checkIntervalMinutes),
      linuxNoSandbox: raw.linuxNoSandbox !== false,
      launchAtLogin: raw.launchAtLogin === true,
      gamepad: cleanGamepad(raw.gamepad),
      discordCallUrl: (() => { try { return cleanCallUrl(raw.discordCallUrl); } catch { return ''; } })(),
      customGames: Array.isArray(raw.customGames) ? raw.customGames.map(normalizeGame).filter(Boolean) : [],
    };
    if (typeof raw.tokenEnc === 'string' && raw.tokenEnc) {
      try {
        this.token = this.secrets.decrypt(raw.tokenEnc);
      } catch {
        this.token = ''; // Encrypted on another machine or keyring reset.
      }
    }
    this.discordToken = null;
    if (typeof raw.discordTokenEnc === 'string' && raw.discordTokenEnc) {
      try {
        this.discordToken = JSON.parse(this.secrets.decrypt(raw.discordTokenEnc));
      } catch {
        this.discordToken = null;
      }
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const out = { ...this.data };
    if (this.token) out.tokenEnc = this.secrets.encrypt(this.token);
    if (this.discordToken) out.discordTokenEnc = this.secrets.encrypt(JSON.stringify(this.discordToken));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get() {
    return {
      ...this.data,
      catalog: this.data.catalog || this.defaultCatalog,
      customGames: this.data.customGames.map((g) => ({ ...g })),
    };
  }

  getToken() {
    return this.token;
  }

  // What the renderer is allowed to see: never the token itself.
  publicView() {
    return { ...this.get(), hasToken: !!this.token, tokenSecure: !!this.secrets.secure };
  }

  update(patch = {}) {
    const next = { ...this.data };
    if ('catalog' in patch) {
      const value = String(patch.catalog || '').trim();
      if (value) parseCatalogSource(value); // throws CatalogError when invalid
      next.catalog = value;
    }
    if ('theme' in patch) next.theme = patch.theme === 'light' || patch.theme === 'dark' ? patch.theme : '';
    if ('autoUpdate' in patch) next.autoUpdate = !!patch.autoUpdate;
    if ('checkIntervalMinutes' in patch) next.checkIntervalMinutes = clampInterval(patch.checkIntervalMinutes);
    if ('linuxNoSandbox' in patch) next.linuxNoSandbox = !!patch.linuxNoSandbox;
    if ('launchAtLogin' in patch) next.launchAtLogin = !!patch.launchAtLogin;
    if ('gamepad' in patch) next.gamepad = cleanGamepad(patch.gamepad);
    if ('discordCallUrl' in patch) next.discordCallUrl = cleanCallUrl(patch.discordCallUrl);
    if ('token' in patch && patch.token !== undefined) {
      // '' clears the token, null leaves it alone.
      if (patch.token !== null) this.token = String(patch.token).trim();
    }
    this.data = next;
    this._save();
  }

  getDiscordToken() {
    return this.discordToken;
  }

  setDiscordToken(token) {
    this.discordToken = token || null;
    this._save();
  }

  addCustomGame(game) {
    const normalized = normalizeGame(game);
    if (!normalized) throw new CatalogError('Escribe el repositorio como usuario/repositorio.');
    if (this.data.customGames.some((g) => g.id === normalized.id || g.repo.toLowerCase() === normalized.repo.toLowerCase())) {
      throw new CatalogError('Ese juego ya está en tu lista.');
    }
    this.data.customGames.push(normalized);
    this._save();
    return normalized;
  }

  removeCustomGame(id) {
    const before = this.data.customGames.length;
    this.data.customGames = this.data.customGames.filter((g) => g.id !== id);
    if (this.data.customGames.length !== before) this._save();
  }
}

function clampInterval(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULTS.checkIntervalMinutes;
  return Math.min(1440, Math.max(5, n));
}

module.exports = { Settings, DEFAULTS };
