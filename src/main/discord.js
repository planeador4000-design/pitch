'use strict';

// Talks to the Discord desktop app running on the same machine, over its local IPC
// (a named pipe on Windows, a Unix socket on macOS/Linux) — the same channel Discord
// exposes to any game that wants Rich Presence. No Discord library needed: the
// handshake is a small documented framing protocol on top of that socket.
//
// Two things ride on this connection:
//   - Rich Presence: tell Discord "this user is playing <game>" so it shows up on
//     their profile and to their friends.
//   - Authorization: with the user's consent (an OAuth popup Discord itself draws),
//     get a token scoped to "identify" + "relationships.read" so Pitch can show the
//     signed-in user and their friend list. Pitch never sees the user's Discord
//     password, and the token can't post messages, read DMs, or act as the user.

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RECONNECT_MS = 5000;

class DiscordError extends Error {
  constructor(message, code = 'DISCORD') {
    super(message);
    this.name = 'DiscordError';
    this.code = code;
  }
}

function ipcPath(n) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\discord-ipc-${n}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  return path.join(base, `discord-ipc-${n}`);
}

function encode(op, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

// A tiny framed-message reader over a socket that may deliver frames split or joined.
class FrameReader {
  constructor(onFrame) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 8) return;
      const op = this.buf.readUInt32LE(0);
      const len = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + len) return;
      const body = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);
      let json = null;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        /* malformed frame from a mismatched Discord build: ignore it */
      }
      this.onFrame(op, json);
    }
  }
}

// clientId: create a free application at https://discord.com/developers/applications,
// turn on "Public Client" in its OAuth2 tab, and put its id in pitch.config.json. There is
// no client secret anywhere: login uses PKCE (RFC 7636), which is what makes it safe to ship
// inside a desktop app that anyone can unpack. Without an id, Discord features stay off.
class DiscordClient {
  constructor({ clientId, getToken, setToken, redirectPort = 28914, requestFriendsScope = false } = {}) {
    this.clientId = clientId || '';
    this.getToken = getToken || (() => '');
    this.setToken = setToken || (() => {});
    this.redirectPort = redirectPort;
    this.requestFriendsScope = requestFriendsScope;

    this.socket = null;
    this.reader = null;
    this.ready = false;
    this.user = null; // { id, username, avatarUrl }
    this.pending = new Map(); // nonce -> { resolve, reject }
    this.listeners = new Set();
    this.reconnectTimer = null;
    this.lastActivity = null;
    this.lastError = '';
    this.attempted = 0;
  }

  get configured() {
    return !!this.clientId;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this.status());
  }

  status() {
    return {
      configured: this.configured,
      connected: this.ready,
      user: this.user,
      linked: !!this.getToken(),
      error: this.lastError,
    };
  }

  start() {
    if (!this.configured || this.socket) return;
    this._connect();
  }

  stop() {
    clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.ready = false;
  }

  _connect() {
    this.attempted += 1;
    if (this.attempted > 10) return; // Discord isn't running: stop hammering a socket that doesn't exist.
    let tried = 0;
    const tryPipe = () => {
      const socket = net.createConnection(ipcPath(tried));
      const onError = () => {
        socket.destroy();
        tried += 1;
        if (tried < 10) tryPipe();
        else {
          this.lastError = 'No se encontró Discord en este equipo.';
          this._emit();
          this._scheduleReconnect();
        }
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        this._attach(socket);
      });
    };
    tryPipe();
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), RECONNECT_MS);
  }

  _attach(socket) {
    this.socket = socket;
    this.reader = new FrameReader((op, json) => this._onFrame(op, json));
    socket.on('data', (chunk) => this.reader.push(chunk));
    socket.on('close', () => {
      this.ready = false;
      this.socket = null;
      this._emit();
      this._scheduleReconnect();
    });
    socket.on('error', () => {}); // 'close' follows; avoid an unhandled 'error' crash.
    socket.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
  }

  _onFrame(op, json) {
    if (op === OP.CLOSE) {
      this.socket && this.socket.destroy();
      return;
    }
    if (!json) return;
    if (json.evt === 'READY') {
      this.ready = true;
      this.attempted = 0;
      this.lastError = '';
      this._emit();
      if (this.lastActivity !== null) this._sendActivity(this.lastActivity);
      return;
    }
    if (json.evt === 'ERROR') {
      this.lastError = (json.data && json.data.message) || 'Discord devolvió un error.';
      this._emit();
    }
    if (json.nonce && this.pending.has(json.nonce)) {
      const { resolve, reject } = this.pending.get(json.nonce);
      this.pending.delete(json.nonce);
      if (json.evt === 'ERROR') reject(new DiscordError(this.lastError));
      else resolve(json.data);
    }
  }

  _send(cmd, args) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.ready) return reject(new DiscordError('Discord no está conectado.', 'NOT_READY'));
      const nonce = crypto.randomUUID();
      this.pending.set(nonce, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(nonce)) {
          this.pending.delete(nonce);
          reject(new DiscordError('Discord no respondió a tiempo.', 'TIMEOUT'));
        }
      }, 8000);
      this.socket.write(encode(OP.FRAME, { cmd, args, nonce }));
    });
  }

  // Shows "Playing <title>" on the user's Discord profile. Cleared with clearActivity().
  setActivity({ title, detail, startedAt }) {
    this.lastActivity = { title, detail, startedAt };
    if (this.ready) this._sendActivity(this.lastActivity);
  }

  clearActivity() {
    this.lastActivity = null;
    if (this.ready) this._send('SET_ACTIVITY', { pid: process.pid, activity: null }).catch(() => {});
  }

  _sendActivity({ title, detail, startedAt }) {
    this._send('SET_ACTIVITY', {
      pid: process.pid,
      activity: {
        details: title ? `Jugando a ${title}` : 'En el catálogo',
        state: detail || undefined,
        timestamps: startedAt ? { start: Math.floor(startedAt / 1000) } : undefined,
        assets: { large_image: 'pitch_logo', large_text: 'Pitch' },
      },
    }).catch(() => {});
  }

  // Opens Discord's own consent screen in the user's browser (Authorization Code flow).
  // Discord shows the app name + requested scopes; the user approves or denies it there,
  // never inside Pitch. Returns once Pitch's local callback receives the code and Discord
  // has exchanged it for a token.
  async authorize({ openExternal }) {
    if (!this.configured) throw new DiscordError('Pitch no tiene configurada una app de Discord (pitch.config.json).');
    // A previous call to authorize() that is still waiting (an old consent tab left open
    // somewhere) would otherwise hold the port and make this new attempt fail outright, or
    // have its stray request confused with this one. Cancelling it first means the most
    // recent click always wins.
    if (this._pendingAuth) this._pendingAuth();

    const http = require('node:http');
    const state = crypto.randomBytes(16).toString('hex');
    // PKCE: the verifier never leaves this process until the token exchange; Discord only
    // sees its SHA-256 hash up front, so a stolen authorization code is useless without it.
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const server = http.createServer();
    // The port must be fixed (not random) because it has to exactly match a redirect URI
    // registered on Discord's side — Discord does not allow wildcard ports.
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.redirectPort, '127.0.0.1', resolve);
      });
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        throw new DiscordError(
          `El puerto ${this.redirectPort} ya está en uso (¿tienes otra ventana de Pitch abierta, o una pestaña de un intento anterior?). Cierra ambas e inténtalo de nuevo.`,
          'PORT_IN_USE',
        );
      }
      throw new DiscordError('No se pudo abrir el servidor local para vincular Discord.');
    }
    const redirect = `http://127.0.0.1:${this.redirectPort}/callback`;

    let settled = false;
    const codePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settled = true;
        reject(new DiscordError('No respondiste a la ventana de Discord a tiempo.', 'TIMEOUT'));
      }, 120000);

      this._pendingAuth = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DiscordError('Se inició una nueva vinculación de Discord.', 'SUPERSEDED'));
      };

      server.on('request', (req, res) => {
        const url = new URL(req.url, redirect);
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          return res.end();
        }
        // A browser can fire more than one request at this URL (back/forward cache,
        // prefetch, a stray reload) — only the first one that actually carries Discord's
        // response should be able to resolve or reject this attempt. Anything after that
        // still gets a friendly page, it just no longer affects the result.
        const alreadySettled = settled;
        const code = url.searchParams.get('code');
        const stateOk = url.searchParams.get('state') === state;
        const ok = stateOk && !!code;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#05080c;color:#eafcff">${
            ok
              ? 'Discord respondió correctamente. Vuelve a Pitch: está terminando de vincular la cuenta.'
              : alreadySettled
                ? 'Esta ventana ya no está activa. Puedes cerrarla.'
                : 'Algo no cuadró. Vuelve a Pitch e inténtalo de nuevo.'
          }</body>`,
        );
        if (alreadySettled) return;
        if (!url.searchParams.has('code') && !url.searchParams.has('error') && !url.searchParams.has('state')) {
          return; // Not Discord's response at all (e.g. a bare prefetch of /callback): ignore, keep waiting.
        }
        settled = true;
        clearTimeout(timer);
        if (url.searchParams.get('error')) return reject(new DiscordError('Cancelaste la conexión con Discord.', 'DENIED'));
        if (!ok) return reject(new DiscordError('La respuesta de Discord no es válida.'));
        resolve(code);
      });
    });

    const authUrl = new URL('https://discord.com/oauth2/authorize');
    authUrl.searchParams.set('client_id', this.clientId);
    authUrl.searchParams.set('redirect_uri', redirect);
    authUrl.searchParams.set('response_type', 'code');
    // "identify" works for every Discord app with no approval needed. "relationships.read"
    // (used later by friends()) is restricted — Discord only grants it to specific
    // applications it has reviewed — and asking for it here when it has not been granted
    // makes Discord reject the ENTIRE authorization with invalid_scope, so by default only
    // "identify" is requested. Set requestFriendsScope: true (once Discord has approved
    // relationships.read for this application) to ask for both.
    const scope = this.requestFriendsScope ? 'identify relationships.read' : 'identify';
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    await openExternal(authUrl.toString());

    let code;
    try {
      code = await codePromise;
    } finally {
      if (this._pendingAuth) this._pendingAuth = null;
      server.close();
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      code_verifier: codeVerifier,
    });
    let res;
    try {
      res = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') {
        throw new DiscordError('Discord tardó demasiado en responder. Comprueba tu conexión (un VPN o proxy puede estar bloqueándola) e inténtalo de nuevo.');
      }
      throw new DiscordError('No se pudo conectar con Discord para completar la vinculación. Comprueba tu conexión (un VPN o proxy puede estar bloqueándola) e inténtalo de nuevo.');
    }
    if (!res.ok) {
      let detail = '';
      let kind = '';
      try {
        const body = await res.json();
        detail = body.error_description || '';
        kind = body.error || '';
      } catch {
        /* Discord didn't return JSON this time */
      }
      if (kind === 'invalid_client' || kind === 'unauthorized_client') {
        throw new DiscordError(
          'Discord rechazó la vinculación porque la app no es un cliente público. En discord.com/developers/applications → tu app → OAuth2, activa "Public Client" y guarda.',
          'PUBLIC_CLIENT',
        );
      }
      throw new DiscordError(`Discord no aceptó la conexión (error ${res.status}).${detail ? ` ${detail}` : ''}`);
    }
    const data = await res.json();
    this.setToken({ access: data.access_token, refresh: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 });
    try {
      await this.refreshProfile();
    } catch (err) {
      this.setToken(null); // Don't leave a token saved that we couldn't confirm actually works.
      throw new DiscordError(`Se obtuvo el permiso de Discord, pero no se pudo leer tu perfil: ${err.message}`);
    }
    return this.user;
  }

  unlink() {
    this.setToken(null);
    this.user = null;
    this._emit();
  }

  async _api(pathname) {
    const token = this.getToken();
    if (!token) throw new DiscordError('La cuenta de Discord no está vinculada.', 'NOT_LINKED');
    let res;
    try {
      res = await fetch(`https://discord.com/api/v10${pathname}`, {
        headers: { Authorization: `Bearer ${token.access}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new DiscordError('Discord tardó demasiado en responder. Inténtalo de nuevo.');
      throw new DiscordError('No se pudo conectar con Discord.', 'NETWORK');
    }
    if (res.status === 401) throw new DiscordError('El acceso a Discord caducó. Vuelve a vincular la cuenta.', 'EXPIRED');
    if (!res.ok) {
      const err = new DiscordError(`Discord respondió con el error ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async refreshProfile() {
    const me = await this._api('/users/@me');
    this.user = {
      id: me.id,
      username: me.global_name || me.username,
      avatarUrl: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : '',
    };
    this._emit();
    return this.user;
  }

  // The friends list needs the "relationships.read" OAuth scope, which Discord does not
  // grant to an application by default: it has to be requested and approved for that
  // specific application in the Discord Developer Portal (Discord reviews these by hand).
  // Until pitch.config.json's app has that approval, this fails with FRIENDS_SCOPE and
  // the UI falls back to "open Discord" instead of an inline friends list.
  async friends() {
    if (!this.requestFriendsScope) {
      throw new DiscordError(
        'La lista de amigos no está activada en esta compilación de Pitch (relationships.read necesita que Discord apruebe esta app primero).',
        'FRIENDS_SCOPE',
      );
    }
    let list;
    try {
      list = await this._api('/users/@me/relationships');
    } catch (err) {
      if (err.status === 403 || /scope/i.test(err.message)) {
        throw new DiscordError(
          'Discord aún no ha aprobado a esta app para leer la lista de amigos (relationships.read es un permiso restringido que Discord concede caso por caso).',
          'FRIENDS_SCOPE',
        );
      }
      throw err;
    }
    return list
      .filter((r) => r.type === 1) // 1 = friend, as opposed to a pending or blocked entry
      .map((r) => ({
        id: r.user.id,
        username: r.user.global_name || r.user.username,
        avatarUrl: r.user.avatar ? `https://cdn.discordapp.com/avatars/${r.user.id}/${r.user.avatar}.png?size=64` : '',
        status: (r.presence && r.presence.status) || 'offline',
        activity:
          r.presence && Array.isArray(r.presence.activities) && r.presence.activities[0] ? r.presence.activities[0].name : '',
      }));
  }
}

module.exports = { DiscordClient, DiscordError };
