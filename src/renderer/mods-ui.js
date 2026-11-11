'use strict';

// Mods panel (per game), permission approval, controller settings and the Discord call
// settings. Loaded after app.js and uses its globals (h, icon, toast, render, run, route, state,
// switchEl). Everything that changes data goes through window.pitch (IPC); nothing here touches
// the disk or the game directly.

(function () {
  const api = window.pitch;

  const PERM_LABELS = {
    game: 'Leer y modificar el juego (sprites, variables, eventos)',
    graphics: 'Añadir o cambiar imágenes y sonidos del juego',
    audio: 'Reproducir sonidos propios',
    storage: 'Guardar datos del mod',
    ui: 'Mostrar ventanas y HUD sobre el juego',
    input: 'Leer teclado, ratón y mandos',
    network: 'Acceder a internet',
  };
  const PERM_SHORT = { game: 'Juego', graphics: 'Gráficos', audio: 'Audio', storage: 'Datos', ui: 'Interfaz', input: 'Entrada', network: 'Red' };
  const CATEGORY_LABELS = { framework: 'Framework', content: 'Contenido', gameplay: 'Jugabilidad', balance: 'Balance' };
  const VANILLA = 'Vanilla';

  // ------------------------------------------------------------------ generic dialogs

  // Shows the shared <dialog id="dlg-confirm"> and resolves with the value of the button pressed
  // ('' when dismissed with Escape).
  function modal(title, content, buttons) {
    const dlg = document.getElementById('dlg-confirm');
    return new Promise((resolve) => {
      const actions = h(
        'div',
        { class: 'dialog-actions' },
        ...buttons.map((b) =>
          h('button', { class: b.primary ? 'solid' : 'ghost', type: 'button', 'data-danger': b.danger ? true : null, text: b.label, onclick: () => dlg.close(b.value) }),
        ),
      );
      dlg.replaceChildren(h('div', { class: 'modal-body' }, h('h2', { text: title }), ...content, actions));
      dlg.addEventListener('close', () => resolve(dlg.returnValue || ''), { once: true });
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  function askName(title, label) {
    const dlg = document.getElementById('dlg-confirm');
    return new Promise((resolve) => {
      const input = h('input', { type: 'text', maxlength: '40', autocomplete: 'off', spellcheck: 'false' });
      const form = h(
        'form',
        { method: 'dialog', class: 'modal-body' },
        h('h2', { text: title }),
        h('div', { class: 'field' }, h('label', { text: label }), input),
        h('div', { class: 'dialog-actions' }, h('button', { class: 'ghost', type: 'button', text: 'Cancelar', onclick: () => dlg.close('') }), h('button', { class: 'solid', type: 'submit', text: 'Crear' })),
      );
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        dlg.close(input.value.trim());
      });
      dlg.replaceChildren(form);
      dlg.addEventListener('close', () => resolve(dlg.returnValue || ''), { once: true });
      dlg.returnValue = '';
      dlg.showModal();
      input.focus();
    });
  }

  // ------------------------------------------------------------------ per-game mods state (cached so re-renders are instant)

  const cache = {};
  const loading = {};

  async function refresh(gameId) {
    const res = await api.modsGameState(gameId);
    loading[gameId] = false;
    if (res.ok) cache[gameId] = res.value;
    else toast(res.error, 'amber');
    if (route.name === 'game' && route.id === gameId) render();
  }

  function invalidateAll() {
    for (const k of Object.keys(cache)) delete cache[k];
  }

  async function act(gameId, promise) {
    const res = await promise;
    if (!res.ok) toast(res.error, 'amber');
    invalidateAll();
    await refresh(gameId);
    return res;
  }

  // ------------------------------------------------------------------ the Mods card on a game's page

  function chip(text, title, tone) {
    return h('span', { class: 'chip', 'data-tone': tone || null, title: title || null, text });
  }

  function modRow(g, st, mod, index, enabledIds) {
    const enabled = enabledIds.includes(mod.id);
    const vanilla = st.active === VANILLA;
    const pos = st.order.indexOf(mod.id);
    const details = h('div', { class: 'mod-details', hidden: true });
    details.append(
      h('p', { text: `Mod API ${mod.pitchApi || '—'} · categoría: ${CATEGORY_LABELS[mod.category] || mod.category}` }),
      mod.permissions.length
        ? h('ul', {}, ...mod.permissions.map((p) => h('li', { text: `${PERM_SHORT[p] || p}: ${PERM_LABELS[p] || p}` })))
        : h('p', { text: 'No pide ningún permiso.' }),
      Object.keys(mod.dependencies).length ? h('p', { text: `Necesita: ${Object.entries(mod.dependencies).map(([k, v]) => `${k} ${v}`).join(', ')}` }) : null,
    );

    const toggle = switchEl(enabled, async () => {
      const next = enabled ? enabledIds.filter((x) => x !== mod.id) : [...enabledIds, mod.id];
      await act(g.id, api.modsSetProfileMods({ gameId: g.id, profile: st.active, ids: next }));
    });
    if (vanilla || !mod.valid) toggle.disabled = true;

    const move = (delta) => async () => {
      const ids = [...enabledIds];
      const i = ids.indexOf(mod.id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await act(g.id, api.modsSetProfileMods({ gameId: g.id, profile: st.active, ids }));
    };

    const uninstall = h('button', { class: 'ghost', type: 'button', 'data-danger': true, title: 'Desinstalar', onclick: async () => {
      const ok = await modal(`¿Desinstalar ${mod.name}?`, [h('p', { text: 'Se borra el mod de este equipo. El juego original no se toca.' })], [
        { label: 'Cancelar', value: '' },
        { label: 'Desinstalar', value: 'ok', primary: true },
      ]);
      if (ok === 'ok') await act(g.id, api.modsRemove(mod.id));
    } }, icon('trash'));

    return h(
      'li',
      { class: 'mod-row', 'data-enabled': enabled ? 'true' : null, 'data-broken': mod.valid ? null : 'true' },
      toggle,
      h(
        'div',
        { class: 'mod-main' },
        h(
          'div',
          { class: 'mod-title' },
          h('b', { text: mod.name }),
          mod.version ? h('span', { class: 'sub', text: `v${mod.version}${mod.author ? ` · ${mod.author}` : ''}` }) : null,
          enabled && pos >= 0 ? chip(`#${pos + 1}`, 'Posición en el orden de carga', 'accent') : null,
          mod.category ? chip(CATEGORY_LABELS[mod.category] || mod.category) : null,
          enabled && mod.needsApproval.length ? chip('Permisos sin aprobar', 'Se te pedirá aprobarlos al pulsar Jugar', 'amber') : null,
        ),
        mod.description ? h('p', { class: 'mod-desc', text: mod.description }) : null,
        mod.valid ? h('div', { class: 'chips' }, ...mod.permissions.map((p) => chip(PERM_SHORT[p] || p, PERM_LABELS[p]))) : null,
        ...mod.errors.map((e) => h('p', { class: 'mod-problem', 'data-tone': 'red', text: e })),
        details,
      ),
      h(
        'div',
        { class: 'mod-actions' },
        h('button', { class: 'ghost', type: 'button', title: 'Detalles', text: 'Detalles', onclick: () => (details.hidden = !details.hidden) }),
        enabled ? h('button', { class: 'ghost', type: 'button', title: 'Cargar antes', 'aria-label': 'Subir en el orden de carga', text: '↑', onclick: move(-1), disabled: index === 0 || null }) : null,
        enabled ? h('button', { class: 'ghost', type: 'button', title: 'Cargar después', 'aria-label': 'Bajar en el orden de carga', text: '↓', onclick: move(1), disabled: index === enabledIds.length - 1 || null }) : null,
        uninstall,
      ),
    );
  }

  function card(g) {
    const st = cache[g.id];
    if (!st) {
      if (!loading[g.id]) {
        loading[g.id] = true;
        refresh(g.id);
      }
      return h('section', { class: 'mods-card' }, h('h2', { text: 'Mods' }), h('p', { class: 'hint', text: 'Cargando…' }));
    }

    const vanilla = st.active === VANILLA;
    const names = Object.keys(st.profiles);
    const select = h('select', { 'aria-label': 'Perfil de mods' }, ...names.map((n) => h('option', { value: n, text: n, selected: n === st.active || null })));
    select.addEventListener('change', () => act(g.id, api.modsSetActiveProfile({ gameId: g.id, name: select.value })));

    const newProfile = async () => {
      const name = await askName('Nuevo perfil de mods', 'Nombre del perfil (por ejemplo Survival)');
      if (name) await act(g.id, api.modsCreateProfile({ gameId: g.id, name }));
    };
    const deleteProfile = async () => {
      const ok = await modal(`¿Borrar el perfil "${st.active}"?`, [h('p', { text: 'Solo se borra la lista de mods de ese perfil, no los mods instalados.' })], [
        { label: 'Cancelar', value: '' },
        { label: 'Borrar perfil', value: 'ok', primary: true },
      ]);
      if (ok === 'ok') await act(g.id, api.modsDeleteProfile({ gameId: g.id, name: st.active }));
    };
    const install = (kind) => async () => {
      const res = await api.modsInstall(kind);
      if (!res.ok) return toast(res.error, 'amber');
      if (res.value.canceled) return undefined;
      toast(res.value.updatedFrom ? `${res.value.name} actualizado de ${res.value.updatedFrom} a ${res.value.version}.` : `${res.value.name} instalado.`, 'green');
      invalidateAll();
      return refresh(g.id);
    };

    const enabledIds = st.profiles[st.active] || [];
    const byId = Object.fromEntries(st.installed.map((m) => [m.id, m]));
    const posOf = (id) => (st.order.includes(id) ? st.order.indexOf(id) : 999);
    const enabledMods = enabledIds.map((id) => byId[id]).filter(Boolean).sort((a, b) => posOf(a.id) - posOf(b.id) || enabledIds.indexOf(a.id) - enabledIds.indexOf(b.id));
    const others = st.installed.filter((m) => !enabledIds.includes(m.id));
    const rows = [...enabledMods, ...others].map((m) => modRow(g, st, m, enabledMods.indexOf(m), enabledIds));

    const problems = st.problems.map((p) =>
      h(
        'li',
        { class: 'mod-problem', 'data-tone': p.severity === 'error' ? 'red' : 'amber' },
        h('span', { text: p.message }),
        p.fix && p.fix.enable
          ? h('button', { class: 'ghost', type: 'button', text: 'Activarlo', onclick: () => act(g.id, api.modsSetProfileMods({ gameId: g.id, profile: st.active, ids: [...enabledIds, p.fix.enable] })) })
          : null,
      ),
    );

    return h(
      'section',
      { class: 'mods-card' },
      h(
        'div',
        { class: 'mods-head' },
        h('h2', { text: 'Mods' }),
        h('div', { class: 'mods-controls' }, h('label', { class: 'sub', text: 'Perfil' }), select,
          h('button', { class: 'ghost', type: 'button', text: 'Nuevo perfil', onclick: newProfile }),
          vanilla ? null : h('button', { class: 'ghost', type: 'button', 'data-danger': true, text: 'Borrar perfil', onclick: deleteProfile }),
        ),
      ),
      vanilla
        ? h('p', { class: 'hint', text: 'Vanilla es el juego tal cual, sin mods. Crea un perfil (por ejemplo "Survival") para elegir qué mods se activan.' })
        : h('p', { class: 'hint', text: 'Los mods se aplican en memoria al abrir el juego: el original no se modifica y desactivar un mod basta para quitarlo.' }),
      problems.length && !vanilla ? h('ul', { class: 'mod-problems' }, ...problems) : null,
      h(
        'div',
        { class: 'mods-install' },
        h('button', { class: 'solid', type: 'button', text: 'Instalar mod (carpeta)', onclick: install('folder') }),
        h('button', { class: 'ghost', type: 'button', text: 'Instalar mod (.zip)', onclick: install('zip') }),
        h('button', { class: 'ghost', type: 'button', text: 'Abrir carpeta de mods', onclick: () => run(api.modsOpenFolder()) }),
      ),
      rows.length ? h('ul', { class: 'mod-list' }, ...rows) : h('p', { class: 'hint', text: 'Todavía no has instalado ningún mod.' }),
      h('p', { class: 'hint mods-safety', text: 'Un mod es código que se ejecuta dentro del juego. Los permisos limitan lo que la API de Pitch le ofrece, pero no son una barrera de seguridad absoluta: instala solo mods de gente de confianza.' }),
    );
  }

  // ------------------------------------------------------------------ playing: validation + permission approval

  async function play(g) {
    const res = await api.modsGameState(g.id);
    if (!res.ok) return api.play(g.id); // main re-validates anyway
    const st = res.value;
    cache[g.id] = st;
    if (st.active === VANILLA) return api.play(g.id);

    if (!st.canPlay) {
      const errors = st.problems.filter((p) => p.severity === 'error');
      const choice = await modal(
        'Este perfil no se puede cargar',
        [h('p', { text: 'Hay problemas con los mods activados:' }), h('ul', {}, ...errors.map((e) => h('li', { text: e.message })))],
        [{ label: 'Cancelar', value: '' }, { label: 'Jugar sin mods (Vanilla)', value: 'vanilla', primary: true }],
      );
      if (choice !== 'vanilla') return { ok: true };
      await api.modsSetActiveProfile({ gameId: g.id, name: VANILLA });
      await refresh(g.id);
      return api.play(g.id);
    }

    if (st.pendingApproval.length) {
      const ok = await modal(
        'Permisos de los mods',
        [
          h('p', { text: 'Estos mods piden permisos que aún no has aprobado. Solo se te pregunta la primera vez, o si una actualización pide permisos nuevos.' }),
          ...st.pendingApproval.map((m) =>
            h('div', { class: 'perm-block' }, h('b', { text: m.name }), h('ul', {}, ...m.permissions.map((p) => h('li', { text: `${PERM_SHORT[p] || p}: ${PERM_LABELS[p] || p}` })))),
          ),
          h('p', { class: 'hint', text: 'Recuerda: no es una barrera de seguridad absoluta. Aprueba solo mods de gente de confianza.' }),
        ],
        [{ label: 'Cancelar', value: '' }, { label: 'Aprobar y jugar', value: 'ok', primary: true }],
      );
      if (ok !== 'ok') return { ok: true };
      const approved = await api.modsApprove(st.pendingApproval.map((m) => m.id));
      if (!approved.ok) return approved;
      invalidateAll();
      refresh(g.id);
    }
    return api.play(g.id);
  }

  // ------------------------------------------------------------------ controller detection + settings

  let padCount = 0;
  function reportPads() {
    const list = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    padCount = list.length;
    api.reportGamepads(padCount);
    const el = document.getElementById('pad-status');
    if (el) el.textContent = padStatusText();
  }
  function padStatusText() {
    return padCount > 0 ? `Mando detectado (${padCount}).` : 'No se detecta ningún mando. Si lo tienes conectado, pulsa un botón para que Pitch lo vea.';
  }
  window.addEventListener('gamepadconnected', reportPads);
  window.addEventListener('gamepaddisconnected', () => setTimeout(reportPads, 50));
  reportPads();

  const PAD_BUTTONS = [['a', 'A'], ['b', 'B'], ['x', 'X'], ['y', 'Y'], ['lb', 'LB'], ['rb', 'RB'], ['lt', 'LT'], ['rt', 'RT'], ['back', 'Atrás'], ['start', 'Start']];

  async function savePad(cfg, message) {
    const res = await api.saveSettings({ gamepad: cfg });
    if (!res.ok) return toast(res.error, 'amber');
    state = res.value;
    toast(message, 'green');
    return render();
  }

  function gamepadSection() {
    const cfg = state.settings.gamepad;
    const stick = h('select', { id: 'pad-stick' },
      h('option', { value: 'arrows', text: 'Flechas', selected: cfg.stick === 'arrows' || null }),
      h('option', { value: 'wasd', text: 'W A S D', selected: cfg.stick === 'wasd' || null }));
    const dead = h('input', { id: 'pad-dead', type: 'number', min: '0.1', max: '0.9', step: '0.05', value: String(cfg.deadzone) });
    const inputs = {};
    const grid = h('div', { class: 'pad-grid' }, ...PAD_BUTTONS.map(([key, label]) => {
      inputs[key] = h('input', { type: 'text', maxlength: '5', placeholder: 'sin asignar', value: cfg.buttons[key] || '', 'aria-label': `Tecla para ${label}` });
      return h('label', { class: 'pad-cell' }, h('span', { text: label }), inputs[key]);
    }));
    const collect = (enabled) => ({
      enabled,
      stick: stick.value,
      deadzone: Number(dead.value),
      buttons: Object.fromEntries(PAD_BUTTONS.map(([k]) => [k, inputs[k].value.trim()]).filter(([, v]) => v)),
    });

    return h(
      'div',
      { class: 'settings-section' },
      h('h2', { text: 'Mando' }),
      h('div', { class: 'settings-row' },
        h('div', { class: 'grow' }, h('b', { text: 'Usar el mando como teclado en los juegos' }), h('span', { class: 'sub', id: 'pad-status', text: padStatusText() })),
        switchEl(!!cfg.enabled, (next) => savePad({ ...cfg, enabled: next }, next ? 'Mando activado.' : 'Mando desactivado.')),
      ),
      h('div', { class: 'settings-row' },
        h('div', { class: 'grow' }, h('b', { text: 'Stick izquierdo y cruceta' }), h('span', { class: 'sub', text: 'Se traducen a las teclas que elijas.' })), stick),
      h('div', { class: 'settings-row' },
        h('div', { class: 'grow' }, h('b', { text: 'Zona muerta del stick' }), h('span', { class: 'sub', text: 'Más alta = menos sensible (0,1 – 0,9).' })), dead),
      h('p', { class: 'pad-title', text: 'Tecla que pulsa cada botón' }),
      grid,
      h('p', { class: 'hint', text: 'Escribe una letra, o: space, enter, up, down, left, right. El mando imita al teclado: funciona en los juegos de Scratch/TurboWarp a los que Pitch puede acceder (apps Electron/NW.js). Si conectas el mando después de abrir un juego, ciérralo y ábrelo otra vez.' }),
      h('div', { class: 'dialog-actions dialog-actions-start' },
        h('button', { class: 'solid', type: 'button', text: 'Guardar mando', onclick: () => savePad(collect(cfg.enabled), 'Mando guardado.') }),
        h('button', { class: 'ghost', type: 'button', text: 'Restablecer', onclick: () => savePad({ enabled: cfg.enabled, stick: 'arrows', deadzone: 0.35, buttons: { a: 'space', b: 'Enter', x: 'z', y: 'x', lb: 'q', rb: 'e', start: 'Enter' } }, 'Mando restablecido.') })),
    );
  }

  // ------------------------------------------------------------------ Discord side panel settings

  function callSection() {
    const input = h('input', { id: 'call-url', type: 'text', value: state.settings.discordCallUrl || '', placeholder: 'https://discord.com/channels/…/…', spellcheck: 'false', autocomplete: 'off' });
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    return h(
      'div',
      { class: 'settings-section' },
      h('h2', { text: 'Discord en el panel lateral' }),
      h('p', { class: 'hint', text: 'El botón de Discord de la barra superior abre el cliente web de Discord a un lado de Pitch, como el panel de Opera GX. Inicias sesión una vez y se recuerda.' }),
      h('div', { class: 'field' },
        h('label', { for: 'call-url', text: 'Canal de llamada predeterminado' }),
        input,
        h('p', { class: 'hint', text: 'En Discord: clic derecho en un canal de voz (o en un chat privado) → Copiar enlace. El botón de llamada abre el panel en ese canal; unirte a la llamada depende de Discord y puede pedirte un clic.' }),
        error),
      h('div', { class: 'dialog-actions dialog-actions-start' },
        h('button', { class: 'solid', type: 'button', text: 'Guardar canal', onclick: async () => {
          const res = await api.saveSettings({ discordCallUrl: input.value });
          if (!res.ok) { error.textContent = res.error; error.hidden = false; return; }
          error.hidden = true; state = res.value; toast('Canal de llamada guardado.', 'green');
        } }),
        h('button', { class: 'ghost', type: 'button', text: 'Probar llamada', onclick: () => callNow() }),
        h('button', { class: 'ghost', type: 'button', 'data-danger': true, text: 'Cerrar sesión del panel', onclick: async () => {
          const ok = await modal('¿Cerrar sesión en el panel de Discord?', [h('p', { text: 'Se borra la sesión guardada del panel y se corta cualquier llamada en curso. Tu cuenta de Discord no se toca.' })], [{ label: 'Cancelar', value: '' }, { label: 'Cerrar sesión', value: 'ok', primary: true }]);
          if (ok === 'ok') { const r = await api.discordPanelLogout(); if (!r.ok) toast(r.error, 'amber'); else toast('Sesión del panel cerrada.', 'green'); }
        } })),
    );
  }

  async function callNow() {
    const res = await api.discordPanelCall();
    if (!res.ok) return toast(res.error, 'amber');
    if (res.value.needsSetup) toast('Elige un canal de llamada predeterminado en Ajustes → Discord.', 'amber');
    return undefined;
  }

  window.pitchMods = { card, play, gamepadSection, callSection, callNow };
})();
