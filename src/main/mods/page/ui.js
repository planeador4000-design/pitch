// Runs INSIDE the game's page, after core.js. Provides core.makeUI(modId) and core.makeAudio(modId),
// which core.forMod() hands to a mod only when it declared the "ui" / "audio" permission.
(function () {
  'use strict';
  var core = window.__PitchCore;
  if (!core || core.makeUI) return;

  // ---------------------------------------------------------------- overlay root (Shadow DOM)
  // A shadow root keeps the mod's UI from inheriting, or breaking, the game's own CSS.
  var CSS = [
    ':host{all:initial}',
    '.layer{position:fixed;inset:0;pointer-events:none;font:14px/1.4 system-ui,Segoe UI,sans-serif;color:#eafcff}',
    '.win{position:absolute;pointer-events:auto;background:#0d161d;border:1px solid #1f3543;border-radius:12px;box-shadow:0 18px 40px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}',
    '.bar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#15232d;cursor:move;user-select:none;font-weight:700}',
    '.bar .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.x{all:unset;cursor:pointer;padding:0 6px;border-radius:6px;color:#8fb2bc}.x:hover{background:#1f3543;color:#fff}',
    '.body{padding:10px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:8px}',
    '.btn{all:unset;box-sizing:border-box;pointer-events:auto;cursor:pointer;padding:7px 14px;border-radius:999px;background:#5ce1e6;color:#04262b;font-weight:700;text-align:center}',
    '.btn:hover{filter:brightness(1.08)}',
    '.txt{pointer-events:none;white-space:pre-wrap;text-shadow:0 1px 3px rgba(0,0,0,.7)}',
    '.meter{height:12px;border-radius:999px;background:rgba(255,255,255,.2);overflow:hidden;pointer-events:none}',
    '.meter>i{display:block;height:100%;background:#5ce1e6;border-radius:999px}',
    '.abs{position:absolute}',
    '.toast{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);padding:9px 16px;border-radius:12px;background:#15232d;border:1px solid #1f3543;box-shadow:0 10px 24px rgba(0,0,0,.4);pointer-events:none}',
  ].join('');

  function layer() {
    if (core.uiLayer) return core.uiLayer;
    var host = document.createElement('div');
    host.setAttribute('data-pitch-ui', '');
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';
    var shadow = host.attachShadow({ mode: 'open' });
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
      var st = document.createElement('style');
      st.textContent = CSS;
      shadow.appendChild(st);
    }
    var div = document.createElement('div');
    div.className = 'layer';
    shadow.appendChild(div);
    (document.body || document.documentElement).appendChild(host);
    core.uiLayer = div;
    return div;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function place(e, o) {
    e.classList.add('abs');
    if (o && o.x !== undefined) e.style.left = o.x + 'px';
    if (o && o.y !== undefined) e.style.top = o.y + 'px';
    if (o && o.right !== undefined) e.style.right = o.right + 'px';
    if (o && o.bottom !== undefined) e.style.bottom = o.bottom + 'px';
    if (o && o.width !== undefined) e.style.width = o.width + 'px';
  }

  core.makeUI = function (modId) {
    var owned = [];
    function track(node) { owned.push(node); return node; }

    function addContent(container) {
      return {
        addText: function (text) { var t = el('div', 'txt', text); container.appendChild(t); return { setText: function (s) { t.textContent = s; }, remove: function () { t.remove(); } }; },
        addButton: function (label, onClick) {
          var b = el('button', 'btn', label);
          b.addEventListener('click', function () { try { onClick && onClick(); } catch (e) { core.report({ type: 'modError', modId: modId, where: 'botón "' + label + '"', message: String(e && e.message || e) }); } });
          container.appendChild(b);
          return { setLabel: function (s) { b.textContent = s; }, remove: function () { b.remove(); } };
        },
        addBar: function (o) {
          o = o || {};
          var m = el('div', 'meter'); var i = el('i'); m.appendChild(i); container.appendChild(m);
          var max = o.max || 100;
          function set(v) { i.style.width = Math.max(0, Math.min(100, v / max * 100)) + '%'; }
          if (o.color) i.style.background = o.color;
          set(o.value === undefined ? max : o.value);
          return { set: set, remove: function () { m.remove(); } };
        },
      };
    }

    return {
      createWindow: function (o) {
        o = o || {};
        var win = el('div', 'win');
        win.style.left = (o.x !== undefined ? o.x : 40) + 'px';
        win.style.top = (o.y !== undefined ? o.y : 40) + 'px';
        win.style.width = (o.width || 320) + 'px';
        if (o.height) win.style.height = o.height + 'px';
        var bar = el('div', 'bar');
        var title = el('span', 't', o.title || modId);
        var close = el('button', 'x', '\u00d7');
        bar.appendChild(title); bar.appendChild(close);
        var body = el('div', 'body');
        win.appendChild(bar); win.appendChild(body);
        layer().appendChild(track(win));

        close.addEventListener('click', function () { win.style.display = 'none'; });
        var drag = null;
        bar.addEventListener('pointerdown', function (e) {
          if (e.target === close) return;
          drag = { dx: e.clientX - win.offsetLeft, dy: e.clientY - win.offsetTop };
          bar.setPointerCapture(e.pointerId);
        });
        bar.addEventListener('pointermove', function (e) { if (drag) { win.style.left = (e.clientX - drag.dx) + 'px'; win.style.top = (e.clientY - drag.dy) + 'px'; } });
        bar.addEventListener('pointerup', function () { drag = null; });

        var api = addContent(body);
        api.body = body; // raw element for custom DOM
        api.setTitle = function (s) { title.textContent = s; };
        api.show = function () { win.style.display = 'flex'; };
        api.hide = function () { win.style.display = 'none'; };
        api.close = function () { win.remove(); };
        return api;
      },

      // HUD pieces sit directly on the game, positioned in page pixels.
      text: function (o) {
        o = o || {};
        var t = el('div', 'txt', o.text || ''); place(t, o);
        if (o.color) t.style.color = o.color;
        if (o.size) t.style.fontSize = o.size + 'px';
        layer().appendChild(track(t));
        return { setText: function (s) { t.textContent = s; }, hide: function () { t.style.display = 'none'; }, show: function () { t.style.display = ''; }, remove: function () { t.remove(); } };
      },
      bar: function (o) {
        o = o || {};
        var m = el('div', 'meter'); var i = el('i'); m.appendChild(i);
        place(m, o); if (!o.width) m.style.width = '160px';
        var max = o.max || 100;
        if (o.color) i.style.background = o.color;
        function set(v) { i.style.width = Math.max(0, Math.min(100, v / max * 100)) + '%'; }
        set(o.value === undefined ? max : o.value);
        layer().appendChild(track(m));
        return { set: set, hide: function () { m.style.display = 'none'; }, show: function () { m.style.display = ''; }, remove: function () { m.remove(); } };
      },
      button: function (o) {
        o = o || {};
        var b = el('button', 'btn', o.text || 'OK'); place(b, o);
        b.addEventListener('click', function () { try { o.onClick && o.onClick(); } catch (e) { core.report({ type: 'modError', modId: modId, where: 'botón', message: String(e && e.message || e) }); } });
        layer().appendChild(track(b));
        return { setLabel: function (s) { b.textContent = s; }, remove: function () { b.remove(); } };
      },
      toast: function (message, ms) {
        var t = el('div', 'toast', message);
        layer().appendChild(t);
        setTimeout(function () { t.remove(); }, ms || 3000);
      },
      removeAll: function () { owned.forEach(function (n) { n.remove(); }); owned = []; },
    };
  };

  // ---------------------------------------------------------------- audio (independent of Scratch's own sounds)
  var urls = {};
  var playing = [];
  core.makeAudio = function (modId) {
    function urlFor(path) {
      if (urls[modId + ':' + path]) return Promise.resolve(urls[modId + ':' + path]);
      return core.readFile(modId, path).then(function (f) {
        var u = URL.createObjectURL(new Blob([f.bytes], { type: f.mime }));
        urls[modId + ':' + path] = u;
        return u;
      });
    }
    return {
      play: function (path, o) {
        o = o || {};
        return urlFor(path).then(function (u) {
          var a = new Audio(u);
          a.volume = o.volume === undefined ? 1 : Math.max(0, Math.min(1, o.volume));
          a.loop = !!o.loop;
          playing.push(a);
          a.addEventListener('ended', function () { var i = playing.indexOf(a); if (i >= 0) playing.splice(i, 1); });
          // Browsers refuse to start audio before the player has interacted with the page: retry on the first key/click.
          return a.play().catch(function () {
            var retry = function () { document.removeEventListener('pointerdown', retry, true); document.removeEventListener('keydown', retry, true); a.play().catch(function () {}); };
            document.addEventListener('pointerdown', retry, true);
            document.addEventListener('keydown', retry, true);
          }).then(function () {
            return { stop: function () { a.pause(); a.currentTime = 0; }, setVolume: function (v) { a.volume = Math.max(0, Math.min(1, v)); } };
          });
        });
      },
      stopAll: function () { playing.slice().forEach(function (a) { a.pause(); a.currentTime = 0; }); playing = []; },
    };
  };
})();
