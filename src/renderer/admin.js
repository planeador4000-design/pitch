'use strict';

// The admin panel is only reachable when the main library snapshot's `admin.canEdit` is
// true (checked server-side: the saved GitHub token can push to the catalog repo). It
// edits a local working copy of catalog.json and only commits it to GitHub when the
// person presses "Publicar".

(function () {
  const api = window.pitch;
  const $ = (sel, root = document) => root.querySelector(sel);

  let working = null; // { catalog, sha } — the local draft
  let dirty = false;
  let loadError = '';
  let loading = false;

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

  function initial(title) {
    return ([...String(title || '').trim()][0] || '?').toUpperCase();
  }

  function icon(d) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }
  const ICON = {
    plus: 'M12 5v14M5 12h14',
    edit: 'M4 20h4l10-10-4-4L4 16z',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    up: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  };

  async function ensureLoaded() {
    if (working || loading) return;
    loading = true;
    const res = await api.adminLoad();
    loading = false;
    if (!res.ok) {
      loadError = res.error;
      return;
    }
    working = { catalog: res.value.catalog, sha: res.value.sha };
    dirty = false;
  }

  function markDirty() {
    dirty = true;
    rerender();
  }

  function rerender() {
    if (window.__pitchRerender) window.__pitchRerender();
  }

  function gameThumb(g) {
    const letter = h('span', { class: 'cover-letter cover-letter-sm', text: initial(g.title) });
    const node = h('span', { class: 'cover admin-thumb', 'data-tone': 0 }, letter);
    if (g.cover) {
      const img = new Image();
      img.alt = '';
      img.addEventListener('load', () => {
        img.hidden = false;
        letter.hidden = true;
      });
      img.hidden = true;
      img.src = g.cover;
      node.append(img);
    }
    return node;
  }

  function removeGame(index) {
    working.catalog.games.splice(index, 1);
    markDirty();
  }

  function toggleFeatured(index) {
    working.catalog.games[index].featured = !working.catalog.games[index].featured;
    markDirty();
  }

  function switchEl(checked, onToggle) {
    const btn = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false' });
    btn.addEventListener('click', onToggle);
    return btn;
  }

  async function discard() {
    working = null;
    dirty = false;
    await ensureLoaded();
    rerender();
  }

  async function publish() {
    const res = await api.adminSave({ catalog: working.catalog, sha: working.sha });
    if (!res.ok) {
      loadError = res.error;
      rerender();
      return;
    }
    working.sha = res.value.sha;
    dirty = false;
    rerender();
  }

  function openGameDialog(index) {
    const dlg = $('#dlg-game');
    const isEdit = index !== null;
    const g = isEdit
      ? working.catalog.games[index]
      : { repo: '', title: '', author: '', description: '', tags: [], cover: '', banner: '', featured: false, channel: 'stable' };

    $('#dlg-game-title').textContent = isEdit ? 'Editar juego' : 'Añadir un juego';
    $('#g-repo').value = g.repo || '';
    $('#g-repo').disabled = isEdit;
    $('#g-title').value = g.title || '';
    $('#g-author').value = g.author || '';
    $('#g-desc').value = g.description || '';
    $('#g-tags').value = (g.tags || []).join(', ');
    $('#g-cover').value = g.cover || '';
    $('#g-banner').value = g.banner || '';
    $('#g-featured').checked = !!g.featured;
    $('#g-channel').value = g.channel || 'stable';
    $('#game-error').hidden = true;

    $('#g-lookup').onclick = async () => {
      const repo = $('#g-repo').value.trim();
      if (!repo) return;
      const res = await api.adminLookup(repo);
      if (!res.ok) {
        $('#game-error').textContent = res.error;
        $('#game-error').hidden = false;
        return;
      }
      if (!$('#g-title').value) $('#g-title').value = res.value.name;
      if (!$('#g-author').value) $('#g-author').value = res.value.owner;
      if (!$('#g-desc').value) $('#g-desc').value = res.value.description || '';
    };

    const form = $('#form-game');
    form.onsubmit = (event) => {
      event.preventDefault();
      const repo = $('#g-repo').value.trim();
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        $('#game-error').textContent = 'Escribe el repositorio como usuario/repositorio.';
        $('#game-error').hidden = false;
        return;
      }
      const entry = {
        repo,
        title: $('#g-title').value.trim(),
        author: $('#g-author').value.trim(),
        description: $('#g-desc').value.trim(),
        tags: $('#g-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
        cover: $('#g-cover').value.trim(),
        banner: $('#g-banner').value.trim(),
        featured: $('#g-featured').checked,
        channel: $('#g-channel').value,
      };
      if (!working) working = { catalog: { name: 'Catálogo', games: [] }, sha: null };
      if (isEdit) working.catalog.games[index] = { ...g, ...entry };
      else working.catalog.games.push(entry);
      dlg.close();
      markDirty();
    };

    dlg.showModal();
  }

  function build() {
    const box = h('div', {});
    box.append(
      h(
        'div',
        { class: 'admin-head' },
        h('div', { class: 'grow' }, h('h1', { text: 'Administración del catálogo' }), h('p', { text: 'Añade, edita y publica los juegos que ven todos los usuarios de esta tienda.' })),
        h('button', { class: 'solid', type: 'button', onclick: () => openGameDialog(null) }, icon(ICON.plus), document.createTextNode(' Añadir juego')),
      ),
    );

    if (loadError) {
      box.append(h('p', { class: 'notice', 'data-tone': 'red', text: loadError }));
      return box;
    }
    if (!working) {
      box.append(h('p', { class: 'page-sub', text: 'Cargando el catálogo…' }));
      ensureLoaded().then(rerender);
      return box;
    }

    const games = working.catalog.games;
    const rows = games.length
      ? [
          h('div', { class: 'admin-row head' }, h('span', {}), h('span', { text: 'Juego' }), h('span', { text: 'Versión' }), h('span', { text: 'Destacado' }), h('span', {})),
          ...games.map((g, i) =>
            h(
              'div',
              { class: 'admin-row' },
              gameThumb(g),
              h('span', { class: 'name' }, h('b', { text: g.title }), h('span', { text: g.repo })),
              h('span', { class: 'ver', 'data-none': true, text: '—' }),
              switchEl(!!g.featured, () => toggleFeatured(i)),
              h(
                'span',
                { class: 'row-actions' },
                h('button', { class: 'ghost', type: 'button', onclick: () => openGameDialog(i) }, icon(ICON.edit), document.createTextNode(' Editar')),
                h('button', { class: 'ghost', type: 'button', 'data-danger': true, onclick: () => removeGame(i) }, icon(ICON.trash)),
              ),
            ),
          ),
        ]
      : [h('div', { class: 'admin-empty', text: 'Este catálogo todavía no tiene juegos. Añade el primero.' })];

    box.append(h('div', { class: 'admin-list' }, ...rows));

    if (dirty) {
      box.append(
        h(
          'div',
          { class: 'publish-bar', 'data-dirty': true },
          h('p', { text: 'Tienes cambios sin publicar' }),
          h('button', { class: 'ghost', type: 'button', text: 'Descartar', onclick: discard }),
          h('button', { class: 'solid', type: 'button', onclick: publish }, icon(ICON.up), document.createTextNode(' Publicar')),
        ),
      );
    }
    return box;
  }

  window.pitchAdmin = { build };
})();
