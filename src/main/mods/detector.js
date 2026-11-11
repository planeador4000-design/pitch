'use strict';

// Where the game's scratch-vm instance lives on `window` is not one fixed name — it
// depends on which packager built the game and which version. What IS fixed, confirmed
// against the real scaffolding.js source (scaffolding.setup() does `this.vm = new VM()`
// and TurboWarp's own developer docs list `vm` as the conventional devtools global — see
// docs/mod-research.md) is the *shape* of a scratch-vm instance once found: it always has
// a `.runtime` with a `.targets` array and an EventEmitter interface.
//
// So instead of betting on one global name, this probes a short list of places real
// packaged games are known to put it, and verifies whatever it finds actually looks like
// scratch-vm before trusting it. Anything that doesn't pass the runtime shape check is
// ignored: a game's own object that merely happens to be called "vm" is not ours to touch.

// Ordered by how likely each is in a real TurboWarp Packager / scaffolding-based export.
const CANDIDATE_PATHS = [
  'window.vm', // documented TurboWarp devtools global
  'window.__vm',
  'window.scaffolding && window.scaffolding.vm',
  'window.app && window.app.vm',
];

// A small JS snippet, run inside the game via session.evaluate(), that tries each
// candidate and reports back which one (if any) looks like a real scratch-vm.
const PROBE_SCRIPT = `
(function () {
  function looksLikeScratchVM(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    var rt = candidate.runtime;
    if (!rt || typeof rt !== 'object') return false;
    if (!Array.isArray(rt.targets)) return false;
    if (typeof rt.on !== 'function' || typeof rt.emit !== 'function') return false;
    return true;
  }
  var paths = ${JSON.stringify(CANDIDATE_PATHS)};
  for (var i = 0; i < paths.length; i++) {
    var value;
    try { value = eval(paths[i]); } catch (e) { value = undefined; }
    if (looksLikeScratchVM(value)) {
      var rtm = value.runtime;
      var flavor = (typeof rtm.setCompilerOptions === 'function' || rtm.compilerOptions) ? 'turbowarp' : 'scratch';
      return JSON.stringify({ found: true, path: paths[i], targetCount: rtm.targets.length, flavor: flavor });
    }
  }
  return JSON.stringify({ found: false });
})()
`;

class DetectionError extends Error {
  constructor(message, code = 'DETECTION') {
    super(message);
    this.name = 'DetectionError';
    this.code = code;
  }
}

// Returns { path, targetCount, flavor } for the first thing that looks like a real scratch-vm,
// or throws DetectionError (code NOT_FOUND) if nothing in the game matches — the honest answer
// for a game that isn't a Scratch/TurboWarp export, or one built so that it hides the VM.
async function detectScratchVM(session, { timeoutMs = 10000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let raw;
    try {
      raw = await session.evaluate(PROBE_SCRIPT);
    } catch (err) {
      throw new DetectionError(`No se pudo analizar el juego: ${err.message}`, 'PROBE_FAILED');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DetectionError('El juego devolvió una respuesta inesperada al analizarlo.', 'BAD_PROBE_RESULT');
    }
    if (parsed.found) return { path: parsed.path, targetCount: parsed.targetCount, flavor: parsed.flavor };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new DetectionError(
    'Este juego no parece tener un runtime de Scratch accesible (puede no estar hecho con TurboWarp Packager, o usar una compilación que oculta el VM). Los mods no están disponibles para este juego.',
    'NOT_FOUND',
  );
}

module.exports = { detectScratchVM, DetectionError, CANDIDATE_PATHS };
