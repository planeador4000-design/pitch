'use strict';

const api = window.pitch;

// ---------- tiny helpers ----------

const $ = (selector, root = document) => root.querySelector(selector);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

// Native Element.append() stringifies null/undefined into literal "null"/"undefined"
// text nodes instead of skipping them (unlike our h() helper above), so any place that
// appends to an already-built element (rather than passing children to h() itself) goes
// through this instead.
function append(el, ...nodes) {
  el.append(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false));
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  play: [['path', { d: 'M8 5.5v13l11-6.5z' }]],
  download: [['path', { d: 'M12 4v11M7 11l5 5 5-5M5 20h14' }]],
  update: [['path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.5-6' }], ['path', { d: 'M20 4v5h-5' }]],
  folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  trash: [['path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' }]],
  external: [['path', { d: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]],
  close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  chevronL: [['path', { d: 'M15 6l-6 6 6 6' }]],
  shortcut: [['path', { d: 'M12 3v12M7 8l5-5 5 5M5 21h14' }]],
  phone: [['path', { d: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z' }]],
  discord: [
    [
      'path',
      {
        d: 'M20 6.5c-1.4-.7-2.9-1.1-4.4-1.4l-.2.5c1.3.3 2.6.8 3.8 1.5-2-1-4.2-1.6-6.5-1.6s-4.5.5-6.5 1.6c1.2-.7 2.5-1.2 3.8-1.5l-.2-.5C8.3 5.4 6.8 5.8 5.4 6.5 3.6 9.2 2.9 12 3.1 14.8c1.6 1.2 3.2 1.9 4.7 2.4l.6-1c-.8-.3-1.6-.7-2.3-1.2.2-.1.4-.3.6-.4 2 .9 4.2 1.4 6.3 1.4s4.3-.5 6.3-1.4c.2.1.4.3.6.4-.7.5-1.5.9-2.3 1.2l.6 1c1.5-.5 3.1-1.2 4.7-2.4.3-3.4-.6-6.1-2-8.3zM9.5 13.3c-.8 0-1.4-.8-1.4-1.7s.6-1.7 1.4-1.7 1.4.8 1.4 1.7-.6 1.7-1.4 1.7zm5 0c-.8 0-1.4-.8-1.4-1.7s.6-1.7 1.4-1.7 1.4.8 1.4 1.7-.6 1.7-1.4 1.7z',
      },
    ],
  ],
};

function icon(name, extra) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (extra) svg.setAttribute('class', extra);
  if (name === 'play') svg.classList.add('filled');
  for (const [tag, attrs] of ICONS[name]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
const dateFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
const numFmt = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });

function ago(timestamp) {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'hace un momento';
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86400), 'day');
}

function bytes(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return `${numFmt.format(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${numFmt.format(n / 1024 ** 2)} MB`;
  return `${numFmt.format(n / 1024 ** 3)} GB`;
}

function playtime(seconds) {
  if (!seconds) return 'Aún sin jugar';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'Menos de 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function hash(text) {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return n;
}

function initial(title) {
  return ([...String(title || '').trim()][0] || '?').toUpperCase();
}

async function run(promise) {
  const res = await promise;
  if (res && !res.ok) toast(res.error, 'amber');
  return res;
}

// ---------- state ----------

let state = null;
let discordState = { configured: false, connected: false, user: null, linked: false };
let discordFriends = null; // null = not loaded yet, undefined = not permitted, array = loaded
let route = { name: 'home' };
let query = '';

const pageEl = $('#page');
const navButtons = [...document.querySelectorAll('.nav button')];

// ---------- covers ----------

const TONES = 6;

function coverNode(game) {
  const letter = h('span', { class: 'cover-letter', 'aria-hidden': 'true', text: initial(game.title) });
  const node = h('span', { class: 'cover', 'data-tone': hash(game.id) % TONES }, letter);
  if (game.cover) {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.hidden = true;
    img.addEventListener('load', () => {
      img.hidden = false;
      letter.hidden = true;
    });
    img.addEventListener('error', () => img.remove());
    img.src = game.cover;
    node.append(img);
  }
  return node;
}

function coverBg(g) {
  if (!g.banner && !g.cover) return h('span', { class: 'cover cover-fill', 'data-tone': hash(g.id) % TONES });
  const img = new Image();
  img.alt = '';
  img.src = g.banner || g.cover;
  return img;
}

// ---------- routing ----------

function go(next) {
  route = next;
  try {
    if (next.name === 'game') localStorage.setItem('pitch:lastGame', next.id);
  } catch {
    /* ignore */
  }
  render();
  pageEl.scrollTop = 0;
  pageEl.focus({ preventScroll: true });
}

for (const btn of navButtons) {
  btn.addEventListener('click', () => go({ name: btn.dataset.nav }));
}

$('#search').addEventListener('input', (event) => {
  query = event.target.value;
  if (query.trim() && route.name !== 'search') go({ name: 'search' });
  else if (!query.trim() && route.name === 'search') go({ name: 'home' });
  else render();
});

// ---------- badges & primary action ----------

function badgeFor(g) {
  if (g.busy) return { text: g.busy.kind === 'update' ? 'Actualizando' : 'Instalando', tone: 'soft' };
  if (g.running) return { text: 'Jugando', tone: 'green' };
  if (g.error) return { text: 'Error', tone: 'red' };
  if (g.updateAvailable) return { text: 'Actualizar', tone: 'amber' };
  if (!g.installed && g.featured) return { text: 'Destacado', tone: null };
  return null;
}

function primaryAction(g) {
  if (g.busy) return { label: 'Descargando', tone: 'muted', icon: 'download', disabled: true, live: true };
  if (g.running) return { label: 'En ejecución', tone: 'running', icon: 'play', disabled: true };
  if (g.installed && g.updateAvailable) return { label: `Actualizar a ${g.latest.tag}`, tone: 'amber', icon: 'update', run: () => api.install(g.id) };
  if (g.installed) return { label: 'Jugar', tone: null, icon: 'play', run: () => window.pitchMods.play(g) };
  if (g.unavailable) return { label: 'No disponible', tone: 'muted', icon: 'download', disabled: true };
  if (g.latest) return { label: 'Instalar', tone: null, icon: 'download', run: () => api.install(g.id) };
  return { label: 'Buscando versión…', tone: 'muted', icon: 'download', disabled: true };
}

function busyLabel(b) {
  if (b.phase === 'extracting') return b.kind === 'update' ? 'Actualizando…' : 'Instalando…';
  if (b.phase === 'downloading' && b.total) return `Descargando ${Math.floor((b.received / b.total) * 100)} %`;
  if (b.phase === 'downloading') return 'Descargando…';
  return 'Preparando…';
}

// ---------- cards & shelves ----------

function card(g) {
  const badge = badgeFor(g);
  return h(
    'button',
    { class: 'card', type: 'button', onclick: () => go({ name: 'game', id: g.id }) },
    h('span', { class: 'card-art' }, coverNode(g), badge ? h('span', { class: 'pill', 'data-tone': badge.tone, text: badge.text }) : null),
    h('span', { class: 'card-title', text: g.title }),
    h('span', { class: 'card-sub', text: g.author }),
  );
}

function shelf(title, games, { scroller = true } = {}) {
  if (!games.length) return null;
  return h(
    'section',
    { class: 'shelf' },
    h('div', { class: 'shelf-head' }, h('h2', { text: title })),
    h('div', { class: scroller ? 'track' : 'grid' }, ...games.map(card)),
  );
}

// ---------- home page (Disney+-like front page) ----------

let heroIndex = 0;
let heroTimer = null;

function buildHero(featured) {
  clearInterval(heroTimer);
  if (!featured.length) return null;
  heroIndex = heroIndex % featured.length;

  const paint = () => {
    const g = featured[heroIndex];
    const bgWrap = h('div', { class: `hero-bg${g.banner ? '' : ' is-cover'}` }, coverBg(g));
    const action = primaryAction(g);
    const body = h(
      'div',
      { class: 'hero-body' },
      h('span', { class: 'eyebrow', text: 'Destacado' }),
      h('h1', { text: g.title }),
      g.tags.length ? h('ul', { class: 'hero-meta' }, ...g.tags.slice(0, 4).map((t) => h('li', { text: t }))) : null,
      g.description ? h('p', { class: 'desc', text: g.description }) : null,
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          { class: 'cta', 'data-tone': action.tone, disabled: action.disabled, onclick: action.run ? () => run(action.run()) : null },
          icon(action.icon),
          h('span', { text: action.label }),
        ),
        h('button', { class: 'cta glass', type: 'button', onclick: () => go({ name: 'game', id: g.id }) }, h('span', { text: 'Ver más' })),
      ),
    );
    return { bgWrap, body };
  };

  const host = h('div', { class: 'hero' });
  const rebuild = () => {
    const { bgWrap, body } = paint();
    const dots = h(
      'div',
      { class: 'dots' },
      ...featured.map((_, i) =>
        h('button', {
          type: 'button',
          'aria-current': i === heroIndex ? 'true' : null,
          'aria-label': `Destacado ${i + 1}`,
          onclick: () => {
            heroIndex = i;
            rebuild();
            resetTimer();
          },
        }),
      ),
    );
    host.replaceChildren(bgWrap, body, featured.length > 1 ? dots : null);
  };
  const resetTimer = () => {
    clearInterval(heroTimer);
    if (featured.length > 1) {
      heroTimer = setInterval(() => {
        heroIndex = (heroIndex + 1) % featured.length;
        rebuild();
      }, 7000);
    }
  };
  rebuild();
  resetTimer();
  return host;
}

function buildHome() {
  const installed = state.games.filter((g) => g.installed);
  const running = state.games.filter((g) => g.running);
  const updates = state.games.filter((g) => g.updateAvailable);
  const featured = state.games.filter((g) => g.featured);
  const byTag = new Map();
  for (const g of state.games) for (const t of g.tags) byTag.set(t, [...(byTag.get(t) || []), g]);

  const rest = state.games.filter((g) => !g.featured);
  const frag = h('div', {});
  const hero = buildHero(featured.length ? featured : state.games.slice(0, 5));
  if (hero) append(frag, hero);

  if (updates.length) {
    frag.append(
      h(
        'div',
        { class: 'banner' },
        icon('update'),
        h('p', { text: `Tienes ${updates.length} ${updates.length === 1 ? 'actualización disponible' : 'actualizaciones disponibles'}.` }),
        h('button', { class: 'ghost', type: 'button', onclick: () => go({ name: 'library' }) }, h('span', { text: 'Ver' })),
      ),
    );
  }

  append(
    frag,
    shelf('Continuar jugando', installed.sort((a, b) => (b.installed.lastPlayedAt || 0) - (a.installed.lastPlayedAt || 0))),
    shelf('En ejecución', running),
    shelf('Todo el catálogo', rest.length ? rest : state.games),
  );
  for (const [tag, games] of byTag) {
    if (games.length >= 2) append(frag, shelf(tag[0].toUpperCase() + tag.slice(1), games));
  }
  return frag;
}

// ---------- library page ----------

function buildLibrary() {
  const installed = state.games.filter((g) => g.installed).sort((a, b) => a.title.localeCompare(b.title, 'es'));
  const available = state.games.filter((g) => !g.installed).sort((a, b) => a.title.localeCompare(b.title, 'es'));
  return h(
    'div',
    {},
    h('h1', { class: 'page-title', text: 'Biblioteca' }),
    installed.length
      ? shelf('Instalados', installed, { scroller: false })
      : h('p', { class: 'page-sub', text: 'Todavía no has instalado ningún juego.' }),
    shelf('Disponibles', available, { scroller: false }),
  );
}

// ---------- search ----------

function buildSearch() {
  const q = query.trim().toLowerCase();
  const results = state.games.filter(
    (g) => g.title.toLowerCase().includes(q) || g.author.toLowerCase().includes(q) || g.tags.some((t) => t.toLowerCase().includes(q)),
  );
  return h(
    'div',
    {},
    h('h1', { class: 'page-title', text: `Resultados para "${query.trim()}"` }),
    results.length ? h('div', { class: 'grid' }, ...results.map(card)) : h('p', { class: 'page-sub', text: 'Ningún juego coincide con tu búsqueda.' }),
  );
}

// ---------- empty state ----------

function buildEmpty() {
  const catalogProblem = state.sync.catalogError;
  return h(
    'section',
    { class: 'empty' },
    h('img', { src: 'assets/logo-icon.png', alt: '' }),
    h('h2', { text: state.settings.catalog ? 'Aún no hay juegos que mostrar' : 'Todavía no hay juegos' }),
    h('p', { text: catalogProblem || 'Conecta el catálogo de un repositorio de GitHub para empezar.' }),
    h('div', { class: 'actions' }, h('button', { class: 'solid', type: 'button', onclick: () => go({ name: 'settings' }), text: 'Ir a ajustes' })),
  );
}

// ---------- game detail page ----------

let live = {};

function confirmable(button, armedLabel, action) {
  let timer = null;
  const original = [...button.childNodes];
  button.addEventListener('click', () => {
    if (button.hasAttribute('data-armed')) {
      clearTimeout(timer);
      action();
      return;
    }
    button.setAttribute('data-armed', '');
    button.replaceChildren(icon('trash'), document.createTextNode(armedLabel));
    timer = setTimeout(() => {
      button.removeAttribute('data-armed');
      button.replaceChildren(...original);
    }, 3500);
  });
}

async function createShortcut(g) {
  const res = await run(api.createShortcut(g.id));
  if (res && res.ok) toast(`Acceso directo creado para ${g.title}.`, 'green');
}

function buildGame(g) {
  live = {};
  const action = primaryAction(g);
  const cta = h(
    'button',
    { class: 'cta', 'data-tone': action.tone, disabled: action.disabled, onclick: action.run ? () => run(action.run()) : null },
    icon(action.icon),
    h('span', { text: action.label }),
  );
  if (action.live) live.ctaLabel = cta.lastChild;

  const actions = h('div', { class: 'actions-row' }, cta);
  if (g.installed && g.updateAvailable && !g.busy && !g.running) {
    actions.append(h('button', { class: 'ghost', type: 'button', onclick: () => run(window.pitchMods.play(g)) }, icon('play'), document.createTextNode('Jugar ahora')));
  }
  if (g.busy) {
    const bar = h('i');
    const meter = h('div', { class: 'meter', role: 'progressbar', 'aria-label': 'Progreso de la descarga' }, bar);
    live.bar = bar;
    live.meter = meter;
    live.detail = h('p');
    actions.append(
      h('button', { class: 'ghost', type: 'button', onclick: () => run(api.cancel(g.id)) }, icon('close'), document.createTextNode('Cancelar')),
      h('div', { class: 'progress' }, meter, live.detail),
    );
  }

  const secondary = h('div', { class: 'secondary' });
  if (g.installed) {
    secondary.append(h('button', { class: 'ghost', type: 'button', onclick: () => run(api.openFolder(g.id)) }, icon('folder'), document.createTextNode('Abrir carpeta')));
    secondary.append(h('button', { class: 'ghost', type: 'button', onclick: () => createShortcut(g) }, icon('shortcut'), document.createTextNode('Crear acceso directo')));
  }
  secondary.append(h('button', { class: 'ghost', type: 'button', onclick: () => run(api.openExternal(`https://github.com/${g.repo}`)) }, icon('external'), document.createTextNode('Ver en GitHub')));
  if (g.installed && !g.busy && !g.running) {
    const remove = h('button', { class: 'ghost', type: 'button', 'data-danger': true }, icon('trash'), document.createTextNode('Desinstalar'));
    confirmable(remove, 'Confirmar', () => run(api.uninstall(g.id)));
    secondary.append(remove);
  } else if (g.custom && !g.installed && !g.busy) {
    secondary.append(h('button', { class: 'ghost', type: 'button', onclick: () => run(api.removeGame(g.id)) }, icon('trash'), document.createTextNode('Quitar de la lista')));
  }

  const facts = [];
  const fact = (label, value) => value && facts.push(h('div', { class: 'fact' }, h('dt', { text: label }), h('dd', { text: value })));
  if (g.installed) fact('Versión instalada', g.installed.tag);
  if (g.latest && (!g.installed || g.updateAvailable)) fact(g.installed ? 'Nueva versión' : 'Última versión', g.latest.tag);
  if (g.latest && g.latest.publishedAt) fact('Publicada', dateFmt.format(new Date(g.latest.publishedAt)));
  if (g.installed) fact('Espacio en disco', bytes(g.installed.size));
  else if (g.latest && g.latest.assetSize) fact('Tamaño de la descarga', bytes(g.latest.assetSize));
  if (g.installed) {
    fact('Tiempo de juego', playtime(g.installed.playtimeSec));
    live.lastPlayed = h('dd', { text: g.installed.lastPlayedAt ? ago(g.installed.lastPlayedAt) : 'Nunca' });
    facts.push(h('div', { class: 'fact' }, h('dt', { text: 'Última partida' }), live.lastPlayed));
    live.lastPlayedAt = g.installed.lastPlayedAt;
  }

  const notice = g.error
    ? h('p', { class: 'notice', 'data-tone': 'red', role: 'alert', text: g.error })
    : g.unavailable
      ? h('p', { class: 'notice', 'data-tone': 'amber', text: g.unavailable })
      : null;

  const notes = g.latest && g.latest.notes.trim()
    ? h('section', { class: 'notes' }, h('h2', { text: `Novedades de ${g.latest.tag}` }), h('div', { class: 'notes-body', text: g.latest.notes.trim() }))
    : null;

  return h(
    'div',
    {},
    h(
      'section',
      { class: 'detail-hero' },
      h('div', { class: 'hero-bg' }, coverBg(g)),
      h('button', { class: 'ghost glass back-btn', type: 'button', onclick: () => go({ name: 'home' }) }, icon('chevronL'), document.createTextNode('Atrás')),
      h(
        'div',
        { class: 'detail-grid' },
        h('div', { class: 'stage' }, coverNode(g)),
        h(
          'div',
          {},
          h('h1', { class: 'title', text: g.title }),
          h('p', { class: 'byline', text: `de ${g.author}` }),
          g.tags.length ? h('ul', { class: 'tags' }, ...g.tags.map((t) => h('li', { text: t }))) : null,
          g.description ? h('p', { class: 'desc', text: g.description }) : null,
          actions,
          secondary,
        ),
      ),
    ),
    notice,
    window.pitchMods ? window.pitchMods.card(g) : null,
    facts.length ? h('dl', { class: 'facts' }, ...facts) : null,
    notes,
  );
}

// ---------- Discord section (shown on the settings page) ----------

async function linkDiscord(button) {
  if (button) {
    button.disabled = true;
    button.textContent = 'Esperando a Discord…';
  }
  const res = await run(api.discordLink());
  if (res && res.ok) toast('Cuenta de Discord vinculada.', 'green');
  else if (button) {
    button.disabled = false;
    button.textContent = 'Vincular cuenta';
  }
  loadFriends();
}

async function loadFriends() {
  if (!discordState.linked) return;
  const res = await api.discordFriends();
  discordFriends = res.ok ? res.value : undefined;
  if (route.name === 'settings') render();
}

function discordSection() {
  const s = discordState;
  const box = h('div', { class: 'discord-card' });
  const head = h('div', { class: 'discord-head' }, icon('discord'), h('h2', { text: 'Discord' }), h('span', { class: 'spacer' }));
  box.append(head);

  if (!s.configured) {
    box.append(h('p', { class: 'hint', text: 'Esta compilación de Pitch no tiene configurada una app de Discord (pitch.config.json).' }));
    return box;
  }

  if (!s.linked) {
    const linkBtn = h('button', { class: 'solid', type: 'button', text: 'Vincular cuenta', onclick: () => linkDiscord(linkBtn) });
    head.append(linkBtn);
    box.append(h('p', { class: 'hint', text: 'Vincula tu cuenta para mostrar en Discord a qué juego estás jugando y ver a tus amigos conectados.' }));
    return box;
  }

  head.append(
    h(
      'div',
      { class: 'discord-user' },
      s.user && s.user.avatarUrl ? h('img', { src: s.user.avatarUrl, alt: '' }) : h('span', { class: 'ph', text: initial(s.user && s.user.username) }),
      h('b', { text: (s.user && s.user.username) || '' }),
    ),
    h('span', { class: 'spacer' }),
    h('button', { class: 'ghost', type: 'button', text: s.connected ? 'Abrir llamada' : 'Abrir Discord', onclick: () => run(api.discordOpen()) }),
    h('button', { class: 'link-btn', type: 'button', text: 'Desvincular', onclick: () => run(api.discordUnlink()) }),
  );

  box.append(
    h('p', {
      class: 'hint',
      text: s.connected
        ? 'Conectado: Pitch muestra a qué juegas en tu perfil de Discord.'
        : 'La app de Discord no está abierta en este equipo, así que tu estado no se actualiza ahora mismo.',
    }),
  );

  if (discordFriends === undefined) {
    box.append(h('p', { class: 'hint', text: 'No se pudo mostrar tu lista de amigos: esta app de Discord aún no tiene aprobado el permiso necesario por parte de Discord.' }));
  } else if (Array.isArray(discordFriends)) {
    const online = discordFriends.filter((f) => f.status !== 'offline');
    box.append(
      h('p', { class: 'hint', text: online.length ? `${online.length} amigos conectados` : 'Ninguno de tus amigos está conectado ahora mismo.' }),
      h(
        'div',
        { class: 'friends' },
        ...online.map((f) =>
          h(
            'span',
            { class: 'friend' },
            f.avatarUrl ? h('img', { src: f.avatarUrl, alt: '' }) : h('span', { class: 'ph', text: initial(f.username) }),
            h('span', { class: 'dot', 'data-online': f.status === 'online' || null, 'data-idle': f.status === 'idle' || null }),
            h('span', {}, h('b', { text: f.username }), f.activity ? h('span', { text: f.activity }) : null),
          ),
        ),
      ),
    );
  }
  return box;
}

// ---------- Pitch's own updates (shown on the settings page) ----------

let updateState = { state: 'disabled', version: '', newVersion: '', percent: 0, error: '', canInstall: false, releasesUrl: '' };

function updateSection() {
  const u = updateState;
  const box = h('div', { class: 'settings-section' }, h('h2', { text: 'Actualizaciones de Pitch' }));
  const row = h('div', { class: 'settings-row' });
  let line;
  let button = null;
  switch (u.state) {
    case 'checking':
      line = 'Buscando actualizaciones…';
      break;
    case 'downloading':
      line = `Descargando Pitch ${u.newVersion}… ${u.percent}%`;
      break;
    case 'ready':
      line = `Pitch ${u.newVersion} está descargado. Se instalará al cerrar Pitch.`;
      button = h('button', { class: 'solid', type: 'button', text: 'Reiniciar y actualizar', onclick: () => run(api.updateInstall()) });
      break;
    case 'available':
      line = `Hay una versión nueva: Pitch ${u.newVersion}.`;
      button = h('button', { class: 'solid', type: 'button', text: 'Descargar', onclick: () => run(api.openExternal(u.releasesUrl || 'https://github.com/planeador4000-design/pitch/releases/latest')) });
      break;
    case 'error':
      line = `No se pudo comprobar: ${u.error}`;
      break;
    case 'disabled':
      line = 'Las actualizaciones automáticas solo funcionan en la app instalada.';
      break;
    default:
      line = 'Pitch está al día.';
  }
  row.append(h('div', { class: 'grow' }, h('b', { text: `Versión ${u.version}` }), h('span', { class: 'sub', text: line })));
  if (button) row.append(button);
  else if (u.state !== 'disabled') {
    const busy = u.state === 'checking' || u.state === 'downloading';
    row.append(h('button', { class: 'ghost', type: 'button', disabled: busy || null, text: 'Buscar actualizaciones', onclick: () => run(api.updateCheck()) }));
  }
  box.append(row);
  return box;
}

api.onUpdate((next) => {
  updateState = next;
  if (route.name === 'settings') render();
});
api.updateStatus().then((res) => {
  if (res.ok) updateState = res.value;
});

// ---------- settings page ----------

function themeChoiceButtons(container) {
  const current = document.documentElement.dataset.theme;
  for (const btn of container.querySelectorAll('[data-theme-choice]')) {
    btn.setAttribute('aria-pressed', btn.dataset.themeChoice === current ? 'true' : 'false');
  }
}

function switchEl(checked, onToggle) {
  const btn = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false' });
  btn.addEventListener('click', async () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    await onToggle(next);
  });
  return btn;
}

function setTheme(value) {
  document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem('pitch:theme', value);
  } catch {
    /* ignore */
  }
  run(api.saveSettings({ theme: value })).then(() => render());
}

function wireSettingsForm() {
  const form = $('#form-catalog');
  if (!form) return;
  $('#btn-clear-token')?.addEventListener('click', () => {
    $('#set-token').value = '';
    $('#set-token').dataset.clear = '1';
    $('#set-token').placeholder = 'El token se quitará al guardar';
    $('#btn-clear-token').hidden = true;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const typedToken = $('#set-token').value.trim();
    const clear = $('#set-token').dataset.clear === '1';
    const patch = {
      catalog: $('#set-catalog').value.trim(),
      autoUpdate: $('#set-auto').checked,
      checkIntervalMinutes: Number($('#set-interval').value),
      token: clear ? '' : typedToken || null,
    };
    if ($('#set-sandbox')) patch.linuxNoSandbox = $('#set-sandbox').checked;
    const res = await api.saveSettings(patch);
    if (!res.ok) {
      const err = $('#settings-error');
      err.textContent = res.error;
      err.hidden = false;
      return;
    }
    state = res.value;
    toast('Ajustes guardados.', 'green');
    render();
  });
}

function buildSettings() {
  const s = state.settings;
  const frag = h('div', {}, h('h1', { class: 'page-title', text: 'Ajustes' }));

  const themeBox = h(
    'div',
    { class: 'settings-section' },
    h('h2', { text: 'Tema' }),
    h(
      'div',
      { class: 'segmented segmented-spaced' },
      h('button', { type: 'button', 'data-theme-choice': 'light', onclick: () => setTheme('light') }, h('i', { class: 'swatch swatch-light' }), document.createTextNode('Azul y blanco')),
      h('button', { type: 'button', 'data-theme-choice': 'dark', onclick: () => setTheme('dark') }, h('i', { class: 'swatch swatch-dark' }), document.createTextNode('Azul y negro')),
    ),
  );
  themeChoiceButtons(themeBox);
  append(frag, themeBox);

  append(
    frag,
    h(
      'div',
      { class: 'settings-section' },
      h('h2', { text: 'Inicio del sistema' }),
      h(
        'div',
        { class: 'settings-row' },
        h('div', { class: 'grow' }, h('b', { text: 'Abrir Pitch al encender el ordenador' }), h('span', { class: 'sub', text: 'Pitch se inicia en segundo plano con la sesión.' })),
        switchEl(!!s.launchAtLogin, async (next) => {
          await run(api.setLaunchAtLogin(next));
        }),
      ),
    ),
  );

  append(frag, updateSection());

  append(
    frag,
    h(
      'div',
      { class: 'settings-section' },
      h('h2', { text: 'Catálogo' }),
      h(
        'form',
        { id: 'form-catalog' },
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'set-catalog', text: 'Catálogo de juegos' }),
          h('input', { id: 'set-catalog', type: 'text', value: s.catalog, placeholder: 'usuario/repositorio' }),
          h('p', { class: 'hint', text: 'El repositorio de GitHub con el catalog.json de la tienda.' }),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'set-token', text: 'Token de GitHub (opcional)' }),
          h('input', { id: 'set-token', type: 'password', placeholder: s.hasToken ? 'Token guardado (escribe otro para cambiarlo)' : 'ghp_…' }),
          h('p', { class: 'hint', text: 'Sube el límite de consultas y, con permiso de escritura, activa el panel de Administración.' }),
          s.hasToken ? h('button', { id: 'btn-clear-token', class: 'link-btn', type: 'button', text: 'Quitar el token guardado' }) : null,
        ),
        h('div', { class: 'field inline' }, h('input', { id: 'set-auto', type: 'checkbox', checked: s.autoUpdate || null }), h('label', { for: 'set-auto', text: 'Actualizar los juegos automáticamente' })),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'set-interval', text: 'Buscar actualizaciones cada' }),
          h(
            'select',
            { id: 'set-interval' },
            ...[15, 30, 60, 180, 720].map((m) => h('option', { value: m, selected: m === s.checkIntervalMinutes || null, text: m < 60 ? `${m} minutos` : `${m / 60} h` })),
          ),
        ),
        s.platform === 'linux'
          ? h('div', { class: 'field inline' }, h('input', { id: 'set-sandbox', type: 'checkbox', checked: s.linuxNoSandbox || null }), h('label', { for: 'set-sandbox', text: 'Abrir los juegos Electron sin sandbox' }))
          : null,
        h('p', { id: 'settings-error', class: 'form-error', role: 'alert', hidden: true }),
        h('div', { class: 'dialog-actions dialog-actions-start' }, h('button', { class: 'solid', type: 'submit', text: 'Guardar' })),
      ),
    ),
  );

  append(frag, window.pitchMods.gamepadSection(), discordSection(), window.pitchMods.callSection());
  return frag;
}

// ---------- render ----------

function pageFor() {
  if (!state.games.length && route.name !== 'settings' && route.name !== 'admin') return buildEmpty();
  if (route.name === 'game') {
    const g = state.games.find((x) => x.id === route.id);
    if (!g) return buildEmpty();
    return buildGame(g);
  }
  if (route.name === 'library') return buildLibrary();
  if (route.name === 'search') return buildSearch();
  if (route.name === 'settings') return buildSettings();
  if (route.name === 'admin') return window.pitchAdmin ? window.pitchAdmin.build() : h('div');
  return buildHome();
}

function updateLive() {
  if (route.name !== 'game' || !state) return;
  const g = state.games.find((x) => x.id === route.id);
  if (!g) return;
  if (g.busy && live.ctaLabel) {
    live.ctaLabel.textContent = busyLabel(g.busy);
    const { received, total, phase } = g.busy;
    const determinate = (phase === 'downloading' || phase === 'extracting') && total > 0;
    if (determinate) {
      live.meter.removeAttribute('data-indeterminate');
      live.bar.style.width = `${Math.min(100, (received / total) * 100)}%`;
      live.detail.textContent = phase === 'extracting' ? `Extrayendo ${received} de ${total} archivos` : `${bytes(received)} de ${bytes(total)}`;
    } else {
      live.meter.setAttribute('data-indeterminate', '');
      live.bar.style.width = '';
      live.detail.textContent = phase === 'extracting' ? 'Extrayendo archivos…' : 'Preparando la descarga…';
    }
  }
  if (live.lastPlayed && live.lastPlayedAt) live.lastPlayed.textContent = ago(live.lastPlayedAt);
}

function updateNav() {
  for (const btn of navButtons) {
    if (btn.dataset.nav === route.name) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  const adminBtn = document.querySelector('[data-nav="admin"]');
  if (adminBtn) adminBtn.hidden = !state || !state.admin || !state.admin.canEdit;
}

function render() {
  if (!state) return;
  updateNav();
  pageEl.replaceChildren(pageFor());
  wireSettingsForm();
  updateLive();
  updateThemeButton();
  updateAvatarButton();
}

// Lets admin.js (a separate, simple script) ask for a re-render after it changes its own
// local draft state, without app.js needing to know anything about that state.
window.__pitchRerender = () => {
  if (route.name === 'admin') pageEl.replaceChildren(pageFor());
};

// ---------- theme button in the top bar ----------

function updateThemeButton() {
  const btn = $('#btn-theme');
  const current = document.documentElement.dataset.theme;
  btn.setAttribute('aria-label', 'Cambiar tema');
  btn.setAttribute('title', 'Cambiar tema');
  btn.replaceChildren(h('i', { class: `swatch swatch-sm ${current === 'dark' ? 'swatch-dark' : 'swatch-light'}` }));
}

$('#btn-theme').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(current);
});

// ---------- avatar / Discord button ----------

function updateAvatarButton() {
  let btn = $('#btn-avatar');
  if (!btn) {
    btn = h('button', { id: 'btn-avatar', class: 'avatar-btn', type: 'button', 'aria-label': 'Discord', onclick: () => go({ name: 'settings' }) });
    $('.tools').append(btn);
  }
  const s = discordState;
  // The side-panel button already carries the Discord logo; this one only appears once the
  // account is linked (Rich Presence), showing who is linked and leading to its settings.
  btn.hidden = !(s.linked && s.user);
  if (s.linked && s.user) {
    btn.replaceChildren(s.user.avatarUrl ? h('img', { src: s.user.avatarUrl, alt: '' }) : h('span', { text: initial(s.user.username) }));
  }
}

// ---------- toasts ----------

function toast(message, tone) {
  const el = h('p', { class: 'toast', 'data-tone': tone || null, text: message });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5500);
}

api.onNotice((n) => {
  if (n.kind === 'toast') return toast(n.message, n.tone);
  return toast(n.kind === 'updated' ? `${n.title} se ha actualizado a ${n.tag}.` : `${n.title} está listo para jugar (${n.tag}).`, 'green');
});

api.onDiscord((s) => {
  discordState = s;
  if (s.linked && discordFriends === null) loadFriends();
  if (route.name === 'settings') render();
  updateAvatarButton();
});

$('#btn-settings').addEventListener('click', () => go({ name: 'settings' }));

// Discord side panel (the native view docks itself to the right; the page makes room for it).
$('#btn-discord-panel').append(icon('discord'));
$('#btn-call').append(icon('phone'));
$('#btn-discord-panel').addEventListener('click', () => run(api.discordPanelToggle()));
$('#btn-call').addEventListener('click', () => window.pitchMods.callNow());
api.onDiscordPanel((s) => {
  document.body.dataset.discordPanel = s.open ? 'open' : '';
  $('#btn-discord-panel').setAttribute('aria-pressed', s.open ? 'true' : 'false');
});

// The panel is a native view drawn above the page, so it would cover centred dialogs: hide it while one is open.
const nativeShowModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function showModalWithPanelSuspended(...args) {
  api.discordPanelSuspend(true);
  this.addEventListener('close', () => api.discordPanelSuspend(false), { once: true });
  return nativeShowModal.apply(this, args);
};
$('#btn-refresh').addEventListener('click', () => run(api.refresh()));
$('#btn-logo').addEventListener('click', () => go({ name: 'home' }));

function updateSyncIndicator() {
  $('#btn-refresh').classList.toggle('spinning', !!(state && state.sync.checking));
}

// ---------- boot ----------

api.onState((next) => {
  const first = !state;
  state = next;
  if (first) {
    let last = null;
    try {
      last = localStorage.getItem('pitch:lastGame');
    } catch {
      /* ignore */
    }
    if (last && state.games.some((g) => g.id === last)) route = { name: 'game', id: last };
  }
  render();
  updateSyncIndicator();
});

setInterval(() => {
  if (!state) return;
  updateLive();
  updateSyncIndicator();
}, 30000);

api.getState().then((res) => {
  if (res.ok) {
    state = res.value;
    render();
    updateSyncIndicator();
  }
});

api.discordStatus().then((res) => {
  if (res.ok) {
    discordState = res.value;
    updateAvatarButton();
    if (discordState.linked) loadFriends();
  }
});
