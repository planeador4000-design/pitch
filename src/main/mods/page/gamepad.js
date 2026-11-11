// Runs INSIDE the game's page, after core.js. Turns a connected controller into keyboard
// input by feeding scratch-vm's own keyboard device (vm.postIOData), which is exactly what the
// exporter does for a real key press. Scratch games read keys, so the game needs no changes.
// __GAMEPAD_CONFIG__ is replaced by the host: { enabled, stick, deadzone, buttons }.
(function (cfg) {
  'use strict';
  var core = window.__PitchCore;
  if (!core) return;
  if (core.gamepad) { core.gamepad.configure(cfg); return; }

  var vm = core.vm;
  var config = cfg;
  var held = {};
  var BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, ls: 10, rs: 11 };
  var NAMED = { space: ' ', enter: 'Enter', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

  function keyName(k) {
    if (!k) return '';
    var lower = String(k).toLowerCase();
    if (NAMED[lower]) return NAMED[lower];
    return String(k).length === 1 ? String(k).toLowerCase() : '';
  }
  function stickKeys() {
    return config.stick === 'wasd'
      ? { left: 'a', right: 'd', up: 'w', down: 's' }
      : { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };
  }
  function pressed(pad, i) { return !!(pad.buttons[i] && pad.buttons[i].pressed); }

  function frame() {
    var desired = {};
    if (config.enabled) {
      var pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (var p = 0; p < pads.length; p++) {
        var pad = pads[p];
        if (!pad || !pad.connected) continue;
        var dz = config.deadzone;
        var ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
        var sk = stickKeys();
        if (ax < -dz || pressed(pad, 14)) desired[sk.left] = true;
        if (ax > dz || pressed(pad, 15)) desired[sk.right] = true;
        if (ay < -dz || pressed(pad, 12)) desired[sk.up] = true;
        if (ay > dz || pressed(pad, 13)) desired[sk.down] = true;
        Object.keys(config.buttons || {}).forEach(function (name) {
          if (BTN[name] !== undefined && pressed(pad, BTN[name])) {
            var k = keyName(config.buttons[name]);
            if (k) desired[k] = true;
          }
        });
      }
    }
    Object.keys(desired).forEach(function (k) {
      if (!held[k]) { held[k] = true; vm.postIOData('keyboard', { key: k, isDown: true }); }
    });
    Object.keys(held).forEach(function (k) {
      if (!desired[k]) { delete held[k]; vm.postIOData('keyboard', { key: k, isDown: false }); }
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  core.gamepad = {
    configure: function (c) { config = c; },
    names: function () { return Array.prototype.filter.call(navigator.getGamepads ? navigator.getGamepads() : [], Boolean).map(function (g) { return g.id; }); },
  };
})(__GAMEPAD_CONFIG__);
