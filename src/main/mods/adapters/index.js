'use strict';

// Pitch Mod API  ->  Runtime Adapter  ->  the game's own runtime.
// Each adapter knows how to recognise one family of runtimes and how to install the Pitch core
// into it. Adding support for another exporter means adding a file here, not touching mods.
const ADAPTERS = [require('./scratch-vm')];

async function selectAdapter(session, opts) {
  let last = null;
  for (const adapter of ADAPTERS) {
    try {
      const detection = await adapter.detect(session, opts);
      return { adapter, detection };
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err;
      last = err;
    }
  }
  throw last;
}

module.exports = { selectAdapter, ADAPTERS };
