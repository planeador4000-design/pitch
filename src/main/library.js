'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pickAsset, platformLabel } = require('./assets');
const { installAsset } = require('./installer');
const launcher = require('./launcher');
const { normalizeGame, normalizeCatalog, prettifyRepoName, parseCatalogSource } = require('./catalog');
const { RateLimitError } = require('./github');

const COVER_ASSET_RE = /^(cover|banner|icon)\.(png|jpe?g|webp)$/i;
const QUICK_EXIT_MS = 4000;

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

class Library extends EventEmitter {
  constructor({ dataDir, gamesDir, github, settings, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch }) {
    super();
    this.dataDir = dataDir;
    this.gamesDir = gamesDir;
    this.github = github;
    this.settings = settings;
    this.platform = platform;
    this.arch = arch;
    this.fetch = fetchImpl;

    this.stateFile = path.join(dataDir, 'library.json');
    this.catalogFile = path.join(dataDir, 'catalog-cache.json');
    this.installed = readJson(this.stateFile, {}); // id -> installation record
    this.catalog = readJson(this.catalogFile, { name: '', games: [] });

    this.remote = {}; // id -> latest release info (in memory only)
    this.jobs = {}; // id -> running install/update
    this.running = new Map(); // id -> { child, startedAt }
    this.errors = {}; // id -> last error message for the UI
    this.sync = { checking: false, lastCheckedAt: null, error: '', catalogError: '', retryAt: null };
    this.admin = { canEdit: false, repo: '', file: '' };
    this.catalogFreshUntil = 0; // after publishing, keep our own copy (raw.githubusercontent.com lags a few minutes)
    this.refreshing = null;
  }

  // ---------- catalog / list ----------

  games() {
    const list = [...this.catalog.games];
    const ids = new Set(list.map((g) => g.id));
    for (const custom of this.settings.get().customGames) {
      const g = normalizeGame(custom);
      if (g && !ids.has(g.id)) {
        list.push({ ...g, custom: true });
        ids.add(g.id);
      }
    }
    // Games that were installed from a catalog that no longer lists them stay playable.
    for (const inst of Object.values(this.installed)) {
      if (!ids.has(inst.id)) {
        list.push({
          id: inst.id,
          repo: inst.repo,
          title: inst.title || prettifyRepoName(String(inst.repo).split('/')[1]),
          author: inst.author || String(inst.repo).split('/')[0],
          description: '',
          tags: [],
          cover: '',
          channel: 'stable',
          assets: {},
          orphan: true,
        });
      }
    }
    return list;
  }

  findGame(id) {
    return this.games().find((g) => g.id === id) || null;
  }

  async loadCatalog() {
    const source = this.settings.get().catalog;
    this.sync.catalogError = '';
    if (!source) {
      this.catalog = { name: '', games: [] };
      return;
    }
    if (Date.now() < this.catalogFreshUntil) return;
    try {
      this.catalog = await this.github.fetchCatalog(source);
      await this._write(this.catalogFile, this.catalog);
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      this.sync.catalogError = err.message; // Keep showing the last catalog we managed to download.
    }
  }

  // ---------- admin panel (edits catalog.json in the catalog repo through the GitHub API) ----------

  _catalogTarget() {
    let parsed = null;
    try {
      parsed = parseCatalogSource(this.settings.get().catalog);
    } catch {
      parsed = null;
    }
    return parsed && parsed.repo ? { repo: `${parsed.owner}/${parsed.repo}`, file: parsed.file, ref: parsed.ref } : null;
  }

  async checkAdmin() {
    const target = this._catalogTarget();
    let canEdit = false;
    if (target && this.settings.getToken()) {
      try {
        canEdit = await this.github.canPush(target.repo);
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        canEdit = false;
      }
    }
    this.admin = { canEdit, repo: target ? target.repo : '', file: target ? target.file : '' };
  }

  _requireAdmin() {
    const target = this._catalogTarget();
    if (!target || !this.admin.canEdit) throw new Error('Este panel es solo para administradores: añade en Ajustes un token con permiso de escritura en el catálogo.');
    return target;
  }

  async adminLoad() {
    const target = this._requireAdmin();
    const file = await this.github.getFile(target.repo, target.file, target.ref);
    if (!file) return { catalog: { name: 'Catálogo', games: [] }, sha: null };
    let catalog;
    try {
      catalog = JSON.parse(file.text);
    } catch {
      throw new Error('El catalog.json del repositorio no es un JSON válido. Corrígelo en GitHub antes de usar el panel.');
    }
    if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.games)) catalog = { name: (catalog && catalog.name) || 'Catálogo', games: [] };
    return { catalog, sha: file.sha };
  }

  async adminSave(rawCatalog, sha) {
    const target = this._requireAdmin();
    const normalized = normalizeCatalog(rawCatalog); // throws when there is no games list
    const ids = new Set();
    rawCatalog.games.forEach((entry, i) => {
      const g = normalizeGame(entry);
      if (!g) throw new Error(`El juego número ${i + 1} no tiene un repositorio válido (usuario/repositorio).`);
      if (ids.has(g.id)) throw new Error(`Hay dos juegos con el mismo identificador (${g.id}).`);
      ids.add(g.id);
    });
    const text = `${JSON.stringify(rawCatalog, null, 2)}\n`;
    const result = await this.github.putFile(target.repo, target.file, {
      text,
      sha: sha || undefined,
      ref: target.ref,
      message: 'Actualizar el catálogo desde Pitch',
    });
    this.catalog = normalized;
    this.catalogFreshUntil = Date.now() + 6 * 60 * 1000;
    await this._write(this.catalogFile, this.catalog);
    this._changed();
    return { sha: result.sha };
  }

  // Re-checks release info for every game without re-downloading the catalog.
  async refreshGames() {
    await mapLimit(this.games(), 4, (g) => this.checkGame(g));
    this._changed();
  }

  // ---------- version checks ----------

  async checkGame(game) {
    const previous = this.remote[game.id];
    try {
      const release = await this.github.latestRelease(game.repo, { prerelease: game.channel === 'prerelease' });
      const checkedAt = Date.now();
      if (!release) {
        this.remote[game.id] = { checkedAt, release: null, asset: null, reason: 'Todavía no hay versiones publicadas de este juego.' };
        return;
      }
      const asset = pickAsset(release.assets, { platform: this.platform, arch: this.arch, patterns: game.assets });
      const coverAsset = release.assets.find((a) => COVER_ASSET_RE.test(a.name));
      this.remote[game.id] = {
        checkedAt,
        release,
        asset,
        cover: game.cover || (coverAsset ? coverAsset.downloadUrl : ''),
        reason: asset ? '' : `Este juego aún no tiene versión para ${platformLabel(this.platform, this.arch)}.`,
      };
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      this.remote[game.id] = { ...(previous || {}), error: err.message };
    }
  }

  hasUpdate(id) {
    const inst = this.installed[id];
    const rem = this.remote[id];
    if (!inst || !rem || !rem.release || !rem.asset) return false;
    return rem.release.tag !== inst.tag || rem.asset.id !== inst.assetId;
  }

  refresh() {
    if (!this.refreshing) {
      this.refreshing = this._refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async _refresh() {
    this.sync = { ...this.sync, checking: true, error: '', retryAt: null };
    this._changed();
    try {
      await this.loadCatalog();
      await this.checkAdmin();
      await mapLimit(this.games(), 4, (g) => this.checkGame(g));
      this.sync.lastCheckedAt = Date.now();
      this._changed();
      if (this.settings.get().autoUpdate) await this.autoUpdate();
    } catch (err) {
      this.sync.error = err.message;
      if (err instanceof RateLimitError) this.sync.retryAt = err.resetAt;
    } finally {
      this.sync.checking = false;
      this._changed();
    }
  }

  async autoUpdate() {
    for (const game of this.games()) {
      if (this.jobs[game.id] || !this.hasUpdate(game.id)) continue;
      try {
        await this.install(game.id, { auto: true });
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        /* the error is stored in this.errors[game.id] and shown next to the game */
      }
    }
  }

  // ---------- install / update / uninstall ----------

  async install(id, { auto = false } = {}) {
    if (this.jobs[id]) return;
    const game = this.findGame(id);
    if (!game) throw new Error('Ese juego ya no está en la lista.');

    const kind = this.installed[id] ? 'update' : 'install';
    const controller = new AbortController();
    const job = { kind, phase: 'preparing', received: 0, total: 0, controller };
    this.jobs[id] = job;
    delete this.errors[id];
    this._changed();

    try {
      await this.checkGame(game); // Always work from the freshest release information.
      const rem = this.remote[id];
      if (!rem || !rem.release) throw new Error((rem && (rem.reason || rem.error)) || 'No hay ninguna versión publicada.');
      if (!rem.asset) throw new Error(rem.reason);

      const result = await installAsset({
        game,
        release: rem.release,
        asset: rem.asset,
        gamesDir: this.gamesDir,
        token: this.settings.getToken(),
        platform: this.platform,
        fetchImpl: this.fetch,
        signal: controller.signal,
        onPhase: (phase) => {
          job.phase = phase;
          this._changed();
        },
        onProgress: (received, total) => {
          job.received = received;
          job.total = total;
          this._changed(true);
        },
      });

      const previous = this.installed[id];
      this.installed[id] = {
        id,
        repo: game.repo,
        title: game.title,
        author: game.author,
        tag: rem.release.tag,
        assetId: rem.asset.id,
        assetName: rem.asset.name,
        dir: result.relDir,
        entry: result.entry,
        size: result.size,
        installedAt: Date.now(),
        lastPlayedAt: previous ? previous.lastPlayedAt : null,
        playtimeSec: previous ? previous.playtimeSec : 0,
      };
      await this._write(this.stateFile, this.installed);
      await this.cleanupOldVersions(id);
      this.emit('notice', { kind: kind === 'update' ? 'updated' : 'installed', id, title: game.title, tag: rem.release.tag, auto });
    } catch (err) {
      if (controller.signal.aborted) return; // Cancelled by the user: not an error.
      this.errors[id] = err.message || 'No se pudo instalar el juego.';
      throw err;
    } finally {
      delete this.jobs[id];
      this._changed();
    }
  }

  cancel(id) {
    const job = this.jobs[id];
    if (job) job.controller.abort();
  }

  async uninstall(id) {
    if (this.jobs[id]) throw new Error('Espera a que termine la descarga o cancélala.');
    if (this.running.has(id)) throw new Error('Cierra el juego antes de desinstalarlo.');
    await fsp.rm(path.join(this.gamesDir, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    delete this.installed[id];
    delete this.errors[id];
    await this._write(this.stateFile, this.installed);
    this._changed();
  }

  async cleanupOldVersions(id) {
    if (this.running.has(id)) return; // Old files stay until the game closes.
    const inst = this.installed[id];
    if (!inst) return;
    const gameDir = path.join(this.gamesDir, id);
    const keep = path.basename(inst.dir);
    let names;
    try {
      names = await fsp.readdir(gameDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name !== keep) await fsp.rm(path.join(gameDir, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  async startup() {
    await fsp.rm(path.join(this.gamesDir, '.tmp'), { recursive: true, force: true }).catch(() => {});
    for (const id of Object.keys(this.installed)) await this.cleanupOldVersions(id);
  }

  // ---------- play ----------

  // `hooks` lets the UI layer hide Pitch's window, show a loading splash, and restore
  // the window once the game exits — none of which the library itself knows how to do.
  async play(id, hooks = {}) {
    const { onBeforeLaunch = () => {}, onLaunched = () => {}, onExit = () => {}, extraArgs = [] } = hooks;
    const inst = this.installed[id];
    if (!inst) throw new Error('Instala el juego antes de jugar.');
    if (this.running.has(id)) return;
    delete this.errors[id];

    const dir = path.join(this.gamesDir, inst.dir);
    let entry = inst.entry;
    if (!fs.existsSync(path.join(dir, entry))) entry = launcher.findEntry(dir, this.platform);
    if (!entry) {
      this.errors[id] = 'No se encuentra el ejecutable del juego. Desinstálalo e instálalo de nuevo.';
      this._changed();
      throw new Error(this.errors[id]);
    }

    onBeforeLaunch();
    let child;
    try {
      child = await launcher.launch(dir, entry, { platform: this.platform, noSandbox: this.settings.get().linuxNoSandbox, extraArgs });
    } catch (err) {
      this.errors[id] = `No se pudo abrir el juego (${err.code || err.message}).`;
      this._changed();
      onExit({ error: true });
      throw new Error(this.errors[id]);
    }

    const startedAt = Date.now();
    this.running.set(id, { child, startedAt });
    inst.lastPlayedAt = startedAt;
    this._write(this.stateFile, this.installed).catch(() => {});
    this._changed();
    onLaunched();

    child.once('exit', (code) => {
      const elapsed = Date.now() - startedAt;
      this.running.delete(id);
      const record = this.installed[id];
      if (record) {
        record.playtimeSec = (record.playtimeSec || 0) + Math.round(elapsed / 1000);
        this._write(this.stateFile, this.installed).catch(() => {});
      }
      if (code && elapsed < QUICK_EXIT_MS) {
        this.errors[id] = `El juego se cerró nada más abrirse (código ${code}).`;
      }
      this.cleanupOldVersions(id).catch(() => {});
      this._changed();
      onExit({ error: false, quick: elapsed < QUICK_EXIT_MS && !!code });
    });
  }

  gameFolder(id) {
    const inst = this.installed[id];
    return inst ? path.join(this.gamesDir, inst.dir) : null;
  }

  // ---------- snapshot for the UI ----------

  view(game) {
    const inst = this.installed[game.id];
    const rem = this.remote[game.id];
    const job = this.jobs[game.id];
    const run = this.running.get(game.id);
    return {
      id: game.id,
      repo: game.repo,
      title: game.title,
      author: game.author,
      description: game.description,
      tags: game.tags,
      cover: (rem && rem.cover) || game.cover || '',
      banner: game.banner || '',
      featured: !!game.featured,
      custom: !!game.custom,
      orphan: !!game.orphan,
      installed: inst
        ? { tag: inst.tag, installedAt: inst.installedAt, lastPlayedAt: inst.lastPlayedAt, playtimeSec: inst.playtimeSec || 0, size: inst.size || 0 }
        : null,
      latest:
        rem && rem.release
          ? {
              tag: rem.release.tag,
              name: rem.release.name,
              notes: rem.release.notes,
              publishedAt: rem.release.publishedAt,
              url: rem.release.url,
              assetName: rem.asset ? rem.asset.name : '',
              assetSize: rem.asset ? rem.asset.size : 0,
            }
          : null,
      updateAvailable: this.hasUpdate(game.id),
      running: !!run,
      busy: job ? { kind: job.kind, phase: job.phase, received: job.received, total: job.total } : null,
      error: this.errors[game.id] || '',
      unavailable: !inst && rem && !rem.asset && !job ? rem.reason || '' : '',
      checkError: rem && rem.error ? rem.error : '',
    };
  }

  snapshot() {
    return {
      catalogName: this.catalog.name || '',
      games: this.games().map((g) => this.view(g)),
      sync: { ...this.sync },
      admin: { ...this.admin },
      platform: { os: this.platform, arch: this.arch, label: platformLabel(this.platform, this.arch) },
      settings: this.settings.publicView(),
    };
  }

  // ---------- helpers ----------

  _changed(progress = false) {
    this.emit('change', { progress });
  }

  async _write(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, file);
  }
}

module.exports = { Library };
