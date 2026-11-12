'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { normalizeCatalog, parseCatalogSource, CatalogError } = require('./catalog');

const GITHUB_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com', 'github.com']);
const MAX_CACHE_ENTRIES = 200;

class GitHubError extends Error {
  constructor(message, { status = 0, code = 'GITHUB' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
  }
}

class RateLimitError extends GitHubError {
  constructor(resetAt) {
    const when = new Date(resetAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    super(`GitHub ha limitado las peticiones. Se reintentará a las ${when}. Un token en Ajustes sube el límite.`, {
      status: 403,
      code: 'RATE_LIMIT',
    });
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

function normalizeRelease(r) {
  return {
    tag: String(r.tag_name || ''),
    name: String(r.name || r.tag_name || ''),
    notes: String(r.body || ''),
    publishedAt: r.published_at || r.created_at || null,
    url: r.html_url || '',
    prerelease: !!r.prerelease,
    assets: (r.assets || []).map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size || 0,
      apiUrl: a.url || '',
      downloadUrl: a.browser_download_url || '',
      digest: typeof a.digest === 'string' ? a.digest : '',
      updatedAt: a.updated_at || null,
      contentType: a.content_type || '',
    })),
  };
}

class GitHubClient {
  constructor({
    getToken = () => '',
    apiBase = 'https://api.github.com',
    cacheFile = null,
    userAgent = 'Pitch',
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000,
  } = {}) {
    this.getToken = getToken;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.cacheFile = cacheFile;
    this.userAgent = userAgent;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map(); // url -> { etag, body }
    this.saveTimer = null;
    this._loadCache();
  }

  _loadCache() {
    if (!this.cacheFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const [url, entry] of Object.entries(data)) this.cache.set(url, entry);
    } catch {
      /* first run or corrupt cache: start empty */
    }
  }

  _saveSoon() {
    if (!this.cacheFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const entries = [...this.cache.entries()].slice(-MAX_CACHE_ENTRIES);
      fsp
        .mkdir(path.dirname(this.cacheFile), { recursive: true })
        .then(() => fsp.writeFile(this.cacheFile, JSON.stringify(Object.fromEntries(entries))))
        .catch(() => {});
    }, 500);
    this.saveTimer.unref?.();
  }

  // The token is only ever sent to GitHub itself, never to a custom catalog host.
  authHeaders(url) {
    const token = this.getToken();
    if (!token) return {};
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return {};
    }
    const isApiBase = url.startsWith(this.apiBase);
    if (!isApiBase && !GITHUB_HOSTS.has(host)) return {};
    return { Authorization: isApiBase ? `Bearer ${token}` : `token ${token}` };
  }

  async request(url, { parse = 'json', accept = 'application/vnd.github+json' } = {}) {
    const headers = { 'User-Agent': this.userAgent, Accept: accept, ...this.authHeaders(url) };
    if (url.startsWith(this.apiBase)) headers['X-GitHub-Api-Version'] = '2022-11-28';
    const cached = this.cache.get(url);
    if (cached && cached.etag) headers['If-None-Match'] = cached.etag;

    let res;
    try {
      res = await this.fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new GitHubError('No hay conexión con GitHub.', { code: 'NETWORK' });
    }

    if (res.status === 304 && cached) return cached.body;
    if (res.status === 404) throw new GitHubError('No se encontró en GitHub.', { status: 404, code: 'NOT_FOUND' });
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const retryAfter = Number(res.headers.get('retry-after'));
      if (remaining === '0' || res.status === 429) {
        const resetAt = reset ? reset * 1000 : Date.now() + (retryAfter ? retryAfter * 1000 : 15 * 60 * 1000);
        throw new RateLimitError(resetAt);
      }
      throw new GitHubError('GitHub ha denegado el acceso (¿repositorio privado sin token?).', { status: 403, code: 'FORBIDDEN' });
    }
    if (res.status === 401) throw new GitHubError('El token de GitHub no es válido.', { status: 401, code: 'BAD_TOKEN' });
    if (!res.ok) throw new GitHubError(`GitHub respondió con el error ${res.status}.`, { status: res.status });

    let body;
    try {
      body = parse === 'text' ? await res.text() : await res.json();
    } catch {
      throw new GitHubError('GitHub devolvió una respuesta ilegible.', { code: 'BAD_BODY' });
    }
    const etag = res.headers.get('etag');
    if (etag) {
      this.cache.delete(url); // keep the Map ordered by recency
      this.cache.set(url, { etag, body });
      this._saveSoon();
    }
    return body;
  }

  async fetchCatalog(source) {
    const parsed = parseCatalogSource(source);
    if (!parsed) throw new CatalogError('No hay ningún catálogo configurado.');
    let text;
    try {
      text = await this.request(parsed.url, { parse: 'text', accept: 'application/json, text/plain, */*' });
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        throw new CatalogError(`No se encontró catalog.json en ${parsed.label}. Comprueba el nombre del repositorio.`);
      }
      throw err;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new CatalogError('El catálogo no es un JSON válido.');
    }
    return normalizeCatalog(raw);
  }

  async latestRelease(repo, { prerelease = false } = {}) {
    try {
      if (!prerelease) {
        return normalizeRelease(await this.request(`${this.apiBase}/repos/${repo}/releases/latest`));
      }
      const list = await this.request(`${this.apiBase}/repos/${repo}/releases?per_page=10`);
      const first = Array.isArray(list) ? list.find((r) => !r.draft) : null;
      return first ? normalizeRelease(first) : null;
    } catch (err) {
      if (err.code === 'NOT_FOUND') return null; // The repo exists but has no releases yet (or it doesn't exist).
      throw err;
    }
  }

  // Reads a file through the API (always fresh, unlike raw.githubusercontent.com's CDN cache).
  // Returns null when the file does not exist yet.
  async getFile(repo, filePath, ref) {
    const query = ref && ref !== 'HEAD' ? `?ref=${encodeURIComponent(ref)}` : '';
    let data;
    try {
      data = await this.request(`${this.apiBase}/repos/${repo}/contents/${encodeURI(filePath)}${query}`);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return null;
      throw err;
    }
    if (typeof data.content !== 'string') throw new GitHubError('GitHub no devolvió el contenido del archivo.');
    return { sha: data.sha, text: Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8') };
  }

  // Creates or updates a file with a commit. `sha` is required when the file already exists.
  async putFile(repo, filePath, { text, sha, message, ref }) {
    const url = `${this.apiBase}/repos/${repo}/contents/${encodeURI(filePath)}`;
    const body = { message, content: Buffer.from(text, 'utf8').toString('base64') };
    if (sha) body.sha = sha;
    if (ref && ref !== 'HEAD') body.branch = ref;
    let res;
    try {
      res = await this.fetch(url, {
        method: 'PUT',
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...this.authHeaders(url),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GitHubError('No hay conexión con GitHub.', { code: 'NETWORK' });
    }
    if (res.status === 409 || res.status === 422) {
      throw new GitHubError('El catálogo cambió mientras lo editabas. Recarga el panel e inténtalo de nuevo.', { status: res.status, code: 'CONFLICT' });
    }
    if (res.status === 401) throw new GitHubError('El token de GitHub no es válido.', { status: 401, code: 'BAD_TOKEN' });
    if (res.status === 403 || res.status === 404) {
      throw new GitHubError('Tu token no tiene permiso para escribir en el repositorio del catálogo.', { status: res.status, code: 'FORBIDDEN' });
    }
    if (!res.ok) throw new GitHubError(`GitHub respondió con el error ${res.status}.`, { status: res.status });
    const data = await res.json().catch(() => ({}));
    return { sha: data.content && data.content.sha ? data.content.sha : '' };
  }

  async canPush(repo) {
    const data = await this.request(`${this.apiBase}/repos/${repo}`);
    return !!(data.permissions && data.permissions.push);
  }

  async repoInfo(repo) {
    const data = await this.request(`${this.apiBase}/repos/${repo}`);
    return {
      description: String(data.description || ''),
      owner: data.owner && data.owner.login ? data.owner.login : repo.split('/')[0],
      name: data.name || repo.split('/')[1],
      url: data.html_url || `https://github.com/${repo}`,
    };
  }
}

module.exports = { GitHubClient, GitHubError, RateLimitError, normalizeRelease };
