'use strict';

const $ = id => document.getElementById(id);
const viewIds = ['bibliotheque', 'composer', 'historique', 'jeu'];
const dateFormat = new Intl.DateTimeFormat('fr-FR', {dateStyle: 'medium', timeStyle: 'short'});
const percent = new Intl.NumberFormat('fr-FR', {style: 'percent', maximumFractionDigits: 2});
let portraits = [];
let history = [];
let selected = [];
let librarySelectionAnchor;
let weights = [];
let reopened = null;
let preview = null;
let objectUrl = null;
let busy = false;
const previewDelay = 1000;
let previewTimer;
let previewDue = null;
let previewRevision = 0;
let previewRendering = false;
let gameLibraryReady = false;
let gameLoading = false;
let gameSkipPending = false;
let gameRevision = 0;
let gameRound = null;
let gameImageUrl = null;
const gameChoiceLimit = 24;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className) {
  const node = el('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function link(text, href, filename) {
  const node = el('a', text);
  node.href = href;
  node.download = filename;
  return node;
}

function image(src, alt, className) {
  const node = el('img', undefined, className);
  node.alt = alt;
  node.loading = 'lazy';
  setImageSource(node, src);
  return node;
}

function setImageSource(node, src) {
  const url = window.chrysalideDesktop?.mediaUrl(src) ?? src;
  if (url !== src && src.startsWith('/api/history/')) node.crossOrigin = 'anonymous';
  else node.removeAttribute('crossorigin');
  node.src = url;
}

const display = p => `/api/portraits/${p.id}/display`;
const svgNS = 'http://www.w3.org/2000/svg';

function icon(path) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(svgNS, 'path');
  shape.setAttribute('d', path);
  shape.setAttribute('fill', 'none');
  shape.setAttribute('stroke', 'currentColor');
  shape.setAttribute('stroke-width', '2');
  shape.setAttribute('stroke-linecap', 'round');
  shape.setAttribute('stroke-linejoin', 'round');
  svg.append(shape);
  return svg;
}

function downloadLink(url, filename, label, description = label) {
  const download = link('', url, filename);
  if (window.chrysalideDesktop) {
    download.addEventListener('click', event => {
      event.preventDefault();
      run('Ouverture du fichier…', async () => await window.chrysalideDesktop.download(url) ? 'Image enregistrée.' : '');
    });
  }
  download.className = 'portrait-icon';
  download.append(icon('M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4'));
  download.title = label;
  download.setAttribute('aria-label', description);
  return download;
}

async function api(path, options) {
  if (window.chrysalideDesktop) {
    try { return await window.chrysalideDesktop.request(path, options); }
    catch (error) { throw new Error(error.message || String(error)); }
  }
  const response = await fetch(path, options);
  if (!response.ok) {
    if (options?.method === 'DELETE' && response.status === 501) {
      throw new Error('Redémarre le serveur de Chrysalide, puis réessaie la suppression.');
    }
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Erreur locale (${response.status}).`);
  }
  return response;
}

const jsonPost = value => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});

let toastTimer;
function status(message, duration = 0, isError = false) {
  const toast = $('status');
  clearTimeout(toastTimer);
  toast.classList.toggle('toast-error', isError);
  toast.textContent = message;
  if (message && duration) toastTimer = setTimeout(() => { toast.textContent = ''; }, duration);
}

function updateButtons() {
  $('upload').disabled = busy;
  const updating = previewDue !== null || previewRendering;
  $('pin-form').hidden = !preview && !(updating && $('preview-image').hasAttribute('src'));
  $('butterfly-name').disabled = busy || !preview;
  $('save').disabled = busy || !preview;
  document.querySelectorAll('#frame, #alpha, [data-workshop-action]')
    .forEach(control => { control.disabled = busy; });
  document.querySelectorAll('#weight-controls input')
    .forEach(control => { control.disabled = busy || selected.length < 2; });
  updateGameRecipeButton();
}

async function run(message, action) {
  if (busy) return;
  busy = true;
  updateButtons();
  status(message);
  try {
    status(await action() || '', 3000);
  } catch (error) {
    status(error.message || 'Le traitement local a échoué.', 6000, true);
  } finally {
    busy = false;
    updateButtons();
    schedulePreview();
  }
}

let currentView;
let libraryScroll = 0;

function route() {
  const hash = location.hash.slice(1);
  const view = viewIds.includes(hash) ? hash : viewIds[0];
  if (currentView === 'bibliotheque' && view === 'composer') libraryScroll = window.scrollY;
  for (const id of viewIds) {
    $(id).hidden = id !== view;
    const nav = document.querySelector(`nav a[href="#${id}"]`);
    if (id === view) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  if (currentView === 'bibliotheque' && view === 'composer') window.scrollTo(0, 0);
  else if (currentView === 'composer' && view === 'bibliotheque') window.scrollTo(0, libraryScroll);
  currentView = view;
  $('library-drop-hint').hidden = true;
  schedulePreview();
  if (view === 'jeu') updateGameAvailability();
  else $('jeu').classList.remove('game-reveal');
}

let refreshHoveredPortrait;

function libraryView() {
  refreshHoveredPortrait = undefined;
  const counts = new Map();
  for (const {name} of portraits) counts.set(name, (counts.get(name) || 0) + 1);
  $('library').replaceChildren(...portraits.map(p => portraitTile(p, counts.get(p.name) > 1)));
  $('library-empty').hidden = portraits.length > 0;
}

function portraitTile(p, duplicate) {
  const tile = el('article', undefined, 'portrait-tile');
  const frame = el('div', undefined, 'portrait-frame');
  const photo = image(display(p), `Portrait : ${p.name}`);
  const overlay = document.createElementNS(svgNS, 'svg');
  overlay.classList.add('portrait-points');
  overlay.setAttribute('viewBox', `0 0 ${p.width} ${p.height}`);
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('hidden', '');
  frame.append(photo, overlay);

  const caption = el('div', undefined, 'portrait-caption');
  const title = el('h3', p.name);
  const version = p.sha.slice(0, 8);
  if (duplicate) title.append(' ', el('small', version, 'hint'));
  const description = duplicate ? `${p.name}, version ${version}` : p.name;
  const select = button('', event => selectLibraryPortrait(p.id, event.shiftKey), 'portrait-select');
  select.dataset.portrait = p.id;
  select.dataset.workshopAction = '';
  select.title = 'Sélectionner pour le cocon';
  select.setAttribute('aria-label', `Sélection pour le cocon : ${description}`);
  select.setAttribute('aria-pressed', String(selected.includes(p.id)));
  const check = el('span', '✓', 'game-result-mark');
  check.setAttribute('aria-hidden', 'true');
  select.append(check);
  frame.append(select);
  const controls = el('div', undefined, 'portrait-controls');
  const label = el('label');
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.setAttribute('aria-label', `Repères sur ${description}`);
  label.append(toggle, 'Repères');
  const original = downloadLink(`/api/portraits/${p.id}/original`, p.name,
    'Télécharger l’original', `Télécharger l’original : ${description}`);

  let pending;
  function getPoints() {
    pending ??= api(`/api/portraits/${p.id}/points`).then(response => response.json()).catch(error => {
      pending = undefined;
      throw error;
    });
    return pending;
  }

  const gear = el('button', undefined, 'portrait-icon');
  const properties = portraitProperties(p, version, getPoints,
    deleteIcon(`Supprimer la chenille : ${description}`, () => removePortrait(p, description, gear)));
  gear.type = 'button';
  gear.title = 'Propriétés';
  gear.setAttribute('aria-label', `Propriétés : ${description}`);
  gear.popoverTargetElement = properties;
  gear.append(icon('M9 3h6l.5 2.5 2 .9 2.3-1.1 2.2 3.8-1.8 1.7v2.4l1.8 1.7-2.2 3.8-2.3-1.1-2 .9L15 21H9l-.5-2.5-2-.9-2.3 1.1L2 14.9l1.8-1.7v-2.4L2 9.1l2.2-3.8 2.3 1.1 2-.9L9 3ZM15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z'));
  controls.append(label, original, gear);
  caption.append(title, controls);

  const message = el('p', '', 'portrait-message');
  message.setAttribute('role', 'status');
  tile.append(frame, caption, message, properties);

  let hovering = false;
  const wantsPoints = () => toggle.checked || (hovering && (window.chrysalideDesktop?.hoverLandmarks ?? true));

  async function updatePoints() {
    overlay.toggleAttribute('hidden', !wantsPoints() || !overlay.hasChildNodes());
    if (!wantsPoints() || overlay.hasChildNodes()) return;
    try {
      const points = await getPoints();
      if (!wantsPoints()) return;
      if (!overlay.hasChildNodes()) drawPortraitPoints(p, overlay, points);
      overlay.removeAttribute('hidden');
      message.textContent = '';
    } catch {
      if (toggle.checked) {
        toggle.checked = false;
        message.textContent = 'Impossible de charger les repères.';
      }
    }
  }

  toggle.addEventListener('change', () => {
    message.textContent = '';
    updatePoints();
  });
  frame.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'mouse') return;
    hovering = true;
    refreshHoveredPortrait = updatePoints;
    updatePoints();
  });
  frame.addEventListener('pointerleave', event => {
    if (event.pointerType !== 'mouse') return;
    hovering = false;
    if (refreshHoveredPortrait === updatePoints) refreshHoveredPortrait = undefined;
    if (!toggle.checked) overlay.setAttribute('hidden', '');
  });
  return tile;
}

function portraitProperties(p, version, getPoints, remove) {
  const panel = el('section', undefined, 'portrait-properties');
  panel.setAttribute('popover', 'auto');
  const heading = el('h3', 'Propriétés');
  heading.id = `proprietes-${p.id}`;
  panel.setAttribute('aria-labelledby', heading.id);
  const details = el('dl');
  const count = el('dd');
  count.setAttribute('aria-live', 'polite');
  details.append(el('dt', 'Dimensions'), el('dd', `${p.width} × ${p.height} px`),
    el('dt', 'Repères'), count, el('dt', 'Import'), el('dd', dateFormat.format(new Date(p.created))),
    el('dt', 'Version'), el('dd', version));
  const header = el('div', undefined, 'actions');
  header.append(heading, remove);
  panel.append(header, el('p', p.name, 'hint'), details);
  panel.addEventListener('toggle', async event => {
    if (event.newState !== 'open') return;
    try {
      count.textContent = (await getPoints()).length;
    } catch {
      count.textContent = 'Indisponible';
    }
  });
  return panel;
}

function drawPortraitPoints(p, overlay, points) {
  const radius = Math.min(p.width, p.height) / 260;
  overlay.replaceChildren(...points.map(([x, y]) => {
    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('cx', x * p.width);
    dot.setAttribute('cy', y * p.height);
    dot.setAttribute('r', radius);
    return dot;
  }));
}

function deleteIcon(label, action, extraClass = '') {
  const remove = button('', action, `portrait-icon delete-icon ${extraClass}`);
  remove.append(icon('M3 6h18M9 6V3h6v3m4 0-1 15H6L5 6m5 4v7m4-7v7'));
  remove.title = label;
  remove.setAttribute('aria-label', label);
  remove.dataset.workshopAction = '';
  return remove;
}

async function removePortrait(portrait, description, trigger) {
  if (busy) return;
  const path = `/api/portraits/${portrait.id}`;
  await run('Vérification des papillons associés…', async () => {
    const {butterflies} = await (await api(path)).json();
    const dialog = $('portrait-delete');
    const message = $('portrait-delete-message');
    message.textContent = `L’image « ${description} » et ses points d’intérêt seront supprimés de la bibliothèque.`;
    if (butterflies) {
      message.append(el('br'), butterflies === 1 ? 'Le papillon créé avec cette image sera aussi supprimé.'
        : `Les ${butterflies} papillons créés avec cette image seront aussi supprimés.`);
    }
    trigger.popoverTargetElement.hidePopover();
    dialog.returnValue = '';
    status('');
    const confirmed = await new Promise(resolve => {
      dialog.showModal();
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), {once: true});
    });
    if (!confirmed) return;
    status('Suppression de la chenille…');
    await api(path, {...jsonPost({butterflies}), method: 'DELETE'});

    const usesPortrait = recipe => recipe?.sources?.some(source => source.id === portrait.id);
    portraits = portraits.filter(p => p.id !== portrait.id);
    history = history.filter(item => !usesPortrait(item.recipe));
    const index = selected.indexOf(portrait.id);
    if (index !== -1) {
      selected = selected.filter(id => id !== portrait.id);
      weights = normalizedWeights(weights.filter((_, i) => i !== index));
      setPreview();
      changed();
    }
    if (gameLoading || gameRound?.pair.includes(portrait.id) || Array.from($('game-choices').children).some(choice => choice.dataset.portrait === portrait.id)) {
      gameRevision++;
      gameSkipPending = false;
      gameRound = null;
      if (gameImageUrl) URL.revokeObjectURL(gameImageUrl);
      gameImageUrl = null;
      $('game-image').removeAttribute('src');
      $('game-image').hidden = true;
      $('game-face').hidden = true;
      $('game-next').textContent = 'Papillon suivant';
      $('game-choices').replaceChildren();
      $('jeu').classList.remove('game-reveal');
    }
    libraryView();
    updateCoconSelection();
    historyView();
    updateGameAvailability();
    return 'Chenille supprimée.';
  });
  if (!$('bibliotheque').hidden) (trigger.isConnected ? trigger : $('upload')).focus();
}

async function refreshLibrary() {
  portraits = await (await api('/api/portraits')).json();
  libraryView();
  weightControls();
  gameLibraryReady = true;
  updateGameAvailability();
}

$('upload').addEventListener('click', () => $('files').click());
$('files').addEventListener('change', () => {
  const files = Array.from($('files').files);
  $('files').value = '';
  importPortraits(files);
});

function isExternalFileDrag(data) {
  return data && (data.files.length > 0 || data.types.includes('Files') || data.types.includes('text/uri-list'));
}

let dropLeaveTimer;
function hideDropHint() {
  clearTimeout(dropLeaveTimer);
  $('library-drop-hint').hidden = true;
}

function acceptFileDrag(event) {
  if (!isExternalFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  clearTimeout(dropLeaveTimer);
  const canImport = !busy && !$('bibliotheque').hidden;
  event.dataTransfer.dropEffect = canImport ? 'copy' : 'none';
  $('library-drop-hint').hidden = !canImport;
}

document.addEventListener('dragenter', acceptFileDrag);
document.addEventListener('dragover', acceptFileDrag);

document.addEventListener('dragleave', event => {
  if (event.relatedTarget || $('library-drop-hint').hidden) return;
  clearTimeout(dropLeaveTimer);
  dropLeaveTimer = setTimeout(hideDropHint, 100);
});

document.addEventListener('drop', event => {
  hideDropHint();
  if (!isExternalFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  if (busy || $('bibliotheque').hidden) return;
  const files = Array.from(event.dataTransfer.files);
  if (files.length) importPortraits(files);
  else status('Aucun fichier reçu. Utilise « Ajouter des chenilles » pour choisir tes images.', 5000, true);
});

function importPortraits(files) {
  if (!files.length) return;
  run('Détection en cours…', async () => {
    const errors = $('import-errors');
    errors.replaceChildren();
    errors.hidden = true;
    let count = 0;
    for (const [index, file] of files.entries()) {
      status(`Détection ${index + 1}/${files.length} : ${file.name}…`);
      try {
        await api('/api/portraits', {
          method: 'POST', headers: {'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name)}, body: file,
        });
        count++;
      } catch (error) {
        errors.append(el('li', `${file.name} : ${error.message}`));
        errors.hidden = false;
      }
    }
    await refreshLibrary();
    return count ? `${count} ${count === 1 ? 'portrait disponible' : 'portraits disponibles'}.` : 'Aucun de ces fichiers n’a été importé.';
  });
}

function previewState(state) {
  $('preview-stage').dataset.state = state;
  $('preview-title').textContent = state === 'result' ? 'Le papillon' : 'Le cocon';
  $('preview-note').textContent = {
    empty: 'Sélectionnez au moins deux portraits.',
    waiting: 'Le papillon va prendre forme…',
    working: 'Métamorphose en cours…',
    error: 'Aperçu indisponible. Modifie un réglage pour réessayer.',
  }[state] || '';
}

function previewProgress(message) {
  const progress = $('preview-progress');
  progress.textContent = message;
  progress.hidden = !message;
  $('dimensions').hidden = !!message;
}

function setPreview(src = '', dimensions = '', frame = 'full') {
  const previewImage = $('preview-image');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = src.startsWith('blob:') ? src : null;
  previewImage.hidden = !src;
  $('preview-face').hidden = true;
  previewImage.dataset.frame = frame;
  if (src) setImageSource(previewImage, src);
  else previewImage.removeAttribute('src');
  $('dimensions').textContent = dimensions;
  previewState(src ? 'result' : 'empty');
}

// Recadre uniquement l’affichage. L’original reste utilisé par l’export.
function cropFaceDetail(image, canvas) {
  const w = image.naturalWidth, h = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx || !w || !h) return;
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let left = w, top = h, right = -1, bottom = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[(y * w + x) * 4 + 3]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left) return;
  const margin = Math.ceil(Math.max(right - left, bottom - top) / 8);
  left = Math.max(0, left - margin);
  top = Math.max(0, top - margin);
  canvas.width = Math.min(w, right + 1 + margin) - left;
  canvas.height = Math.min(h, bottom + 1 + margin) - top;
  ctx.drawImage(image, -left, -top);
  return true;
}

function drawFaceDetail(image, canvas) {
  if (!cropFaceDetail(image, canvas)) return;
  image.hidden = true;
  canvas.hidden = false;
}

$('preview-image').addEventListener('load', event => {
  const image = event.currentTarget;
  if (image.dataset.frame === 'face' && !image.hidden) drawFaceDetail(image, $('preview-face'));
});

function updateGameAvailability() {
  if ($('jeu').hidden || !gameLibraryReady) return;
  const playable = portraits.length >= 2;
  $('game-empty').hidden = playable;
  $('game-board').hidden = !playable;
  if (!playable) $('game-empty').textContent = 'Ajoute au moins deux portraits dans Chenilles pour jouer.';
  else if (!gameRound && !gameLoading) nextGameRound();
}

function randomGamePair(ids, previous) {
  let pair;
  do {
    const first = Math.floor(Math.random() * ids.length);
    const second = Math.floor(Math.random() * (ids.length - 1));
    pair = [ids[first], ids[second < first ? second : second + 1]].sort();
  } while (ids.length > 2 && previous && pair.every((id, i) => id === previous[i]));
  return pair;
}

function sampleGamePortraits(values, limit = values.length) {
  const pool = [...values];
  const size = Math.min(limit, pool.length);
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, size);
}

function gameCandidates(collection, pair) {
  if (collection.length <= gameChoiceLimit) return collection;
  const sources = collection.filter(p => pair.includes(p.id));
  const decoys = sampleGamePortraits(collection.filter(p => !pair.includes(p.id)), gameChoiceLimit - sources.length);
  return sampleGamePortraits([...sources, ...decoys]);
}

const gameChoices = $('game-choices');

function fitGameChoices(width, height) {
  const count = gameChoices.childElementCount;
  if (!count || !width || !height) return;
  const gap = parseFloat(getComputedStyle(gameChoices).columnGap);
  let best = {columns: 1, size: 0, empty: count};
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const size = Math.floor(Math.min((width - (columns - 1) * gap) / columns,
      (height - (rows - 1) * gap) / rows));
    const empty = columns * rows - count;
    if (size > best.size || (size === best.size && empty < best.empty)) best = {columns, size, empty};
  }
  gameChoices.style.setProperty('--game-columns', best.columns);
  gameChoices.style.setProperty('--game-tile', `${best.size}px`);
}

new ResizeObserver(([{contentRect: {width, height}}]) => fitGameChoices(width, height)).observe(gameChoices);

function renderGameChoices(candidates, round) {
  const choices = gameChoices;
  const existing = new Map(Array.from(choices.children, choice => [choice.dataset.portrait, choice]));
  choices.replaceChildren(...candidates.map(p => {
    let choice = existing.get(p.id);
    if (!choice) {
      choice = button('', () => guessGamePortrait(gameRound, p.id), 'game-choice');
      choice.dataset.portrait = p.id;
      choice.append(image(display(p), `Portrait : ${p.name.replace(/\.[^.]+$/, '')}`));
    }
    updateGameCard(choice, round);
    return choice;
  }));
  choices.style.setProperty('--game-count', Math.max(1, candidates.length));
  const {width, height} = choices.getBoundingClientRect();
  fitGameChoices(width, height);
}

function updateGameCard(choice, round) {
  const key = choice.dataset.portrait;
  const picked = round?.guesses.has(key) ?? false;
  const finished = round?.guesses.size === 2;
  choice.setAttribute('aria-pressed', String(picked));
  choice.disabled = !round || finished;
  const answer = finished && round.pair.includes(key);
  const result = answer ? (picked ? 'answer' : 'missed') : finished && picked ? 'wrong' : null;
  if (choice.dataset.result === (result ?? undefined)) return;
  choice.querySelector('.game-result-mark')?.remove();
  if (!result) {
    choice.removeAttribute('aria-label');
    delete choice.dataset.result;
    return;
  }
  choice.dataset.result = result;
  const label = answer ? (picked ? 'Bonne réponse trouvée' : 'Bonne réponse non trouvée') : 'Mauvais choix';
  choice.setAttribute('aria-label', `${choice.firstElementChild.alt} : ${label}`);
  const symbol = el('span', answer ? (picked ? '✓' : '!') : '×', 'game-result-mark');
  symbol.setAttribute('aria-hidden', 'true');
  choice.append(symbol);
}

function updateGameRecipeButton() {
  const count = gameLoading ? 0 : gameRound?.guesses.size ?? 0;
  const button = $('game-recipe');
  button.setAttribute('aria-disabled', String(busy || count < 2));
  if (count < 2) button.title = `Sélectionne 2 chenilles (${count}/2)`;
  else button.removeAttribute('title');
}

function guessGamePortrait(round, id) {
  if (gameLoading || !round || round !== gameRound || round.guesses.size === 2) return;
  if (round.guesses.has(id)) round.guesses.delete(id);
  else round.guesses.add(id);
  const finished = round.guesses.size === 2;
  const count = $('game-count');
  count.textContent = finished ? '2 / 2 · Validé' : `${round.guesses.size} / 2`;
  count.classList.toggle('game-count-validated', finished);
  for (const choice of $('game-choices').children) updateGameCard(choice, round);
  updateGameRecipeButton();
  if (!finished) return;
  $('jeu').classList.add('game-reveal');
  const correct = round.pair.every(key => round.guesses.has(key));
  $('game-feedback').textContent = $(correct ? 'game-success-message' : 'game-failure-message').textContent;
  $('game-next').focus({preventScroll: true});
}

async function nextGameRound(focusChoices = false) {
  if (portraits.length < 2) return;
  if (gameLoading) {
    gameSkipPending ||= focusChoices;
    return;
  }
  gameLoading = true;
  updateGameRecipeButton();
  const revision = gameRevision;
  $('jeu').classList.remove('game-reveal');
  const pair = randomGamePair(portraits.map(p => p.id), gameRound?.pair);
  gameRound = null;
  const candidates = gameCandidates(portraits, pair);
  const recipe = {frame: 'face', alpha: 'max', sources: pair.map(id => ({id, raw_weight: .5}))};
  const stage = $('game-stage');
  const photo = $('game-image');
  const detail = $('game-face');
  const next = $('game-next');
  next.textContent = 'Papillon suivant';
  stage.setAttribute('aria-busy', 'true');
  $('game-wait').hidden = false;
  $('game-wait').textContent = 'Le papillon prend forme…';
  $('game-count').textContent = '';
  $('game-count').classList.remove('game-count-validated');
  $('game-feedback').textContent = 'Préparation de la manche…';
  for (const choice of $('game-choices').children) updateGameCard(choice, null);
  try {
    const response = await api('/api/preview', jsonPost(recipe));
    const blob = await response.blob();
    if (revision !== gameRevision) return;
    const nextImageUrl = URL.createObjectURL(blob);
    if (gameImageUrl) URL.revokeObjectURL(gameImageUrl);
    gameImageUrl = nextImageUrl;
    photo.src = gameImageUrl;
    await photo.decode();
    if (revision !== gameRevision) return;
    detail.hidden = true;
    photo.hidden = false;
    drawFaceDetail(photo, detail);
    stage.dataset.state = 'result';
    $('game-wait').hidden = true;
    $('game-count').textContent = '0 / 2';
    $('game-feedback').textContent = '';
    gameRound = {pair, guesses: new Set(), recipe, blob, dimensions: `${photo.naturalWidth} × ${photo.naturalHeight} px`};
    renderGameChoices(candidates, gameRound);
    if (focusChoices && !gameSkipPending && !$('jeu').hidden) $('game-choices').firstElementChild?.focus();
  } catch (error) {
    if (revision !== gameRevision) return;
    $('game-wait').textContent = 'Papillon indisponible.';
    $('game-feedback').textContent = error.message || 'Le papillon n’a pas pu être généré.';
    next.textContent = 'Réessayer';
    if (focusChoices && !$('jeu').hidden) next.focus();
  } finally {
    gameLoading = false;
    stage.setAttribute('aria-busy', 'false');
    updateGameRecipeButton();
    const skip = gameSkipPending;
    gameSkipPending = false;
    if (revision !== gameRevision) updateGameAvailability();
    else if (skip && !$('jeu').hidden) nextGameRound(true);
  }
}

$('game-next').addEventListener('click', () => nextGameRound(true));
$('game-recipe').addEventListener('click', () => {
  if ($('game-recipe').getAttribute('aria-disabled') === 'true') return;
  const {recipe, blob, dimensions} = gameRound;
  openComposition(recipe, URL.createObjectURL(blob), dimensions, true);
});

function changed(autoPreview = true) {
  reopened = null;
  preview = null;
  previewRevision++;
  const canRender = autoPreview && selected.length >= 2 && weights.some(weight => weight > 0);
  previewDue = canRender ? performance.now() + previewDelay : null;
  if (!canRender) {
    $('butterfly-name').value = '';
    setPreview();
    previewProgress('');
  } else if ($('preview-image').hasAttribute('src')) {
    previewProgress('Mise à jour de l’aperçu…');
  } else {
    previewState('waiting');
    previewProgress('');
  }
  updateButtons();
  schedulePreview();
}

function openComposition(recipe, src, dimensions, canPin = false) {
  librarySelectionAnchor = undefined;
  selected = recipe.sources.map(source => source.id);
  weights = recipe.sources.map(source => source.raw_weight);
  for (const group of ['frame', 'alpha']) {
    const option = [...$(group).querySelectorAll('input')].find(input => input.value === recipe[group]);
    if (option) option.checked = true;
  }
  changed(false);
  reopened = recipe;
  if (canPin) preview = recipe;
  setPreview(src, dimensions, recipe.frame);
  updateCoconSelection();
  updateButtons();
  location.hash = 'composer';
}

function updateCoconSelection() {
  const count = selected.length;
  $('cocon-count').textContent = count;
  $('cocon-count').hidden = !count;
  $('nav-cocon').setAttribute('aria-label', count ? `Cocon, ${count} chenille${count === 1 ? '' : 's'}` : 'Cocon');
  const ids = new Set(selected);
  for (const control of $('library').querySelectorAll('.portrait-select')) {
    control.setAttribute('aria-pressed', String(ids.has(control.dataset.portrait)));
  }
  weightControls();
}

function selectLibraryPortrait(id, extend) {
  if (busy) return;
  const anchor = extend ? portraits.findIndex(p => p.id === librarySelectionAnchor) : -1;
  if (anchor < 0) {
    librarySelectionAnchor = id;
    toggleCoconPortrait(id);
    return;
  }
  const target = portraits.findIndex(p => p.id === id);
  if (target < 0) return;
  const existing = new Set(selected);
  const added = portraits.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)
    .map(p => p.id).filter(id => !existing.has(id));
  if (!added.length) return;
  addCoconPortraits(added);
  changed();
  updateCoconSelection();
}

function addCoconPortraits(ids) {
  const previousCount = selected.length;
  selected = [...selected, ...ids];
  weights = normalizedWeights(weights).map(weight => weight * previousCount / selected.length)
    .concat(ids.map(() => 1 / selected.length));
}

function toggleCoconPortrait(id) {
  if (busy) return;
  const index = selected.indexOf(id);
  if (index === -1) {
    addCoconPortraits([id]);
  } else {
    selected = selected.filter(portraitId => portraitId !== id);
    weights = normalizedWeights(weights.filter((_, i) => i !== index));
  }
  changed();
  updateCoconSelection();
}

$('clear-cocon').addEventListener('click', () => {
  if (busy || !selected.length) return;
  librarySelectionAnchor = undefined;
  selected = [];
  weights = [];
  changed();
  updateCoconSelection();
  $('choose-first-portraits').focus();
});

function normalizedWeights(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map(value => total ? value / total : 1 / values.length);
}

function redistributeWeights(values, index, share) {
  const others = normalizedWeights(values.filter((_, i) => i !== index));
  return values.map((_, i) => i === index ? share : others[i < index ? i : i - 1] * (1 - share));
}

function weightControls() {
  $('composer-empty').hidden = selected.length > 0;
  $('composer').querySelector('.section-head').hidden = !selected.length;
  $('composer-workspace').hidden = !selected.length;
  $('weights').hidden = !selected.length;
  const box = $('weight-controls');
  const bar = $('weight-bar');
  box.replaceChildren();
  bar.replaceChildren();
  if (!selected.length) return;
  const controls = selected.map((id, index) => {
    const portrait = portraits.find(p => p.id === id);
    const name = portrait?.name ?? id;
    const row = el('div', undefined, 'mix-source');
    const segment = el('span');
    const tone = String(index % 6);
    segment.dataset.tone = row.dataset.tone = tone;
    if (portrait) row.append(image(display(portrait), ''));
    const control = el('label', undefined, 'mix-control');
    const filename = el('span', name, 'mix-name');
    filename.title = name;
    const slider = el('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.setAttribute('aria-label', `Contribution de ${name}`);
    const output = el('span', '', 'mix-percent');
    slider.addEventListener('input', () => {
      weights = redistributeWeights(weights, index, Number(slider.value) / 100);
      changed();
      update();
    });
    control.append(filename, slider);
    const remove = button('', () => {
      if (busy) return;
      toggleCoconPortrait(id);
      const next = box.querySelectorAll('.mix-remove')[Math.min(index, selected.length - 1)];
      (next ?? $('choose-first-portraits')).focus();
    }, 'portrait-icon mix-remove');
    remove.title = `Retirer du cocon : ${name}`;
    remove.setAttribute('aria-label', remove.title);
    remove.dataset.workshopAction = '';
    remove.append(icon('M6 6l12 12M18 6 6 18'));
    row.append(control, output, remove);
    box.append(row);
    bar.append(segment);
    return {name, slider, output, segment};
  });
  function update() {
    normalizedWeights(weights).forEach((share, index) => {
      const {name, slider, output, segment} = controls[index];
      const value = percent.format(share);
      slider.value = Math.round(100 * share);
      slider.setAttribute('aria-valuetext', value);
      output.textContent = value;
      segment.title = `${name} : ${value}`;
      segment.style.flexGrow = share;
    });
    updateButtons();
  }
  update();
}

function composition() {
  return reopened || {frame: $('frame').querySelector(':checked').value, alpha: $('alpha').querySelector(':checked').value,
    sources: selected.map((id, index) => ({id, raw_weight: weights[index]}))};
}

$('frame').addEventListener('change', () => changed());
$('alpha').addEventListener('change', () => changed());

function schedulePreview() {
  clearTimeout(previewTimer);
  if (previewDue === null || previewRendering || busy || $('composer').hidden) return;
  previewTimer = setTimeout(renderComposerPreview, Math.max(0, previewDue - performance.now()));
}

async function renderComposerPreview() {
  if (previewDue === null || previewRendering || busy || $('composer').hidden) return;
  previewDue = null;
  previewRendering = true;
  const revision = previewRevision;
  const request = composition();
  if ($('preview-image').hasAttribute('src')) previewProgress('Métamorphose en cours…');
  else previewState('working');
  try {
    const response = await api('/api/preview', jsonPost(request));
    const blob = await response.blob();
    if (revision !== previewRevision) return;
    const dimensions = response.headers.get('X-Image-Size')?.replace('x', ' × ');
    setPreview(URL.createObjectURL(blob), dimensions ? `${dimensions} px` : '', request.frame);
    preview = request;
    previewProgress('');
  } catch (error) {
    if (revision !== previewRevision) return;
    if ($('preview-image').hasAttribute('src')) previewProgress('Mise à jour impossible.');
    else {
      previewState('error');
      previewProgress('');
    }
    if (!$('composer').hidden && !busy) status(error.message || 'Le rendu a échoué.', 6000, true);
  } finally {
    previewRendering = false;
    updateButtons();
    schedulePreview();
  }
}

$('pin-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!preview) return;
  run('Sauvegarde du rendu et de sa recette…', async () => {
    const item = await (await api('/api/history', jsonPost({...preview, name: $('butterfly-name').value}))).json();
    history.unshift(item);
    historyView();
    return 'Papillon épinglé.';
  });
});

function specimen(item, index) {
  const r = item.recipe;
  const url = `/api/history/${item.id}.png`;
  const card = el('article', undefined, 'specimen');
  const mount = el('button', undefined, 'specimen-mount');
  mount.type = 'button';
  const name = r.name || `Papillon ${index + 1}`;
  mount.setAttribute('aria-label', `Ouvrir la fiche : ${name}`);
  const photo = image(url, '');
  mount.append(photo);
  if (r.frame === 'face') {
    photo.addEventListener('load', async () => {
      const canvas = el('canvas');
      try {
        if (!cropFaceDetail(photo, canvas)) return;
        const detail = image(canvas.toDataURL(), '');
        detail.loading = 'eager';
        await detail.decode();
        photo.replaceWith(detail);
      } catch {
        // Keep the original PNG visible if the cropped thumbnail cannot be created.
      }
    }, {once: true});
  }
  const pin = icon('M12 11 29 37');
  pin.classList.add('specimen-pin');
  pin.setAttribute('viewBox', '0 0 40 48');
  const head = document.createElementNS(svgNS, 'circle');
  head.classList.add('specimen-pin-head');
  head.setAttribute('cx', '10');
  head.setAttribute('cy', '8');
  head.setAttribute('r', '5');
  pin.append(head);
  mount.append(pin);

  const panel = el('section', undefined, 'specimen-details');
  panel.setAttribute('popover', 'auto');
  const title = el('h3', name);
  title.id = `specimen-${item.id}`;
  panel.setAttribute('aria-labelledby', title.id);
  mount.popoverTargetElement = panel;
  const sources = el('ul', undefined, 'specimen-sources');
  for (const src of r.sources) {
    const row = el('li');
    row.append(el('span', src.name), el('span', percent.format(src.weight), 'hint'));
    sources.append(row);
  }

  const reopen = button('Rouvrir la recette', () => {
    panel.hidePopover();
    openComposition(r, url, `${r.width} × ${r.height} px · Papillon épinglé`);
  }, 'specimen-reopen');
  reopen.title = 'Retrouver les sources et les réglages dans le Cocon';
  reopen.dataset.workshopAction = '';
  const header = el('div', undefined, 'actions');
  header.append(title, downloadLink(url, `morphing-${item.id.slice(0, 8)}.png`, 'Télécharger le PNG'));
  const properties = el('dl', undefined, 'specimen-properties');
  const alphaValue = el('dd', r.alpha === 'max' ? 'Maximum' : 'Moyen', 'specimen-alpha');
  properties.append(el('dt', 'Dimensions'), el('dd', `${r.width} × ${r.height} px`),
    el('dt', 'Cadrage'), el('dd', r.frame === 'face' ? 'Visage seul' : 'Image entière'),
    el('dt', 'Alpha'), alphaValue);
  const date = el('time', dateFormat.format(new Date(item.created)), 'hint');
  date.dateTime = item.created;
  const recipeDetails = el('details', undefined, 'specimen-recipe');
  recipeDetails.append(el('summary', 'Révéler la recette'), sources, reopen);
  recipeDetails.addEventListener('toggle', () => {
    recipeDetails.firstElementChild.textContent = recipeDetails.open ? 'Masquer la recette' : 'Révéler la recette';
  });
  const remove = deleteIcon(`Supprimer le papillon : ${name}`, () => {
    if (busy || !window.confirm(`Supprimer « ${name} » et sa recette ? Les portraits d’origine seront conservés.`)) return;
    run('Suppression du papillon…', async () => {
      await api(`/api/history/${item.id}`, {method: 'DELETE'});
      if (panel.matches(':popover-open')) panel.hidePopover();
      history = history.filter(entry => entry.id !== item.id);
      if (reopened === r) changed(false);
      historyView();
      if (!$('historique').hidden) {
        const next = $('history').querySelectorAll('.specimen-mount')[Math.min(index, history.length - 1)];
        (next || document.querySelector('nav a[href="#historique"]')).focus();
      }
      return 'Papillon supprimé.';
    });
  }, 'specimen-remove');
  alphaValue.append(remove);
  panel.append(header, el('h4', 'Émergence'), date, recipeDetails, el('h4', 'Propriétés de l’image'), properties);
  card.append(mount, panel);

  let pinned = false;
  let closeTimer;
  const isOpen = () => panel.matches(':popover-open');
  function show() {
    if (!isOpen()) panel.showPopover({source: mount});
  }
  mount.addEventListener('click', event => {
    event.preventDefault();
    if (pinned && isOpen()) panel.hidePopover();
    else {
      pinned = true;
      show();
    }
  });
  panel.addEventListener('toggle', event => {
    if (event.newState === 'closed') {
      pinned = false;
      recipeDetails.open = false;
    }
  });
  mount.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(closeTimer);
    show();
  });
  for (const area of [mount, panel]) {
    area.addEventListener('pointerleave', event => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (isOpen() && !pinned && !panel.matches(':focus-within')) panel.hidePopover();
      }, 180);
    });
  }
  panel.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  return card;
}

function historyView() {
  $('history').replaceChildren(...history.map(specimen));
  if (!history.length) $('history').append(el('p', 'Pas encore de papillons.', 'hint'));
}

window.addEventListener('hashchange', route);
route();
run('Chargement de l’atelier…', async () => {
  await Promise.all([refreshLibrary(), (async () => {
    history = await (await api('/api/history')).json();
    historyView();
  })()]);
});
