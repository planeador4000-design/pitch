'use strict';

const { resolveLoadPlan } = require('./resolver');
const { connectToGame, findFreePort } = require('./injector');
const { runMods } = require('./host');
const { API_VERSION } = require('./manifest');

class ModLaunchError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'ModLaunchError';
    this.code = code;
    this.details = details;
  }
}

// The one place that decides, for a given game and the user's current choices, whether Pitch
// has to open a debugging port on the game and what to inject through it. Nothing is injected
// (and no port is opened) for Vanilla with no controller connected: the game is simply launched.
class ModService {
  constructor({ store, settings, notify = () => {} }) {
    this.store = store;
    this.settings = settings;
    this.notify = notify;
    this.session = null;
  }

  _view(entry) {
    const m = entry.manifest;
    return {
      id: entry.id,
      valid: !!m,
      name: m ? m.name : entry.id,
      version: m ? m.version : '',
      author: m ? m.author : '',
      description: m ? m.description : '',
      category: m ? m.category : '',
      permissions: m ? m.permissions : [],
      dependencies: m ? m.dependencies : {},
      pitchApi: m ? m.pitchApi : '',
      errors: entry.errors || [],
      warnings: entry.warnings || [],
      needsApproval: m ? this.store.needsApproval(m) : [],
    };
  }

  async listInstalled() {
    const scanned = await this.store.scan();
    return [...scanned.values()].map((e) => this._view(e)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  // Everything the Mods panel of a game page needs in one call.
  async gameState(gameId) {
    const scanned = await this.store.scan();
    const profiles = this.store.getProfiles(gameId);
    const enabled = profiles.profiles[profiles.active];
    const plan = resolveLoadPlan({ enabled, installed: scanned, gameId });
    return {
      apiVersion: API_VERSION,
      profiles: profiles.profiles,
      active: profiles.active,
      installed: [...scanned.values()].map((e) => this._view(e)).sort((a, b) => a.name.localeCompare(b.name, 'es')),
      order: plan.order,
      problems: plan.problems,
      canPlay: plan.ok,
      pendingApproval: plan.order
        .map((id) => scanned.get(id).manifest)
        .filter((m) => !this.store.isApproved(m))
        .map((m) => ({ id: m.id, name: m.name, permissions: m.permissions, needs: this.store.needsApproval(m) })),
    };
  }

  async approve(ids) {
    const scanned = await this.store.scan();
    for (const id of ids) {
      const entry = scanned.get(id);
      if (entry && entry.manifest) this.store.approve(entry.manifest);
    }
  }

  // Throws ModLaunchError when the selection can't run; returns { inject: false } when there is
  // nothing to inject; otherwise returns the job to hand to attach() after the game has started.
  async prepare(gameId, { gamepadsConnected = 0 } = {}) {
    const enabled = this.store.activeMods(gameId);
    let mods = [];
    let warnings = [];
    if (enabled.length) {
      const scanned = await this.store.scan();
      const plan = resolveLoadPlan({ enabled, installed: scanned, gameId });
      if (!plan.ok) {
        const errors = plan.problems.filter((p) => p.severity === 'error');
        throw new ModLaunchError(`Los mods activados no se pueden cargar: ${errors.map((e) => e.message).join(' ')}`, 'PLAN', errors);
      }
      const pending = plan.order.map((id) => scanned.get(id).manifest).filter((m) => !this.store.isApproved(m));
      if (pending.length) {
        throw new ModLaunchError(`Antes de jugar tienes que aprobar los permisos de: ${pending.map((m) => m.name).join(', ')}.`, 'APPROVAL', pending.map((m) => m.id));
      }
      mods = plan.order.map((id) => scanned.get(id));
      warnings = plan.problems.filter((p) => p.severity === 'warning').map((p) => p.message);
    }
    const pad = this.settings.get().gamepad;
    const padActive = !!pad.enabled && gamepadsConnected > 0;
    if (!mods.length && !padActive) return { inject: false };
    const port = await findFreePort();
    return { inject: true, port, extraArgs: [`--remote-debugging-port=${port}`], mods, gamepad: padActive ? pad : null, warnings };
  }

  async attach(job) {
    const session = await connectToGame({ port: job.port, timeoutMs: 20000 });
    this.session = session;
    const result = await runMods({
      session,
      mods: job.mods,
      gamepad: job.gamepad,
      onReport: (r) => {
        if (r.type === 'modError') this.notify({ tone: 'amber', message: `Error en el mod ${r.modId || 'desconocido'} (${r.where}): ${r.message}` });
      },
    });
    result.warnings.push(...job.warnings);
    result.gamepad = !!job.gamepad;
    return result;
  }

  async detach() {
    const s = this.session;
    this.session = null;
    if (s) await s.close().catch(() => {});
  }
}

module.exports = { ModService, ModLaunchError };
