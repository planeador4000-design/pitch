'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateManifest } = require('./manifest');

const VANILLA = 'Vanilla';
const MAX_MOD_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 5000;

class ModError extends Error {
  constructor(message, code = 'MOD') {
    super(message);
    this.name = 'ModError';
    this.code = code;
  }
}

// Walks a mod folder once, refusing anything that could make installing it unsafe or
// surprising: symlinks (they could point outside the folder), too many files, too much data.
async function inspectTree(root) {
  let bytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new ModError(`El mod contiene un enlace simbólico (${entry.name}), que no se permite.`, 'SYMLINK');
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await fsp.stat(full)).size;
        if (files > MAX_FILES) throw new ModError('El mod tiene demasiados archivos.', 'TOO_BIG');
        if (bytes > MAX_MOD_BYTES) throw new ModError('El mod ocupa demasiado (máximo 200 MB).', 'TOO_BIG');
      }
    }
  }
  return { bytes, files };
}

class ModStore {
  constructor({ dir, stateFile, pitchVersion = null }) {
    this.dir = dir; // <userData>/mods
    this.stateFile = stateFile; // <userData>/mods-state.json
    this.pitchVersion = pitchVersion;
    this.state = { profiles: {}, approvals: {} };
    fs.mkdirSync(this.dir, { recursive: true });
    this._load();
  }

  // ---------- installed mods ----------

  async scan() {
    const result = new Map();
    let names = [];
    try {
      names = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const d of names) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const modDir = path.join(this.dir, d.name);
      let raw;
      try {
        raw = JSON.parse(await fsp.readFile(path.join(modDir, 'mod.json'), 'utf8'));
      } catch (err) {
        result.set(d.name, { id: d.name, dir: modDir, manifest: null, errors: [err.code === 'ENOENT' ? 'Falta mod.json.' : 'mod.json no es un JSON válido.'], warnings: [] });
        continue;
      }
      const { manifest, errors, warnings } = validateManifest(raw, { pitchVersion: this.pitchVersion });
      if (manifest && manifest.id !== d.name) errors.push(`La carpeta se llama "${d.name}" pero el id del mod es "${manifest.id}".`);
      if (manifest && !errors.length) {
        try {
          const st = await fsp.stat(path.join(modDir, manifest.main));
          if (!st.isFile()) errors.push(`No se encuentra el archivo principal (${manifest.main}).`);
        } catch {
          errors.push(`No se encuentra el archivo principal (${manifest.main}).`);
        }
      }
      result.set(d.name, { id: manifest ? manifest.id : d.name, dir: modDir, manifest: errors.length ? null : manifest, errors, warnings });
    }
    return result;
  }

  async installFromFolder(srcDir) {
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(path.join(srcDir, 'mod.json'), 'utf8'));
    } catch {
      throw new ModError('Esa carpeta no contiene un mod.json válido.', 'NO_MANIFEST');
    }
    const { manifest, errors } = validateManifest(raw, { pitchVersion: this.pitchVersion });
    if (!manifest) throw new ModError(`El mod no es válido: ${errors.join(' ')}`, 'INVALID');
    await inspectTree(srcDir);

    const stage = await fsp.mkdtemp(path.join(this.dir, '.stage-'));
    try {
      await fsp.cp(srcDir, stage, { recursive: true, dereference: false, errorOnExist: false, force: true });
      try {
        const st = await fsp.stat(path.join(stage, manifest.main));
        if (!st.isFile() || st.size > 5 * 1024 * 1024) throw new Error('bad main');
      } catch {
        throw new ModError(`El archivo principal (${manifest.main}) no existe o es demasiado grande.`, 'NO_MAIN');
      }
      const final = path.join(this.dir, manifest.id);
      const previous = await this._versionOf(final);
      await fsp.rm(final, { recursive: true, force: true });
      await fsp.rename(stage, final);
      return { manifest, updatedFrom: previous };
    } catch (err) {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async installFromZip(zipPath) {
    const extract = require('extract-zip');
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitch-mod-'));
    try {
      try {
        await extract(zipPath, { dir: tmp });
      } catch {
        throw new ModError('No se pudo abrir el archivo zip del mod.', 'BAD_ZIP');
      }
      // mod.json at the zip root, or inside a single top-level folder.
      let root = tmp;
      if (!fs.existsSync(path.join(root, 'mod.json'))) {
        const children = (await fsp.readdir(tmp, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== '__MACOSX');
        if (children.length === 1) root = path.join(tmp, children[0].name);
      }
      return await this.installFromFolder(root);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async remove(id) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new ModError('Identificador de mod no válido.', 'BAD_ID');
    await fsp.rm(path.join(this.dir, id), { recursive: true, force: true });
    for (const game of Object.values(this.state.profiles)) {
      for (const name of Object.keys(game.profiles)) game.profiles[name] = game.profiles[name].filter((m) => m !== id);
    }
    delete this.state.approvals[id];
    this._save();
  }

  async _versionOf(dir) {
    try {
      return JSON.parse(await fsp.readFile(path.join(dir, 'mod.json'), 'utf8')).version || null;
    } catch {
      return null;
    }
  }

  // ---------- profiles (per game) ----------

  _game(gameId) {
    if (!this.state.profiles[gameId]) this.state.profiles[gameId] = { active: VANILLA, profiles: { [VANILLA]: [] } };
    const g = this.state.profiles[gameId];
    g.profiles[VANILLA] = []; // Vanilla is always empty
    if (!g.profiles[g.active]) g.active = VANILLA;
    return g;
  }

  getProfiles(gameId) {
    const g = this._game(gameId);
    return { active: g.active, profiles: Object.fromEntries(Object.entries(g.profiles).map(([k, v]) => [k, [...v]])) };
  }

  activeMods(gameId) {
    const g = this._game(gameId);
    return [...g.profiles[g.active]];
  }

  createProfile(gameId, name, { copyFrom = null } = {}) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new ModError('Escribe un nombre para el perfil.', 'BAD_NAME');
    const g = this._game(gameId);
    if (Object.keys(g.profiles).some((k) => k.toLowerCase() === clean.toLowerCase())) throw new ModError('Ya existe un perfil con ese nombre.', 'DUPLICATE');
    g.profiles[clean] = copyFrom && g.profiles[copyFrom] ? [...g.profiles[copyFrom]] : [];
    g.active = clean;
    this._save();
    return clean;
  }

  deleteProfile(gameId, name) {
    if (name === VANILLA) throw new ModError('El perfil Vanilla no se puede borrar.', 'PROTECTED');
    const g = this._game(gameId);
    delete g.profiles[name];
    if (g.active === name) g.active = VANILLA;
    this._save();
  }

  setActiveProfile(gameId, name) {
    const g = this._game(gameId);
    if (!g.profiles[name]) throw new ModError('Ese perfil no existe.', 'NO_PROFILE');
    g.active = name;
    this._save();
  }

  // `modIds` is the full ordered list of enabled mods for that profile (order = load order).
  setProfileMods(gameId, name, modIds) {
    if (name === VANILLA) throw new ModError('El perfil Vanilla no admite mods. Crea otro perfil.', 'PROTECTED');
    const g = this._game(gameId);
    if (!g.profiles[name]) throw new ModError('Ese perfil no existe.', 'NO_PROFILE');
    const unique = [];
    for (const id of Array.isArray(modIds) ? modIds : []) {
      if (typeof id === 'string' && !unique.includes(id)) unique.push(id);
    }
    g.profiles[name] = unique;
    this._save();
  }

  // ---------- permission approvals ----------

  // A mod needs the user's OK the first time it runs, and again whenever an update asks
  // for a permission it hadn't been approved for. Fewer permissions never need re-approval.
  needsApproval(manifest) {
    const approved = this.state.approvals[manifest.id];
    if (!approved) return manifest.permissions.length > 0 ? manifest.permissions : [];
    return manifest.permissions.filter((p) => !approved.permissions.includes(p));
  }

  isApproved(manifest) {
    return this.needsApproval(manifest).length === 0;
  }

  approve(manifest) {
    this.state.approvals[manifest.id] = { version: manifest.version, permissions: [...manifest.permissions] };
    this._save();
  }

  // ---------- persistence ----------

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.state.profiles = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
        this.state.approvals = raw.approvals && typeof raw.approvals === 'object' ? raw.approvals : {};
      }
    } catch {
      /* first run */
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }
}

module.exports = { ModStore, ModError, VANILLA };
