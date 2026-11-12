'use strict';

// Adapter for games built on scratch-vm. That covers plain Scratch exports and TurboWarp
// exports alike (TurboWarp's VM is a scratch-vm fork with the same runtime shape), so one
// adapter serves both and only reports which flavour it found.
const fs = require('node:fs');
const path = require('node:path');
const { detectScratchVM } = require('../detector');

const PAGE_DIR = path.join(__dirname, '..', 'page');

module.exports = {
  id: 'scratch-vm',
  label: 'Scratch / TurboWarp (scratch-vm)',
  detect: (session, opts) => detectScratchVM(session, opts),
  // The script that installs the Pitch core into the page, for the VM found at detection.path.
  coreScript(detection) {
    const vmExpr = `(${detection.path})`;
    return fs
      .readFileSync(path.join(PAGE_DIR, 'core.js'), 'utf8')
      .split('__VM_EXPR__').join(vmExpr)
      .split('__FLAVOR__').join(JSON.stringify(detection.flavor || 'scratch'));
  },
  uiScript: () => fs.readFileSync(path.join(PAGE_DIR, 'ui.js'), 'utf8'),
  gamepadScript: (config) => fs.readFileSync(path.join(PAGE_DIR, 'gamepad.js'), 'utf8').split('__GAMEPAD_CONFIG__').join(JSON.stringify(config)),
};
