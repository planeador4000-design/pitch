'use strict';

// Everything about the catalog format lives here: how the user can point Pitch at a
// catalog (owner/repo, owner/repo@branch, or a URL), and how catalog entries are
// validated and normalised before the rest of the app sees them.

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Overridable only for local development/tests against a fake GitHub (see PITCH_API_BASE
// in main.js); production always uses the real raw.githubusercontent.com.
const RAW_BASE = process.env.PITCH_RAW_BASE || 'https://raw.githubusercontent.com';
const PLATFORM_KEYS = { windows: 'win32', mac: 'darwin', linux: 'linux' };

class CatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogError';
  }
}

function str(value, max = 600) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function httpsUrl(value) {
  const s = str(value, 2000);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

// Ids become folder names on disk, so they must be boring.
function sanitizeId(value) {
  const s = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
  return s;
}

function normalizeRepo(value) {
  const repo = String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return REPO_RE.test(repo) ? repo : '';
}

function prettifyRepoName(name) {
  const words = String(name || '')
    .replace(/[-_.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (!words) return 'Juego sin nombre';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function normalizeAssetPatterns(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [friendly, platform] of Object.entries(PLATFORM_KEYS)) {
    const pattern = str(value[friendly], 300);
    if (pattern) out[platform] = pattern;
  }
  return out;
}

function normalizeGame(input) {
  if (!input || typeof input !== 'object') return null;
  const repo = normalizeRepo(input.repo);
  if (!repo) return null;
  const [owner, name] = repo.split('/');
  const id = sanitizeId(input.id) || sanitizeId(`${owner}--${name}`);
  if (!id) return null;
  return {
    id,
    repo,
    title: str(input.title, 120) || prettifyRepoName(name),
    author: str(input.author, 120) || owner,
    description: str(input.description, 1200),
    tags: Array.isArray(input.tags) ? input.tags.map((t) => str(t, 24)).filter(Boolean).slice(0, 6) : [],
    cover: httpsUrl(input.cover),
    banner: httpsUrl(input.banner),
    featured: input.featured === true,
    channel: input.channel === 'prerelease' ? 'prerelease' : 'stable',
    assets: normalizeAssetPatterns(input.assets),
  };
}

function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.games)) {
    throw new CatalogError('El catálogo no es válido: falta la lista "games".');
  }
  const games = [];
  const seen = new Set();
  for (const entry of raw.games) {
    const game = normalizeGame(entry);
    if (game && !seen.has(game.id)) {
      seen.add(game.id);
      games.push(game);
    }
  }
  return { name: str(raw.name, 80) || 'Catálogo', games };
}

// Accepts:
//   owner/repo                 -> catalog.json on the default branch
//   owner/repo@branch          -> catalog.json on that branch
//   owner/repo@branch:path.json
//   https://github.com/owner/repo/blob/branch/path.json
//   https://raw.githubusercontent.com/... or any other https URL to a JSON file
function parseCatalogSource(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new CatalogError('La dirección del catálogo no es válida.');
    }
    if (u.protocol !== 'https:') throw new CatalogError('La dirección del catálogo debe empezar por https://');
    if (u.hostname === 'github.com') {
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/blob\/([^/]+)\/(.+))?\/?$/);
      if (!m) throw new CatalogError('Usa usuario/repositorio o un enlace a un archivo JSON del repositorio.');
      const [, owner, repo, ref = 'HEAD', file = 'catalog.json'] = m;
      return { url: `${RAW_BASE}/${owner}/${repo}/${ref}/${file}`, label: `${owner}/${repo}`, owner, repo, ref, file };
    }
    return { url: u.toString(), label: u.hostname };
  }

  const m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_./-]+))?(?::([A-Za-z0-9_./-]+))?$/);
  if (!m) throw new CatalogError('Escribe el catálogo como usuario/repositorio (o usuario/repositorio@rama).');
  const [, owner, repo, ref = 'HEAD', file = 'catalog.json'] = m;
  return { url: `${RAW_BASE}/${owner}/${repo}/${ref}/${file}`, label: `${owner}/${repo}`, owner, repo, ref, file };
}

module.exports = {
  CatalogError,
  REPO_RE,
  sanitizeId,
  normalizeRepo,
  prettifyRepoName,
  normalizeGame,
  normalizeCatalog,
  parseCatalogSource,
};
