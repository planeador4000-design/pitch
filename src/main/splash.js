'use strict';

const path = require('node:path');
const { BrowserWindow } = require('electron');

// A frameless, borderless splash that appears the instant "Jugar" is pressed and closes
// itself once the game's own window has had time to appear (or after a hard timeout, in
// case the game is one of the slow-to-open Electron exports).
function showLoadingSplash({ title, cover, theme }) {
  const win = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: theme === 'light' ? '#ffffff' : '#05080c',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);

  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:${theme === 'light' ? 'light' : 'dark'}}
    html,body{margin:0;height:100%;font:600 15px/1.4 'Segoe UI',system-ui,-apple-system,sans-serif;
      background:${theme === 'light' ? '#ffffff' : '#05080c'};color:${theme === 'light' ? '#0a2530' : '#eafcff'};
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
      -webkit-app-region:drag;user-select:none;overflow:hidden}
    .art{width:96px;height:96px;border-radius:20px;overflow:hidden;box-shadow:0 14px 30px -12px rgb(0 0 0 / 0.5);
      background:linear-gradient(145deg,#5ce1e6,#1c8fa8);display:flex;align-items:center;justify-content:center;
      font-size:40px;font-weight:800;color:#fff}
    .art img{width:100%;height:100%;object-fit:cover}
    .title{font-size:16px;font-weight:700;letter-spacing:-0.01em}
    .bar{width:200px;height:5px;border-radius:999px;background:${theme === 'light' ? '#dff' : 'rgba(255,255,255,.15)'};overflow:hidden}
    .bar i{display:block;width:40%;height:100%;background:#5ce1e6;border-radius:999px;animation:s 1.1s ease-in-out infinite alternate}
    @keyframes s{from{margin-left:0}to{margin-left:60%}}
  </style></head><body>
    <div class="art">${cover ? `<img src="${escape(cover)}">` : escape((title || '?').trim()[0] || '?').toUpperCase()}</div>
    <div class="title">Abriendo ${escape(title || 'el juego')}…</div>
    <div class="bar"><i></i></div>
  </body></html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.once('ready-to-show', () => win.show());
  return win;
}

module.exports = { showLoadingSplash };
