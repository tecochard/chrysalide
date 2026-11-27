'use strict';

(() => {
  const invoke = window.__TAURI__.core.invoke;
  const workerUrl = new URL('/detector.mjs', location.href);
  let detector;
  const hoverLandmarksKey = 'chrysalide.landmarksOnHover';
  let hoverLandmarks = false;
  try { hoverLandmarks = localStorage.getItem(hoverLandmarksKey) === 'true'; } catch { /* Storage may be unavailable. */ }

  async function detect(png) {
    const bitmap = await createImageBitmap(new Blob([png], {type: 'image/png'}));
    try {
      return await (detector ??= import(workerUrl.href)).then(module => module.landmarks(bitmap));
    } finally {
      bitmap.close();
    }
  }

  window.chrysalideDesktop = {
    get hoverLandmarks() { return hoverLandmarks; },
    mediaUrl(path) {
      return /^\/api\/(?:portraits\/[0-9a-f]{32}\/display|history\/[0-9a-f]{32}\.png)$/.test(path)
        ? `chrysalide-media://localhost${path}` : path;
    },
    async request(path, options = {}) {
      const method = options.method ?? 'GET';
      if (method === 'POST' && path === '/api/portraits') {
        const original = new Uint8Array(await options.body.arrayBuffer());
        if (original.length > 24 * 1024 * 1024) throw new Error('Fichier trop volumineux (24 Mio maximum).');
        const points = await detect(await invoke('prepare_portrait', original));
        const name = decodeURIComponent(options.headers['X-Filename']);
        const metadata = new TextEncoder().encode(JSON.stringify({name, points}) + '\n');
        const payload = new Uint8Array(metadata.length + original.length);
        payload.set(metadata);
        payload.set(original, metadata.length);
        return Response.json(await invoke('add_portrait', payload));
      }
      const body = new Uint8Array(await invoke('workshop', {method, path, data: options.body ? JSON.parse(options.body) : null}));
      const offset = body.indexOf(10);
      if (offset < 0) throw new Error('Réponse locale invalide.');
      const {mime, size} = JSON.parse(new TextDecoder().decode(body.subarray(0, offset)));
      const headers = {'Content-Type': mime};
      if (size) headers['X-Image-Size'] = size;
      return new Response(body.subarray(offset + 1), {headers});
    },
    download(path) { return invoke('download_media', {path}); },
  };

  window.addEventListener('DOMContentLoaded', () => {
    const {listen} = window.__TAURI__.event;
    Promise.all([
      listen('photo-drag-hover', ({payload}) => {
        hideDropHint();
        $('library-drop-hint').hidden = !payload || busy || $('bibliotheque').hidden;
      }),
      listen('photos-dropped', ({payload}) => {
        hideDropHint();
        if (busy || $('bibliotheque').hidden) return;
        if (!payload.length) {
          status('Aucun fichier local reçu.', 5000, true);
          return;
        }
        importPortraits(payload.map(({id, name}) => ({name, arrayBuffer: () => invoke('read_dropped_photo', {id})})));
      }),
    ]).catch(error => console.error('Glisser-déposer indisponible', error));

    const menu = el('details', undefined, 'library-menu');
    const trigger = el('summary', '⋯', 'secondary');
    trigger.title = 'Gérer la bibliothèque';
    trigger.setAttribute('aria-label', trigger.title);
    const actions = el('div', undefined, 'library-transfer');
    for (const [label, importing] of [['Importer une bibliothèque', true], ['Exporter la bibliothèque', false]]) {
      const transfer = button(label, () => run('Ouverture du fichier…', async () => {
        menu.open = false;
        trigger.focus();
        if (!await invoke('transfer_library', {import: importing})) return '';
        if (!importing) return 'Bibliothèque exportée.';
        await refreshLibrary();
        history = await (await api('/api/history')).json();
        historyView();
        return 'Bibliothèque importée.';
      }), 'secondary');
      transfer.dataset.workshopAction = '';
      actions.append(transfer);
    }
    const setting = el('label', undefined, 'library-switch');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.setAttribute('role', 'switch');
    toggle.checked = hoverLandmarks;
    toggle.addEventListener('change', () => {
      hoverLandmarks = toggle.checked;
      try { localStorage.setItem(hoverLandmarksKey, String(hoverLandmarks)); }
      catch { status('Impossible d’enregistrer le réglage.', 4000, true); }
      refreshHoveredPortrait?.();
    });
    const track = el('span', undefined, 'library-switch-track');
    track.setAttribute('aria-hidden', 'true');
    setting.append('Repères au survol', toggle, track);
    actions.append(setting);
    menu.append(trigger, actions);
    $('library-tools').append(menu);
    document.addEventListener('click', event => {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
    menu.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !menu.open) return;
      event.preventDefault();
      menu.open = false;
      trigger.focus();
    });
  });
})();
