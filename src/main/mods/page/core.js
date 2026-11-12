// Runs INSIDE the game's page, evaluated by Pitch over the Chrome DevTools Protocol.
// Everything here is built on scratch-vm calls that were exercised against a real running
// instance (see docs/mod-research.md). __VM_EXPR__ and __FLAVOR__ are replaced by the host.
(function (vm, flavor) {
  'use strict';
  if (window.__PitchCore) return;

  var rt = vm.runtime;
  var core = { vm: vm, rt: rt, flavor: flavor, mods: {}, patchOwners: {}, paused: false };
  window.__PitchCore = core;
  var API_VERSION = '1.0';

  function report(obj) {
    try { if (window.__pitchReport) window.__pitchReport(JSON.stringify(obj)); } catch (e) { /* host gone */ }
  }
  core.report = report;

  // Errors that escape a mod's own try/catch (async code, timers) are attributed to the mod
  // through the sourceURL the host stamps on its script, instead of vanishing in the console.
  function attribute(err) {
    var stack = String(err && err.stack || '');
    var m = stack.match(/pitch-mod:\/\/([^\/]+)\//);
    return m ? m[1] : null;
  }
  window.addEventListener('unhandledrejection', function (e) {
    report({ type: 'modError', modId: attribute(e.reason), where: 'promesa sin capturar', message: String(e.reason && e.reason.message || e.reason) });
  });
  window.addEventListener('error', function (e) {
    var id = attribute(e.error);
    if (id) report({ type: 'modError', modId: id, where: 'error en ejecución', message: String(e.message) });
  });

  function each(list, fn) { for (var i = 0; i < list.length; i++) fn(list[i], i); }
  function keysOf(o) { return Object.keys(o || {}); }

  // ------------------------------------------------------------------ events
  var listeners = {};
  var errorCount = {};
  var started = false; // true while a run is in progress (green flag clicked, not stopped)
  function call(entry, name, payload) {
    try { entry.fn(payload); } catch (e) {
      var k = entry.modId || '?';
      errorCount[k] = (errorCount[k] || 0) + 1;
      if (errorCount[k] <= 5) report({ type: 'modError', modId: entry.modId, where: 'evento ' + name, message: String(e && e.message || e) });
    }
  }
  function on(name, fn, modId) {
    var entry = { fn: fn, modId: modId || null };
    (listeners[name] = listeners[name] || []).push(entry);
    // Mods usually do async setup (read data files, load images) before subscribing, so by then
    // the game has long since started. gameStart is "state-like": a late subscriber still gets it.
    if (name === 'gameStart' && started) setTimeout(function () { call(entry, name, { late: true }); }, 0);
    return function off() {
      var l = listeners[name];
      var i = l ? l.indexOf(entry) : -1;
      if (i >= 0) l.splice(i, 1);
    };
  }
  function fire(name, payload) {
    var l = listeners[name];
    if (!l) return;
    each(l.slice(), function (entry) { call(entry, name, payload); });
  }
  core.fire = fire;

  // ------------------------------------------------------------------ patch helper (internal hooks + Pitch.patch)
  function wrapMethod(obj, name, make) {
    if (!obj || typeof obj[name] !== 'function') return null;
    var had = Object.prototype.hasOwnProperty.call(obj, name);
    var original = obj[name];
    obj[name] = make(original);
    return function unpatch() {
      if (had) obj[name] = original; else delete obj[name];
    };
  }

  // ------------------------------------------------------------------ target wrappers
  var wrappers = {}; // target.id -> wrapper (stable identity, keeps mod data)

  function findVar(target, name) {
    var vars = (target && target.variables) || {};
    var ids = keysOf(vars);
    for (var i = 0; i < ids.length; i++) if (vars[ids[i]].name === name) return vars[ids[i]];
    return null;
  }
  function stage() { return rt.getTargetForStage ? rt.getTargetForStage() : rt.targets.filter(function (t) { return t.isStage; })[0]; }

  function wrap(target) {
    if (!target) return null;
    if (wrappers[target.id]) return wrappers[target.id];
    var w = {
      id: target.id,
      isEntity: false,
      isClone: !target.isOriginal,
      data: {},
      get name() { return target.sprite ? target.sprite.name : target.id; },
      get x() { return target.x; },
      get y() { return target.y; },
      get direction() { return target.direction; },
      get visible() { return target.visible; },
      get size() { return target.size; },
      get exists() { return rt.targets.indexOf(target) >= 0; },
      setXY: function (x, y) { target.setXY(x, y); return w; },
      moveBy: function (dx, dy) { target.setXY(target.x + dx, target.y + dy); return w; },
      moveTowards: function (x, y, step) {
        var dx = x - target.x, dy = y - target.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < 0.0001) return w;
        var s = Math.min(step, d);
        target.setXY(target.x + dx / d * s, target.y + dy / d * s);
        return w;
      },
      distanceTo: function (x, y) { var dx = x - target.x, dy = y - target.y; return Math.sqrt(dx * dx + dy * dy); },
      setDirection: function (deg) { target.setDirection(deg); return w; },
      setSize: function (pct) { target.setSize(pct); return w; },
      show: function () { target.setVisible(true); return w; },
      hide: function () { target.setVisible(false); return w; },
      touching: function (other) {
        var name = typeof other === 'string' ? other : (other && other.name);
        return !!name && typeof target.isTouchingSprite === 'function' && !!target.isTouchingSprite(name);
      },
      getVariable: function (name) { var v = findVar(target, name); return v ? v.value : undefined; },
      setVariable: function (name, value) { var v = findVar(target, name); if (v) v.value = value; return !!v; },
      // Health / speed live in w.data so mods can read them next frame without touching Scratch variables.
      setHealth: function (n) { w.data.health = n; w.data.maxHealth = Math.max(w.data.maxHealth || 0, n); w.data.dead = false; return w; },
      getHealth: function () { return w.data.health; },
      heal: function (n) { w.data.health = Math.min(w.data.maxHealth || Infinity, (w.data.health || 0) + n); return w; },
      damage: function (n, source) {
        if (w.data.dead) return w;
        w.data.health = (w.data.health || 0) - n;
        fire('entityDamage', { entity: w, amount: n, health: w.data.health, source: source || null });
        if (w.data.health <= 0) { w.data.dead = true; fire('entityDeath', { entity: w, source: source || null }); }
        return w;
      },
      setSpeed: function (n) { w.data.speed = n; return w; },
      getSpeed: function () { return w.data.speed; },
      setCostume: function (ref) { return applyAsset(target, ref, { onlyIfDifferent: true }); },
      delete: function () {
        if (!w.exists) return;
        var id = target.id;
        try {
          if (target.isOriginal) vm.deleteSprite(id); else target.deleteClone();
        } catch (e) { rt.disposeTarget(target); rt.stopForTarget(target); }
        delete wrappers[id];
      },
      raw: target,
    };
    wrappers[target.id] = w;
    return w;
  }
  core.wrap = wrap;

  // ------------------------------------------------------------------ sprites, variables
  var sprites = {
    all: function (opts) {
      var withClones = opts && opts.clones;
      return rt.targets.filter(function (t) { return !t.isStage && (withClones || t.isOriginal); }).map(wrap);
    },
    find: function (name) {
      var t = rt.targets.filter(function (t) { return !t.isStage && t.isOriginal && t.sprite && t.sprite.name === name; })[0];
      return t ? wrap(t) : null;
    },
    getById: function (id) { var t = rt.getTargetById ? rt.getTargetById(id) : null; return t ? wrap(t) : null; },
    stage: function () { return wrap(stage()); },
  };

  var variables = {
    // Global variables live on the stage in Scratch; falls back to any sprite's local variable.
    get: function (name) {
      var v = findVar(stage(), name);
      if (!v) rt.targets.some(function (t) { v = findVar(t, name); return !!v; });
      return v ? v.value : undefined;
    },
    set: function (name, value) {
      var v = findVar(stage(), name);
      if (!v) rt.targets.some(function (t) { v = findVar(t, name); return !!v; });
      if (v) v.value = value;
      return !!v;
    },
  };

  // ------------------------------------------------------------------ game control
  var origStep = null;
  var game = {
    // "Running" = scripts are executing. (scratch-vm drives frames with _steppingInterval, TurboWarp with its
    // own frame loop, so the frame-loop handle is not a reliable signal across both; threads are.)
    isRunning: function () { return !!(rt.threads && rt.threads.length > 0); },
    isPaused: function () { return core.paused; },
    // scratch-vm has no pause of its own, so this freezes the frame loop (_step). Timers
    // such as "wait" keep counting in real time, which is the same limitation Scratch has
    // when a browser tab is hidden.
    pause: function () {
      if (core.paused) return;
      if (typeof rt._step !== 'function') throw new Error('Este runtime no permite pausar el juego.');
      origStep = rt._step;
      rt._step = function () { /* frozen by Pitch */ };
      core.paused = true;
      fire('gamePause', {});
    },
    resume: function () {
      if (!core.paused) return;
      if (origStep) { rt._step = origStep; origStep = null; } else delete rt._step;
      core.paused = false;
      fire('gameResume', {});
    },
    restart: function () { vm.greenFlag(); },
    stop: function () { rt.stopAll(); },
    stageSize: function () { return { width: rt.stageWidth || 480, height: rt.stageHeight || 360 }; },
  };

  // ------------------------------------------------------------------ native hooks -> Pitch events
  function safely(label, fn) {
    try { fn(); } catch (e) { report({ type: 'hookSkipped', hook: label, message: String(e && e.message || e) }); }
  }

  safely('runtime-events', function () {
    rt.on('PROJECT_START', function () { started = true; fire('gameStart', { late: false }); });
    rt.on('PROJECT_STOP_ALL', function () { started = false; fire('gameEnd', {}); });
    rt.on('targetWasCreated', function (t) {
      if (!t || t.isStage) return;
      fire(t.isOriginal ? 'spriteCreated' : 'cloneCreated', { sprite: wrap(t) });
    });
    rt.on('targetWasRemoved', function (t) {
      if (!t || t.isStage) return;
      fire(t.isOriginal ? 'spriteDeleted' : 'cloneDeleted', { sprite: { id: t.id, name: t.sprite ? t.sprite.name : t.id } });
      delete wrappers[t.id];
    });
  });

  // Every key press (real keyboard via the exporter, or injected by Pitch's gamepad layer)
  // goes through keyboard.postData, so hooking it is the one choke point.
  var keysDown = {};
  safely('keyboard', function () {
    var kb = rt.ioDevices && rt.ioDevices.keyboard;
    wrapMethod(kb, 'postData', function (orig) {
      return function (data) {
        var r = orig.apply(this, arguments);
        var key = data && data.key;
        if (key !== undefined) {
          var scratchKey = typeof this._keyStringToScratchKey === 'function' ? this._keyStringToScratchKey(key) : key;
          if (data.isDown && !keysDown[scratchKey]) { keysDown[scratchKey] = true; fire('keyDown', { key: key, scratchKey: scratchKey }); }
          else if (!data.isDown && keysDown[scratchKey]) { delete keysDown[scratchKey]; fire('keyUp', { key: key, scratchKey: scratchKey }); }
        }
        return r;
      };
    });
  });

  var mouseWasDown = false;
  safely('mouse', function () {
    var mouse = rt.ioDevices && rt.ioDevices.mouse;
    wrapMethod(mouse, 'postData', function (orig) {
      return function (data) {
        var r = orig.apply(this, arguments);
        if (data && typeof data.isDown === 'boolean' && data.isDown !== mouseWasDown) {
          mouseWasDown = data.isDown;
          fire(data.isDown ? 'mouseDown' : 'mouseUp', { x: this.getScratchX ? this.getScratchX() : data.x, y: this.getScratchY ? this.getScratchY() : data.y });
        }
        return r;
      };
    });
  });

  safely('broadcast', function () {
    wrapMethod(rt, 'startHats', function (orig) {
      return function (opcode, fields) {
        if (opcode === 'event_whenbroadcastreceived' && fields && fields.BROADCAST_OPTION !== undefined) {
          fire('broadcast', { name: String(fields.BROADCAST_OPTION) });
        }
        return orig.apply(this, arguments);
      };
    });
  });

  safely('costume', function () {
    var proto = Object.getPrototypeOf(rt.targets[rt.targets.length - 1]);
    wrapMethod(proto, 'setCostume', function (orig) {
      return function (index) {
        var before = this.currentCostume;
        var r = orig.apply(this, arguments);
        if (this.currentCostume !== before) fire('costumeChanged', { sprite: wrap(this), index: this.currentCostume });
        return r;
      };
    });
  });

  safely('sound', function () {
    var bank = null;
    rt.targets.some(function (t) { bank = t.sprite && t.sprite.soundBank; return !!bank; });
    if (!bank) throw new Error('no hay banco de sonidos todavía');
    wrapMethod(Object.getPrototypeOf(bank), 'playSound', function (orig) {
      return function (target, soundId) {
        fire('soundPlayed', { sprite: wrap(target), soundId: soundId });
        return orig.apply(this, arguments);
      };
    });
  });

  // tick: one per executed frame when the runtime exposes it, otherwise requestAnimationFrame.
  var lastTick = performance.now();
  function tick() {
    var now = performance.now();
    var dt = (now - lastTick) / 1000;
    lastTick = now;
    pollPlayers();
    fire('tick', { dt: dt });
    // variableChanged has no native event in scratch-vm, so it is derived by comparing values each frame.
    pollVariables();
  }
  var lastVars = {};
  function pollVariables() {
    each(rt.targets, function (t) {
      var vars = t.variables || {};
      each(keysOf(vars), function (id) {
        var key = t.id + ':' + id;
        var v = vars[id].value;
        if (key in lastVars && lastVars[key] !== v) fire('variableChanged', { sprite: wrap(t), name: vars[id].name, value: v, previous: lastVars[key] });
        lastVars[key] = v;
      });
    });
  }
  if (typeof rt.constructor.AFTER_EXECUTE === 'string') rt.on(rt.constructor.AFTER_EXECUTE, tick);
  else (function loop() { tick(); requestAnimationFrame(loop); })();

  // ------------------------------------------------------------------ players (Scratch has no "player": the mod says which sprite is)
  var playerDefs = [];
  var players = {
    define: function (opts) {
      var sp = sprites.find(opts.sprite);
      if (!sp) throw new Error('Pitch.players.define: no existe el sprite "' + opts.sprite + '".');
      var def = { w: sp, healthVariable: opts.healthVariable || null, deathAt: opts.deathAt === undefined ? 0 : opts.deathAt, lastX: sp.x, lastY: sp.y, lastHealth: opts.healthVariable ? sp.getVariable(opts.healthVariable) : undefined, dead: false, spawned: false };
      playerDefs.push(def);
      return sp;
    },
    get: function (i) { var d = playerDefs[i || 0]; return d ? d.w : null; },
    all: function () { return playerDefs.map(function (d) { return d.w; }); },
  };
  function pollPlayers() {
    each(playerDefs, function (d) {
      var w = d.w;
      if (!w.exists) return;
      if (!d.spawned && w.visible) { d.spawned = true; fire('playerSpawn', w); }
      if (w.x !== d.lastX || w.y !== d.lastY) {
        var dx = w.x - d.lastX, dy = w.y - d.lastY;
        d.lastX = w.x; d.lastY = w.y;
        fire('playerMove', { player: w, x: w.x, y: w.y, dx: dx, dy: dy });
      }
      if (d.healthVariable) {
        var h = w.getVariable(d.healthVariable);
        if (typeof h === 'number' && typeof d.lastHealth === 'number') {
          if (h < d.lastHealth) fire('playerDamage', { player: w, amount: d.lastHealth - h, health: h });
          if (h <= d.deathAt && !d.dead) { d.dead = true; fire('playerDeath', w); }
          else if (h > d.deathAt && d.dead) { d.dead = false; fire('playerSpawn', w); }
        }
        d.lastHealth = h;
      }
    });
  }

  // ------------------------------------------------------------------ files (served by the host from the mod's own folder)
  var pending = {};
  var seq = 0;
  function readFile(modId, relPath) {
    return new Promise(function (resolve, reject) {
      if (typeof window.__pitchReadFile !== 'function') { reject(new Error('Pitch no puede leer archivos del mod en este momento.')); return; }
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      window.__pitchReadFile(JSON.stringify({ id: id, modId: modId, path: String(relPath) }));
    });
  }
  window.__pitchFileReply = function (id, reply) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (!reply.ok) { p.reject(new Error(reply.error)); return; }
    var bin = atob(reply.b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    p.resolve({ bytes: bytes, mime: reply.mime });
  };
  core.readFile = readFile;

  // ------------------------------------------------------------------ assets (images & sounds)
  var registry = {}; // name -> { bytes, mime, format, w, h }
  var FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };

  function measure(bytes, mime) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth || 100, h: img.naturalHeight || 100 }); };
      img.onerror = function () { URL.revokeObjectURL(url); resolve({ w: 100, h: 100 }); };
      img.src = url;
    });
  }

  function resolveAsset(modId, ref) {
    if (registry[ref]) return Promise.resolve(registry[ref]);
    return registerAsset(modId, null, ref);
  }

  function registerAsset(modId, name, path) {
    return readFile(modId, path).then(function (file) {
      var format = FORMATS[file.mime];
      if (!format || format === 'wav' || format === 'mp3') throw new Error('"' + path + '" no es una imagen compatible (PNG, JPG o SVG).');
      return measure(file.bytes, file.mime).then(function (size) {
        var a = { bytes: file.bytes, mime: file.mime, format: format, w: size.w, h: size.h };
        if (name) registry[name] = a;
        return a;
      });
    });
  }

  function costumeFrom(a, costumeName) {
    var isSvg = a.format === 'svg';
    var asset = rt.storage.createAsset(
      isSvg ? rt.storage.AssetType.ImageVector : rt.storage.AssetType.ImageBitmap,
      isSvg ? rt.storage.DataFormat.SVG : (a.format === 'jpg' ? rt.storage.DataFormat.JPG : rt.storage.DataFormat.PNG),
      a.bytes, null, true);
    return {
      asset: asset,
      md5: asset.assetId + '.' + asset.dataFormat,
      name: costumeName,
      dataFormat: asset.dataFormat,
      bitmapResolution: 1,
      rotationCenterX: a.w / 2,
      rotationCenterY: a.h / 2,
    };
  }

  var assetCostumeNames = {}; // targetId -> { refKey: costumeName }
  function applyAsset(target, ref, opts, modId) {
    opts = opts || {};
    return resolveAsset(modId || null, ref).then(function (a) {
      var seen = assetCostumeNames[target.id] = assetCostumeNames[target.id] || {};
      if (opts.onlyIfDifferent && seen[ref]) {
        var idx = target.getCostumeIndexByName(seen[ref]);
        if (idx >= 0) { target.setCostume(idx); return wrap(target); }
      }
      var name = 'pitch-' + String(ref).replace(/[^a-z0-9._-]/gi, '_').slice(0, 30) + '-' + Math.floor(Math.random() * 1e6);
      return vm.addCostume(name + '.' + (a.format === 'svg' ? 'svg' : a.format), costumeFrom(a, name), target.id).then(function () {
        seen[ref] = name;
        return wrap(target);
      });
    });
  }

  function replaceCostume(target, ref, opts, modId) {
    opts = opts || {};
    var oldIndex = typeof opts.costume === 'number' ? opts.costume : (typeof opts.costume === 'string' ? target.getCostumeIndexByName(opts.costume) : target.currentCostume);
    if (oldIndex < 0 || oldIndex >= target.getCostumes().length) return Promise.reject(new Error('Ese disfraz no existe.'));
    var oldName = target.getCostumes()[oldIndex].name;
    return resolveAsset(modId, ref).then(function (a) {
      var tmpName = oldName + '__pitch_' + Date.now();
      return vm.addCostume(tmpName + '.' + (a.format === 'svg' ? 'svg' : a.format), costumeFrom(a, tmpName), target.id).then(function () {
        target.deleteCostume(oldIndex);                  // free the old name first...
        var newIndex = target.getCostumeIndexByName(tmpName);
        target.getCostumes()[newIndex].name = oldName;   // ...so scripts that switch by name keep working
        target.reorderCostume(newIndex, Math.min(oldIndex, target.getCostumes().length - 1));
        target.setCostume(target.getCostumeIndexByName(oldName));
        return wrap(target);
      });
    });
  }

  function addSoundFile(modId, target, path, soundName) {
    return readFile(modId, path).then(function (file) {
      var format = FORMATS[file.mime];
      if (format !== 'wav' && format !== 'mp3') throw new Error('"' + path + '" no es un sonido compatible (WAV o MP3).');
      var asset = rt.storage.createAsset(rt.storage.AssetType.Sound, format === 'mp3' ? rt.storage.DataFormat.MP3 : rt.storage.DataFormat.WAV, file.bytes, null, true);
      var sound = { asset: asset, md5: asset.assetId + '.' + asset.dataFormat, name: soundName, dataFormat: asset.dataFormat, format: '', rate: 44100, sampleCount: 0 };
      return vm.addSound(sound, target.id).then(function () { return soundName; });
    });
  }

  // ------------------------------------------------------------------ entities
  function uniqueSpriteName(base) {
    var names = rt.targets.map(function (t) { return t.sprite && t.sprite.name; });
    if (names.indexOf(base) < 0) return base;
    var i = 2;
    while (names.indexOf(base + i) >= 0) i++;
    return base + i;
  }

  var entityList = [];
  function entitiesCreate(modId, opts) {
    opts = opts || {};
    var base = opts.baseOn ? sprites.find(opts.baseOn) : sprites.all()[0];
    if (!base) return Promise.reject(new Error('Pitch.entities.create: el juego no tiene ningún sprite del que partir (usa baseOn).'));
    var before = {};
    each(rt.targets, function (t) { before[t.id] = true; });
    return vm.duplicateSprite(base.id).then(function () {
      var created = rt.targets.filter(function (t) { return !before[t.id]; })[0];
      if (!created) throw new Error('Pitch.entities.create: scratch-vm no devolvió el sprite nuevo.');
      // duplicateSprite copies the base sprite's scripts too; a new entity must not inherit
      // (say) the player's controls, so its scripts are removed. Behaviour comes from the mod.
      rt.stopForTarget(created);
      each(created.blocks.getScripts().slice(), function (id) { created.blocks.deleteBlock(id); });
      created.sprite.name = uniqueSpriteName(opts.id || 'entity');
      if (typeof opts.x === 'number' || typeof opts.y === 'number') {
        created.setXY(typeof opts.x === 'number' ? opts.x : created.x, typeof opts.y === 'number' ? opts.y : created.y);
      }
      var w = wrap(created);
      w.isEntity = true;
      if (opts.data) keysOf(opts.data).forEach(function (k) { w.data[k] = opts.data[k]; });
      if (typeof opts.health === 'number') w.setHealth(opts.health);
      if (typeof opts.speed === 'number') w.setSpeed(opts.speed);
      entityList.push(w);
      var done = function () { fire('entityCreated', { entity: w }); return w; };
      if (!opts.sprite) return done();
      // The entity should look like the new asset only, not like the base sprite it was cloned from.
      return resolveAsset(modId, opts.sprite).then(function (a) {
        var n = 'pitch-entity-' + Math.floor(Math.random() * 1e6);
        var count = created.getCostumes().length;
        return vm.addCostume(n + '.' + (a.format === 'svg' ? 'svg' : a.format), costumeFrom(a, n), created.id).then(function () {
          for (var i = 0; i < count; i++) created.deleteCostume(0);
          created.setCostume(0);
          return done();
        });
      });
    });
  }
  var entities = {
    all: function () { entityList = entityList.filter(function (e) { return e.exists; }); return entityList.slice(); },
    find: function (name) { return entities.all().filter(function (e) { return e.name === name; })[0] || null; },
  };

  // ------------------------------------------------------------------ Pitch.patch (per-mod, tracked for conflicts)
  function resolvePatchTarget(path) {
    var parts = String(path).split('.');
    var method = parts.pop();
    var ns = parts.join('.');
    var obj = null;
    if (ns === 'Target' || ns === 'Sprite') obj = Object.getPrototypeOf(rt.targets[rt.targets.length - 1]);
    else if (ns === 'Runtime') obj = rt;
    else if (ns === 'VM') obj = vm;
    else if (ns === 'Keyboard') obj = rt.ioDevices && rt.ioDevices.keyboard;
    else if (ns === 'Mouse') obj = rt.ioDevices && rt.ioDevices.mouse;
    return { obj: obj, method: method };
  }

  function patchFor(modId) {
    return function patch(path, wrapper) {
      var t = resolvePatchTarget(path);
      if (!t.obj || typeof t.obj[t.method] !== 'function') {
        throw new Error('Pitch.patch: no se puede interceptar "' + path + '". Admitidos: Target.*, Runtime.*, VM.*, Keyboard.*, Mouse.* (con un método existente).');
      }
      var un = wrapMethod(t.obj, t.method, wrapper);
      var owners = core.patchOwners[path] = core.patchOwners[path] || [];
      if (owners.indexOf(modId) < 0) owners.push(modId);
      if (owners.length > 1) report({ type: 'patchConflict', path: path, mods: owners.slice() });
      return un;
    };
  }

  // ------------------------------------------------------------------ input
  var input = {
    isKeyDown: function (key) {
      var kb = rt.ioDevices && rt.ioDevices.keyboard;
      if (!kb) return false;
      var k = typeof kb._keyStringToScratchKey === 'function' ? kb._keyStringToScratchKey(key) : key;
      return !!kb.getKeyIsDown(k);
    },
    mouse: function () {
      var m = rt.ioDevices && rt.ioDevices.mouse;
      return m ? { x: m.getScratchX(), y: m.getScratchY(), isDown: m.getIsDown() } : null;
    },
    gamepads: function () {
      var list = navigator.getGamepads ? navigator.getGamepads() : [];
      return Array.prototype.filter.call(list, Boolean).map(function (g) { return { id: g.id, index: g.index }; });
    },
  };

  // ------------------------------------------------------------------ per-mod facade with permission gating
  // This is the object a mod receives as `Pitch`. Namespaces a mod did not declare a
  // permission for throw a clear error. NOTE: this is API-level gating, not a sandbox: a
  // mod runs inside the game's own page, and Pitch tells the user so.
  function gate(P, modId, ns, perm) {
    Object.defineProperty(P, ns, { get: function () { throw new Error('El mod "' + modId + '" necesita el permiso "' + perm + '" para usar Pitch.' + ns + '. Añádelo a "permissions" en mod.json.'); } });
  }

  core.forMod = function (meta) {
    var id = meta.id;
    var perms = meta.permissions || [];
    var has = function (p) { return perms.indexOf(p) >= 0; };
    core.mods[id] = meta;
    var P = {
      version: API_VERSION,
      mod: { id: id, name: meta.name, version: meta.version },
      log: function () { console.log.apply(console, ['[mod:' + id + ']'].concat(Array.prototype.slice.call(arguments))); },
      files: {
        read: function (p) { return readFile(id, p).then(function (f) { return f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength); }); },
        readText: function (p) { return readFile(id, p).then(function (f) { return new TextDecoder().decode(f.bytes); }); },
        readJSON: function (p) { return readFile(id, p).then(function (f) { return JSON.parse(new TextDecoder().decode(f.bytes)); }); },
      },
    };

    if (has('game')) {
      P.game = game;
      P.sprites = sprites;
      P.variables = variables;
      P.players = players;
      P.entities = { all: entities.all, find: entities.find, create: function (o) { return entitiesCreate(id, o); } };
      P.events = {
        on: function (name, fn) { return on(name, fn, id); },
        once: function (name, fn) { var off = on(name, function (p) { off(); fn(p); }, id); return off; },
      };
      P.patch = patchFor(id);
    } else {
      ['game', 'sprites', 'variables', 'players', 'entities', 'events', 'patch'].forEach(function (ns) { gate(P, id, ns, 'game'); });
    }

    if (has('graphics')) {
      P.assets = {
        register: function (name, path) { return registerAsset(id, name, path).then(function () { return name; }); },
        has: function (name) { return !!registry[name]; },
        replace: function (spriteName, ref, o) {
          var sp = sprites.find(spriteName);
          if (!sp) return Promise.reject(new Error('Pitch.assets.replace: no existe el sprite "' + spriteName + '".'));
          return replaceCostume(sp.raw, ref, o, id);
        },
        addSound: function (spriteName, path, soundName) {
          var sp = sprites.find(spriteName) || sprites.stage();
          if (!sp) return Promise.reject(new Error('Pitch.assets.addSound: no existe "' + spriteName + '".'));
          return addSoundFile(id, sp.raw, path, soundName || path);
        },
        replaceSound: function (spriteName, soundName, path) {
          var sp = sprites.find(spriteName) || sprites.stage();
          if (!sp) return Promise.reject(new Error('Pitch.assets.replaceSound: no existe "' + spriteName + '".'));
          var t = sp.raw;
          var oldIndex = -1;
          t.getSounds().forEach(function (s, i) { if (s.name === soundName) oldIndex = i; });
          if (oldIndex < 0) return Promise.reject(new Error('Ese sonido no existe en el sprite.'));
          var tmp = soundName + '__pitch_' + Date.now();
          return addSoundFile(id, t, path, tmp).then(function () {
            vm.deleteSound(oldIndex, t.id);
            var idx = t.getSounds().map(function (s) { return s.name; }).indexOf(tmp);
            t.getSounds()[idx].name = soundName;
            return soundName;
          });
        },
      };
    } else gate(P, id, 'assets', 'graphics');

    if (has('audio')) P.audio = core.makeAudio(id); else gate(P, id, 'audio', 'audio');

    if (has('storage')) {
      var prefix = 'pitch-mod:' + id + ':';
      P.storage = {
        get: function (k) { try { return JSON.parse(localStorage.getItem(prefix + k)); } catch (e) { return null; } },
        set: function (k, v) { localStorage.setItem(prefix + k, JSON.stringify(v)); },
        remove: function (k) { localStorage.removeItem(prefix + k); },
      };
    } else gate(P, id, 'storage', 'storage');

    if (has('ui')) P.ui = core.makeUI(id); else gate(P, id, 'ui', 'ui');
    if (has('input')) P.input = input; else gate(P, id, 'input', 'input');

    return P;
  };

  // Called by the host right after the core is installed and BEFORE any mod loads: if the project
  // is already running when Pitch attaches, mods that subscribe to gameStart still get it.
  core.syncStarted = function () { if (!started && game.isRunning()) started = true; };
  core.version = API_VERSION;

  report({ type: 'coreReady', flavor: flavor, targets: rt.targets.length });
})(__VM_EXPR__, __FLAVOR__);
