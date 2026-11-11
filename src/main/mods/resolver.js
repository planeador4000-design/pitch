'use strict';

const semver = require('semver');
const { CATEGORIES } = require('./manifest');

// Turns "the mods the user ticked, in the order they put them" into either a concrete
// load plan or a list of exact reasons it can't run. Pure function: no disk, no game.
//
// Order rules (the spec's tiers): Pitch's base API always loads first; then mods by
// category (framework -> content -> gameplay -> balance); inside a category, the user's
// own order wins; and a dependency always loads before whatever depends on it, even if
// that means overriding the category order.
//
// Problems come back as { severity, code, modId, message, fix? }:
//   error   -> the game must not start with this selection
//   warning -> shown to the user, the game can start

function resolveLoadPlan({ enabled, installed, gameId = null, runtime = 'scratch-vm' }) {
  const problems = [];
  const err = (code, modId, message, fix) => problems.push({ severity: 'error', code, modId, message, ...(fix ? { fix } : {}) });
  const warn = (code, modId, message) => problems.push({ severity: 'warning', code, modId, message });

  const wanted = [];
  const seen = new Set();
  for (const id of enabled) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = installed.get(id);
    if (!entry) {
      err('MISSING', id, `El mod "${id}" está activado pero no está instalado.`);
    } else if (!entry.manifest) {
      err('INVALID', id, `El mod "${id}" tiene errores y no se puede cargar: ${entry.errors.join(' ')}`);
    } else {
      wanted.push(id);
    }
  }
  const wantedSet = new Set(wanted);
  const nameOf = (id) => (installed.get(id) && installed.get(id).manifest ? installed.get(id).manifest.name : id);

  // Compatibility with this game and this runtime.
  for (const id of [...wanted]) {
    const m = installed.get(id).manifest;
    const games = m.compatibility.games;
    if (games.length && !games.includes('*') && gameId && !games.includes(gameId)) {
      err('INCOMPATIBLE_GAME', id, `"${m.name}" solo funciona con: ${games.join(', ')}.`);
      wantedSet.delete(id);
    } else if (!m.compatibility.runtimes.includes(runtime)) {
      err('INCOMPATIBLE_RUNTIME', id, `"${m.name}" no es compatible con el runtime de este juego (${runtime}).`);
      wantedSet.delete(id);
    }
  }

  // Dependencies: installed, enabled in this profile, and at an acceptable version.
  for (const id of wanted) {
    if (!wantedSet.has(id)) continue;
    const m = installed.get(id).manifest;
    for (const [depId, range] of Object.entries(m.dependencies)) {
      const dep = installed.get(depId);
      if (!dep || !dep.manifest) {
        err('DEP_MISSING', id, `"${m.name}" necesita el mod "${depId}" (${range}), que no está instalado.`);
      } else if (!semver.satisfies(dep.manifest.version, range, { includePrerelease: true })) {
        err('DEP_VERSION', id, `"${m.name}" necesita "${dep.manifest.name}" ${range}, pero está instalada la ${dep.manifest.version}.`);
      } else if (!wantedSet.has(depId)) {
        err('DEP_DISABLED', id, `"${m.name}" necesita "${dep.manifest.name}", que no está activado en este perfil.`, { enable: depId });
      }
    }
  }

  // Declared incompatibilities (symmetric: either side declaring it is enough).
  for (const a of wanted) {
    if (!wantedSet.has(a)) continue;
    for (const b of installed.get(a).manifest.incompatibleWith) {
      if (b !== a && wantedSet.has(b)) {
        err('INCOMPATIBLE', a, `"${nameOf(a)}" es incompatible con "${nameOf(b)}": desactiva uno de los dos.`);
      }
    }
  }

  // Order: category rank, then the user's order; then a stable dependency-first pass.
  const userIndex = new Map(enabled.map((id, i) => [id, i]));
  const rank = (id) => CATEGORIES.indexOf(installed.get(id).manifest.category);
  const base = [...wantedSet].sort((x, y) => rank(x) - rank(y) || userIndex.get(x) - userIndex.get(y));

  const order = [];
  const state = new Map(); // id -> 1 visiting, 2 done
  let cycleReported = false;
  const visit = (id) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      if (!cycleReported) {
        cycleReported = true;
        err('DEP_CYCLE', id, `Hay una dependencia circular que incluye a "${nameOf(id)}".`);
      }
      return;
    }
    state.set(id, 1);
    for (const depId of Object.keys(installed.get(id).manifest.dependencies)) {
      if (wantedSet.has(depId)) visit(depId);
    }
    state.set(id, 2);
    order.push(id);
  };
  for (const id of base) visit(id);

  // Two mods that say they change the same thing: allowed, but the later one wins.
  const claims = new Map();
  for (const id of order) {
    for (const target of installed.get(id).manifest.modifies) {
      claims.set(target, [...(claims.get(target) || []), id]);
    }
  }
  for (const [target, ids] of claims) {
    if (ids.length > 1) {
      warn('CONFLICT', ids[ids.length - 1], `${ids.map(nameOf).join(' y ')} modifican ${target}. Se aplica el orden de carga: el último (${nameOf(ids[ids.length - 1])}) prevalece.`);
    }
  }

  return { ok: !problems.some((p) => p.severity === 'error'), order, problems };
}

module.exports = { resolveLoadPlan };
