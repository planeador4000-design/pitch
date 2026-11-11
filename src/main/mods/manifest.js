'use strict';

const path = require('node:path');
const semver = require('semver');

// The Mod API version this build of Pitch implements. A mod declares the API it was
// written against ("pitchApi": "1.0"); it loads if the major matches and the minor is not
// newer than ours (new minors only ever add things, a major bump may break mods).
const API_VERSION = '1.0';

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

// "system" is deliberately listed as known but refused: mod code runs inside the game's
// own page, so there is no honest way to hand out OS access with a meaningful limit.
const KNOWN_PERMISSIONS = ['game', 'graphics', 'audio', 'storage', 'ui', 'input', 'network', 'system'];
const REFUSED_PERMISSIONS = new Set(['system']);

// Load-order tiers, earliest first: Pitch's own base API always loads before all of these.
const CATEGORIES = ['framework', 'content', 'gameplay', 'balance'];

const MAX_MAIN_BYTES = 5 * 1024 * 1024;

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseApi(value) {
  const m = String(value || '').match(/^(\d+)\.(\d+)$/);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

// Returns { manifest, errors, warnings }. `manifest` is null when there are errors, so a
// broken mod can still be shown in the manager with the reasons instead of crashing the app.
function validateManifest(raw, { pitchVersion = null } = {}) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: null, errors: ['mod.json no es un objeto JSON válido.'], warnings };
  }

  const id = str(raw.id, 64);
  if (!ID_RE.test(id)) errors.push('"id" es obligatorio y solo admite minúsculas, números, punto, guion y guion bajo (2-64 caracteres).');

  const name = str(raw.name, 80);
  if (!name) errors.push('"name" es obligatorio.');

  const version = str(raw.version, 40);
  if (!semver.valid(version)) errors.push('"version" debe ser una versión semántica (por ejemplo 1.0.0).');

  let main = str(raw.main, 200) || 'main.js';
  const normalizedMain = path.posix.normalize(main.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(normalizedMain) || normalizedMain.startsWith('..') || !normalizedMain.endsWith('.js')) {
    errors.push('"main" debe ser un archivo .js dentro de la carpeta del mod.');
  }
  main = normalizedMain;

  const api = parseApi(raw.pitchApi);
  const ours = parseApi(API_VERSION);
  if (!api) errors.push('"pitchApi" es obligatorio (por ejemplo "1.0").');
  else if (api.major !== ours.major || api.minor > ours.minor) {
    errors.push(`Requiere la Mod API ${raw.pitchApi}, y esta versión de Pitch incluye la ${API_VERSION}.`);
  }

  const minPitch = str(raw.minPitchVersion, 40);
  if (minPitch) {
    if (!semver.valid(minPitch)) errors.push('"minPitchVersion" no es una versión válida.');
    else if (pitchVersion && semver.lt(pitchVersion, minPitch)) errors.push(`Requiere Pitch ${minPitch} o superior (tienes la ${pitchVersion}).`);
  }

  const dependencies = {};
  if (raw.dependencies !== undefined) {
    if (!raw.dependencies || typeof raw.dependencies !== 'object' || Array.isArray(raw.dependencies)) {
      errors.push('"dependencies" debe ser un objeto { "id-del-mod": ">=1.0.0" }.');
    } else {
      for (const [depId, range] of Object.entries(raw.dependencies)) {
        if (!ID_RE.test(depId)) errors.push(`La dependencia "${depId}" no tiene un id válido.`);
        else if (depId === id) errors.push('Un mod no puede depender de sí mismo.');
        else if (typeof range !== 'string' || !semver.validRange(range)) errors.push(`La versión pedida para "${depId}" no es un rango válido.`);
        else dependencies[depId] = range;
      }
    }
  }

  const permissions = [];
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) errors.push('"permissions" debe ser una lista.');
    else {
      for (const p of raw.permissions) {
        if (!KNOWN_PERMISSIONS.includes(p)) errors.push(`Permiso desconocido: "${p}".`);
        else if (REFUSED_PERMISSIONS.has(p)) errors.push(`El permiso "${p}" no está disponible: los mods se ejecutan dentro del juego y Pitch no puede darles acceso al sistema con garantías.`);
        else if (!permissions.includes(p)) permissions.push(p);
      }
    }
  }

  const category = str(raw.category, 20) || 'content';
  if (!CATEGORIES.includes(category)) errors.push(`"category" debe ser una de: ${CATEGORIES.join(', ')}.`);

  const compat = raw.compatibility && typeof raw.compatibility === 'object' ? raw.compatibility : {};
  const games = Array.isArray(compat.games) ? compat.games.map((g) => str(g, 100)).filter(Boolean) : [];
  const runtimes = Array.isArray(compat.runtimes) && compat.runtimes.length ? compat.runtimes.map((r) => str(r, 40)).filter(Boolean) : ['scratch-vm'];

  const list = (v) => (Array.isArray(v) ? v.map((x) => str(x, 120)).filter(Boolean) : []);

  if (errors.length) return { manifest: null, errors, warnings };

  if (!str(raw.author, 80)) warnings.push('No indica autor.');
  if (!str(raw.description, 600)) warnings.push('No tiene descripción.');

  return {
    manifest: {
      id,
      name,
      version,
      author: str(raw.author, 80),
      description: str(raw.description, 600),
      main,
      pitchApi: String(raw.pitchApi),
      minPitchVersion: minPitch,
      dependencies,
      permissions,
      category,
      compatibility: { games, runtimes },
      modifies: list(raw.modifies),
      incompatibleWith: list(raw.incompatibleWith),
    },
    errors,
    warnings,
  };
}

module.exports = { validateManifest, API_VERSION, KNOWN_PERMISSIONS, CATEGORIES, MAX_MAIN_BYTES, ID_RE };
