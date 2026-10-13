import { APPS, APP_BY_ID, APP_CATEGORIES, supportsImageAppEditing } from './apps-workflows.js';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
const api = async (url, body) => {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
};

const ICONS = {
  sparkle: '<path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2Z"/><path d="m19 17 .6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6L19 17Z"/>',
  portrait: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/><path d="m19 3 .5 1.5L21 5l-1.5.5L19 7l-.5-1.5L17 5l1.5-.5L19 3Z"/>',
  hair: '<path d="M4 12a8 8 0 0 1 16 0v8h-3v-7c-1-1-2-3-2-4-2 3-5 5-11 5v6H2v-8"/><path d="M8 19c2 2 6 2 8 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14c1.5 2.5 6.5 2.5 8 0"/><path d="M8.5 10h.01M15.5 10h.01"/>',
  brush: '<path d="m14 5 5 5M4 20l5-1 11-11-4-4L5 15l-1 5Z"/><path d="M3 8h4M5 6v4"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path d="M8 8l-5-5m13 5 5-5M8 16l-5 5m13-5 5 5"/>',
  eraser: '<path d="m4 15 8-9a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-5 5H9l-5-5Z"/><path d="m9 10 8 8M3 21h18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  upscale: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path d="m9 15 6-6M9 9h6v6"/>',
  video: '<rect x="2.5" y="5" width="14" height="14" rx="3"/><path d="m16.5 10 5-3v10l-5-3"/>',
  swap: '<path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/>',
  scissors: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="m8 8 12 12M8 16 20 4"/>',
  audio: '<path d="M4 10v4h3l4 4V6l-4 4H4Z"/><path d="M15 9c2 2 2 4 0 6m3-9c4 3 4 9 0 12"/>',
  vector: '<path d="M4 20 12 4l8 16H4Z"/><circle cx="12" cy="4" r="2"/><circle cx="4" cy="20" r="2"/><circle cx="20" cy="20" r="2"/>',
  cutout: '<path d="M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3m0 8v3a1 1 0 0 1-1 1h-3m-8 0H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="10" r="2.5"/><path d="M7.5 17a4.5 4.5 0 0 1 9 0"/>'
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.sparkle}</svg>`;
function appIconTile(app) {
  const tile = el('span', 'app-icon-tile');
  tile.style.setProperty('--tile-from', app.gradient[0]);
  tile.style.setProperty('--tile-to', app.gradient[1]);
  tile.innerHTML = icon(app.icon);
  tile.setAttribute('aria-hidden', 'true');
  return tile;
}
const mediaUrl = (item, download = false) => `/media/${encodeURIComponent(item.file)}?f=${encodeURIComponent(item.folder || '')}${download ? '&dl=1' : ''}`;
const folderOf = (app) => `Apps/${app.title}`;
const clock = (seconds) => { const s = Math.max(0, Number(seconds) || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

let catalog;
let state;
let currentApp = null;
let currentFile = null;
let sourceUrl = '';
let inputId = '';
let sourceDuration = 0;
let uploading = false;
let runningJob = '';
let pollToken = 0;
let filter = 'All';
// Remove Background takes many images: [{ file, url, id, status, error }].
let batch = [];
const BATCH_UPLOADS = 3;
const isBatch = (app) => app?.input === 'images';
// Optional apps (justrmbg) are left out of the server's list where their tool is missing.
const listed = (app) => !!catalog?.apps?.some((entry) => entry.id === app.id);

function appReady(app) {
  if (app.engine === 'rmbg') return !!catalog.rmbg;
  if (app.engine === 'scene-video') return !!catalog.sceneRemix?.ready;
  if (app.engine === 'image') return !!catalog.recommendedImage;
  if (app.engine === 'video') return inputId ? state.videoModels.some((model) => model.hasKey && model.frames?.includes('first_frame')) : !!catalog.recommendedVideo;
  if (app.engine === 'vector') return catalog.vectorReady;
  return catalog.localReady;
}

function appStatus(app) {
  if (appReady(app)) return 'Ready';
  if (app.engine === 'scene-video') return 'Needs Seedance and FFmpeg';
  if (app.engine === 'rmbg') return 'Needs justrmbg';
  if (app.engine === 'local-image' || app.engine === 'local-video') return catalog.ffmpeg ? 'Local app' : 'Needs FFmpeg';
  return 'Add a key';
}

function renderFilters() {
  $('filters').replaceChildren(...APP_CATEGORIES.map((category) => {
    const button = el('button', category === filter ? 'on' : '', category);
    button.type = 'button'; button.setAttribute('aria-pressed', String(category === filter));
    button.onclick = () => { filter = category; renderFilters(); renderCatalog(); };
    return button;
  }));
}

function renderCatalog() {
  const q = $('appSearch').value.trim().toLowerCase();
  const found = APPS.filter((app) => listed(app) && (filter === 'All' || app.category === filter) && `${app.title} ${app.summary} ${app.category}`.toLowerCase().includes(q));
  $('appCount').textContent = `${found.length} ${found.length === 1 ? 'app' : 'apps'}`;
  $('emptySearch').classList.toggle('hide', found.length > 0);
  $('appGrid').replaceChildren(...found.map((app) => {
    const link = el('a', 'app-card'); link.href = `/apps/${app.id}`;
    link.setAttribute('aria-label', `${app.title}. ${app.summary} ${appStatus(app)}.`);
    link.innerHTML = `<span class="card-top"><span class="card-icon-slot"></span><span class="card-arrow" aria-hidden="true">↗</span></span><span class="card-text"><span class="card-title"></span><span class="card-summary"></span></span><span class="card-foot"><span class="status-dot ${appReady(app) ? '' : 'waiting'}"></span><span class="card-category"></span><span aria-hidden="true">·</span><span class="card-status"></span></span>`;
    link.querySelector('.card-icon-slot').replaceWith(appIconTile(app));
    link.querySelector('.card-title').textContent = app.title;
    link.querySelector('.card-summary').textContent = app.summary;
    link.querySelector('.card-category').textContent = app.category;
    link.querySelector('.card-status').textContent = appStatus(app);
    link.onclick = (event) => { if (app.id === 'video-remix' || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); openApp(app.id); };
    return link;
  }));
}

function field(label, control, hint = '') {
  const grouped = /class="(?:choice-row|check-list)"/.test(control);
  let labelled = control;
  let id = control.match(/<(?:input|textarea|select)\b[^>]*\bid="([^"]+)"/)?.[1];
  if (!grouped && !id) {
    id = `field-${control.match(/name="([^"]+)"/)?.[1] || 'input'}`;
    labelled = control.replace(/<(input|textarea|select)\b/, `<$1 id="${id}"`);
  }
  if (grouped) {
    id = `group-${control.match(/name="([^"]+)"/)?.[1] || 'changes'}`;
    labelled = labelled.replace(/aria-label="[^"]+"/, `aria-labelledby="${id}"`).replace('class="check-list"', `class="check-list" role="group" aria-labelledby="${id}"`);
  }
  return `<div class="field">${grouped ? `<div class="label" id="${id}">${label}</div>` : `<label for="${id}">${label}</label>`}${labelled}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}
function choice(name, options, selected) { return `<div class="choice-row" role="group" aria-label="${name}">${options.map(([value, label]) => `<label class="choice"><input type="radio" name="${name}" value="${value}" ${value === selected ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>`; }

function fieldsFor(app) {
  switch (app.id) {
    case 'skin-editor': return field('Finish', choice('finish', [['natural','Natural'],['studio','Studio'],['texture','Add texture']], 'natural'), 'Natural keeps pores and fine lines visible.') + field('How much?', choice('strength', [['subtle','Light'],['balanced','Balanced'],['strong','More']], 'balanced'));
    case 'retouch-portrait': return field('Choose changes', `<div class="check-list">${[['blemishes','Blemishes'],['shine','Shine'],['scars','Scars'],['freckles','Freckles'],['under-eyes','Under eyes'],['face-shape','Face shape'],['double-chin','Double chin']].map(([v,l],i)=>`<label class="check-item"><input type="checkbox" name="changes" value="${v}" ${i===0?'checked':''}>${l}</label>`).join('')}</div>`) + field('How much?', choice('strength', [['subtle','Light'],['balanced','Balanced'],['strong','More']], 'balanced'));
    case 'change-hair': return field('Hair color', '<input name="color" type="text" list="hairColors" placeholder="e.g. chestnut brown"><datalist id="hairColors"><option value="Chestnut brown"><option value="Copper red"><option value="Platinum blonde"><option value="Jet black"><option value="Silver"></datalist>') + field('Hair style', '<input name="style" type="text" list="hairStyles" placeholder="e.g. chin-length bob"><datalist id="hairStyles"><option value="Chin-length bob"><option value="Long waves"><option value="Pixie cut"><option value="Curly shoulder-length"><option value="Buzz cut"></datalist>', 'Fill either field, or use both.');
    case 'change-age': return field('Target age', '<div class="range-line"><input id="ageRange" name="age" type="range" min="5" max="90" value="35"><span id="ageValue" class="range-value">35</span></div>', 'The person and scene stay recognizable.');
    case 'change-expression': return field('Expression', choice('expression', [['smiling','Smile'],['laughing','Laugh'],['sad','Sad'],['angry','Angry'],['surprised','Surprised'],['neutral','Neutral']], 'smiling'));
    case 'image-editor': return field('What should change?', '<textarea name="prompt" placeholder="e.g. Change the jacket to olive green and keep everything else the same" required></textarea>', 'Say what to change. The source image guides the rest.');
    case 'expand-image': return field('New shape', choice('ratio', [['1:1','Square'],['4:3','Wide'],['3:4','Tall'],['16:9','Cinematic'],['9:16','Story']], '16:9')) + field('What fills the new space? <span style="color:var(--text-3);font-weight:600">Optional</span>', '<textarea name="prompt" placeholder="e.g. Continue the mountain range and evening sky"></textarea>', 'Leave blank to continue the scene naturally.');
    case 'remove-object': return field('What should go?', '<textarea name="prompt" placeholder="e.g. The lamp on the table" required></textarea>', 'Name the object, person, or area clearly.');
    case 'remove-light': return field('Fix the lighting', choice('issue', [['glare','Glare'],['shadows','Shadows'],['highlights','Bright spots'],['mixed','Uneven light']], 'glare'));
    case 'upscaler': return field('New size', choice('factor', [['2','2×'],['3','3×'],['4','4×']], '2')) + field('Finish', choice('detail', [['crisp','Crisp'],['soft','Soft']], 'crisp'), 'The image keeps its original content and gets more pixels.');
    case 'video-generator': return field('Describe the clip', '<textarea name="prompt" placeholder="e.g. A slow tracking shot past a rainy cafe window at dusk" required></textarea>', 'If you add an image, it becomes the opening frame.') + '<div class="field-row">' + field('Length', '<select name="duration" id="videoDuration"></select>') + field('Shape', '<select name="ratio" id="videoRatio"></select>') + '</div>';
    case 'video-trim': return '<div class="field-row">' + field('Start', '<input id="trimStart" name="start" type="number" min="0" step="0.1" value="0">') + field('End', '<input id="trimEnd" name="end" type="number" min="0.1" step="0.1" placeholder="Add video">') + '</div><div class="video-tools"><button type="button" id="useStart">Set start to playhead</button><button type="button" id="useEnd">Set end to playhead</button><span id="clipLength" class="hint"></span></div>';
    case 'ugc-audio-fixer': return field('Sound', choice('preset', [['speech','Clear speech'],['gentle','Keep ambience']], 'speech'), 'Clear speech reduces noise and levels voices. Keep ambience makes a lighter pass.');
    case 'remove-background': return '<p class="hint" style="margin:0">Each image becomes a PNG with a transparent background. The originals are not changed.</p>';
    case 'vectorize': return field('What should we draw?', '<textarea name="prompt" placeholder="e.g. A red fox curled up under a pine tree, simple flat shapes" required></textarea>', 'Simple subjects and a short color palette make the cleanest SVG.');
    default: return '';
  }
}

function selectedModel() {
  const option = $('modelSelect').selectedOptions[0];
  return option?.dataset.model ? { api: option.dataset.api, model: option.dataset.model } : {};
}
function videoModel() {
  const picked = selectedModel();
  if (picked.model) return state.videoModels.find((model) => model.id === picked.model && (model.api || 'openrouter') === picked.api);
  const candidates = inputId ? state.videoModels.filter((model) => model.hasKey && model.frames?.includes('first_frame')) : state.videoModels;
  return candidates.find((model) => model.id === catalog.recommendedVideo?.model && (model.api || 'openrouter') === catalog.recommendedVideo?.api) || candidates[0];
}

function renderVideoOptions() {
  if (currentApp?.id !== 'video-generator') return;
  const model = videoModel();
  const durations = model?.durations?.length ? model.durations : [4, 6, 8];
  const ratios = model?.aspectRatios?.length ? model.aspectRatios : ['16:9','9:16','1:1'];
  const duration = $('videoDuration'); const ratio = $('videoRatio');
  const oldDuration = duration.value; const oldRatio = ratio.value;
  duration.replaceChildren(...durations.map((s) => { const o = el('option', '', `${s} seconds`); o.value = s; return o; }));
  ratio.replaceChildren(...ratios.map((s) => { const o = el('option', '', s); o.value = s; return o; }));
  if (durations.map(String).includes(oldDuration)) duration.value = oldDuration;
  if (ratios.includes(oldRatio)) ratio.value = oldRatio;
}

function renderModels(app) {
  const select = $('modelSelect'); select.replaceChildren();
  const frameModels = inputId && app.engine === 'video' ? state.videoModels.filter((model) => model.hasKey && model.frames?.includes('first_frame')) : null;
  const suggested = app.engine === 'image' ? catalog.recommendedImage : frameModels
    ? frameModels.find((model) => model.id === catalog.recommendedVideo?.model && (model.api || 'openrouter') === catalog.recommendedVideo?.api) || frameModels[0]
    : catalog.recommendedVideo;
  const first = el('option', '', suggested ? `Recommended · ${suggested.name}` : 'Recommended'); first.value = ''; select.append(first);
  const list = app.engine === 'image'
    ? state.apis.flatMap((api) => api.hasKey ? api.models.filter(supportsImageAppEditing).map((model) => ({ ...model, api: api.id, provider: api.name })) : [])
    : app.engine === 'video' ? state.videoModels.filter((model) => model.hasKey && (!inputId || model.frames?.includes('first_frame'))).map((model) => ({ ...model, provider: model.api || 'openrouter' })) : [];
  for (const model of list) {
    const option = el('option', '', `${model.name || model.id} · ${model.provider}`);
    option.value = `${model.api}::${model.id}`; option.dataset.api = model.api; option.dataset.model = model.id; select.append(option);
  }
  select.onchange = () => { $('modelHint').textContent = selectedModel().model ? 'This model will run the workflow with your settings.' : 'The app picks a suitable model with a configured key.'; renderVideoOptions(); };
  $('modelHint').textContent = app.engine === 'vector' ? `Text model: ${catalog.vectorModel}` : 'The app picks a suitable model with a configured key.';
  $('modelSection').classList.remove('hide');
  $('modelSection').querySelector('.field').classList.toggle('hide', app.engine !== 'image' && app.engine !== 'video');
  $('engineStep').textContent = app.input === 'none' ? '2' : '3';
  $('engineTitle').textContent = app.engine === 'local-image' || app.engine === 'local-video' || app.engine === 'rmbg' ? 'Processing' : 'Model';
  renderVideoOptions();
}

function renderReadiness(app) {
  const note = $('readiness');
  note.classList.toggle('warn', !appReady(app));
  if (appReady(app) && app.engine === 'rmbg') {
    const where = catalog.rmbg.container ? 'this server' : 'this computer';
    note.textContent = `Runs on ${where} with BRIA RMBG-2.0${catalog.rmbg.provider === 'CPU' ? ' on the CPU' : ''}. Your images stay in JustImagine.${catalog.rmbg.warm ? '' : ' The first batch takes a little longer while the model loads.'}`;
  } else if (appReady(app)) {
    note.textContent = app.engine === 'local-image' || app.engine === 'local-video' ? 'Processes on this computer. Your source stays in JustImagine.' : app.engine === 'vector' ? 'Ready to draw an editable SVG.' : 'Ready with a connected model.';
  } else if (app.engine === 'local-image' || app.engine === 'local-video') {
    note.textContent = !catalog.ffmpeg ? 'FFmpeg is required for this app. Install it and restart JustImagine.' : 'This local processing app is available in standalone JustImagine.';
  } else {
    note.replaceChildren(document.createTextNode(app.engine === 'video' && inputId ? 'Add a key for an image-to-video model in ' : 'Add a provider key in '));
    const link = el('a', '', 'Gallery Settings'); link.href = '/?settings=1'; note.append(link, document.createTextNode(' to use this app.'));
  }
  const pending = isBatch(app) && batch.some((entry) => entry.status === 'uploading' || entry.status === 'waiting');
  $('runApp').disabled = !appReady(app) || uploading || pending || !!runningJob;
  if (isBatch(app) && !runningJob) $('runApp').textContent = runLabel(app);
}

function runLabel(app) {
  if (!isBatch(app)) return { 'video-trim':'Trim video', 'ugc-audio-fixer':'Fix audio', 'upscaler':'Upscale image', 'video-generator':'Make video', 'vectorize':'Make vector' }[app.id] || 'Make image';
  const ready = batch.filter((entry) => entry.status === 'ready').length;
  return ready > 1 ? `Remove ${ready} backgrounds` : 'Remove background';
}

function clearSource() {
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  for (const entry of batch) URL.revokeObjectURL(entry.url);
  batch = [];
  sourceUrl = ''; currentFile = null; inputId = ''; sourceDuration = 0; uploading = false;
  $('sourceDrop').classList.remove('hide'); $('batchList').replaceChildren(); $('batchList').classList.add('hide');
  $('replaceSource').textContent = 'Replace'; $('removeSource').textContent = 'Remove';
  $('sourceFile').value = ''; $('sourcePreview').replaceChildren();
  $('sourcePreview').classList.add('hide'); $('sourceEmpty').classList.remove('hide'); $('sourceActions').classList.add('hide'); $('uploadStatus').textContent = '';
}

function openApp(id, push = true) {
  const app = APP_BY_ID[id]; if (!app || !listed(app)) return showCatalog(push);
  pollToken++;
  currentApp = app; runningJob = '';
  clearSource();
  $('catalog').classList.add('hide'); $('workflow').classList.remove('hide');
  $('crumbTitle').textContent = app.title;
  $('workflowTitle').textContent = app.title;
  $('workflowSummary').textContent = app.summary;
  const tile = appIconTile(app);
  tile.id = 'workflowIcon';
  $('workflowIcon').replaceWith(tile);
  $('appFields').innerHTML = fieldsFor(app);
  $('appFields').querySelectorAll('.field').forEach((field, index) => {
    const label = field.querySelector(':scope > label');
    const control = field.querySelector('input:not([type=radio]):not([type=checkbox]),textarea,select');
    if (label && control) { if (!control.id) control.id = `appField${index}`; label.htmlFor = control.id; }
  });
  const hasSource = app.input !== 'none';
  $('sourceSection').classList.toggle('hide', !hasSource);
  $('optionsStep').textContent = hasSource ? '2' : '1';
  $('sourceTitle').textContent = app.input === 'video' ? 'Add your video' : app.input === 'optional-image' ? 'Add an opening image (optional)' : isBatch(app) ? 'Add your images' : 'Add your image';
  $('dropTitle').textContent = app.input === 'video' ? 'Drop a video here' : isBatch(app) ? 'Drop images here' : 'Drop an image here';
  $('dropHint').textContent = app.input === 'video' ? 'MP4 or WebM works best.' : isBatch(app) ? `Paste, drag, or choose up to ${catalog.rmbg?.maxImages || 200} PNG, JPEG, or WebP files.` : 'Paste, drag, or choose a file.';
  $('sourceFile').multiple = isBatch(app);
  $('sourceFile').accept = app.input === 'video' ? 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov' : 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
  $('setupHint').textContent = app.engine === 'local-video' || app.engine === 'local-image' ? 'Runs on this computer' : app.engine === 'rmbg' ? (catalog.rmbg?.container ? 'Runs on this server' : 'Runs on this computer') : 'A model is picked for you';
  $('runApp').textContent = runLabel(app);
  $('formError').textContent = '';
  renderModels(app); renderReadiness(app); renderPlaceholder(); loadRecent(app);
  if (app.id === 'change-age') $('ageRange').oninput = () => { $('ageValue').textContent = $('ageRange').value; };
  if (app.id === 'video-trim') wireTrim();
  document.title = `${app.title} · JustImagine`;
  if (push) history.pushState({}, '', `/apps/${app.id}`);
  window.scrollTo({ top: 0, behavior: 'instant' });
  const saved = sessionStorage.getItem(`justimagine:app-job:${app.id}`);
  if (saved) { runningJob = saved; pollJob(saved, ++pollToken); }
}

function showCatalog(push = true) {
  pollToken++; currentApp = null; runningJob = ''; clearSource();
  $('workflow').classList.add('hide'); $('catalog').classList.remove('hide');
  document.title = 'Apps · JustImagine';
  if (push) history.pushState({}, '', '/apps');
  renderCatalog(); window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderPlaceholder(message = 'Set up the app on the left, then make your first result.') {
  $('resultStage').replaceChildren();
  const holder = el('div', 'placeholder');
  holder.innerHTML = '<div class="placeholder-mark" aria-hidden="true">✦</div><strong>Your result goes here</strong><p></p>';
  holder.querySelector('p').textContent = message;
  $('resultStage').append(holder);
  $('resultActions').replaceChildren(); $('resultActions').classList.add('hide');
  $('resultStatus').textContent = 'Ready when you are';
}

function error(message) { $('formError').textContent = message; $('formError').scrollIntoView({ block: 'nearest' }); }

async function uploadFile(file) {
  const app = currentApp;
  if (!app) return;
  const isVideo = app.input === 'video';
  const valid = isVideo ? /^video\/(mp4|webm|quicktime)$/.test(file.type) || /\.(mp4|webm|mov)$/i.test(file.name) : /^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
  if (!valid) return error(isVideo ? 'Choose an MP4, WebM, or MOV video.' : 'Choose a PNG, JPEG, or WebP image.');
  if (!file.size) return error('That file is empty. Choose another.');
  if (!isVideo && file.size > 32 * 1024 * 1024) return error('Use an image under 32 MB.');
  if (file.size > 2 * 1024 ** 3) return error('Use a file under 2 GB.');
  clearSource();
  currentFile = file; sourceUrl = URL.createObjectURL(file); uploading = true;
  $('formError').textContent = ''; $('sourceName').textContent = file.name;
  $('sourceEmpty').classList.add('hide'); $('sourcePreview').classList.remove('hide'); $('sourceActions').classList.remove('hide');
  const preview = el(isVideo ? 'video' : 'img'); preview.src = sourceUrl;
  if (isVideo) { preview.controls = true; preview.preload = 'metadata'; preview.onloadedmetadata = () => { sourceDuration = preview.duration; if ($('trimEnd')) { $('trimEnd').value = preview.duration.toFixed(1); updateTrim(); } }; }
  else preview.alt = `Source: ${file.name}`;
  $('sourcePreview').append(preview); $('uploadStatus').textContent = 'Uploading…';
  renderReadiness(app);
  try {
    const { id } = await api('/api/media', { folder: '', name: file.name, size: file.size, temporary: true });
    const piece = 4 * 1024 * 1024;
    for (let at = 0; at < file.size; at += piece) {
      const part = file.slice(at, at + piece);
      const response = await fetch(`/api/media/chunk?id=${encodeURIComponent(id)}&offset=${at}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: part });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || 'Upload stopped. Try again.');
      $('uploadStatus').textContent = `Uploading… ${Math.round(100 * (at + part.size) / file.size)}%`;
    }
    const done = await api('/api/media/done', { id });
    if (currentApp !== app || currentFile !== file) return;
    inputId = done.input.id;
    $('uploadStatus').textContent = 'Ready to use';
    if (app.engine === 'video') renderModels(app);
  } catch (e) { if (currentApp === app && currentFile === file) error(e.message); $('uploadStatus').textContent = 'Upload failed'; }
  finally { if (currentApp === app && currentFile === file) { uploading = false; renderReadiness(app); } }
}

function isImageFile(file) { return /^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name); }

function addBatchFiles(files) {
  const app = currentApp;
  if (!app || runningJob) return;
  const max = catalog.rmbg?.maxImages || 200;
  const images = files.filter(isImageFile);
  const fits = images.filter((file) => file.size && file.size <= 32 * 1024 * 1024);
  const room = Math.max(0, max - batch.length);
  const notes = [];
  if (files.length > images.length) notes.push(`${files.length - images.length} not a PNG, JPEG, or WebP image`);
  if (images.length > fits.length) notes.push(`${images.length - fits.length} empty or over 32 MB`);
  if (fits.length > room) notes.push(`${fits.length - room} over the ${max}-image limit`);
  $('formError').textContent = '';
  if (notes.length) error(`Skipped ${notes.join('; ')}.`);
  for (const file of fits.slice(0, room)) batch.push({ file, url: URL.createObjectURL(file), id: '', status: 'waiting', error: '' });
  renderBatch(); pumpUploads(app);
}

// A few uploads at a time: the server holds at most 20 open uploads.
function pumpUploads(app) {
  while (currentApp === app && batch.filter((entry) => entry.status === 'uploading').length < BATCH_UPLOADS) {
    const entry = batch.find((item) => item.status === 'waiting');
    if (!entry) break;
    entry.status = 'uploading';
    uploadTemporary(entry.file, entry.file.name)
      .then((id) => { entry.id = id; entry.status = 'ready'; })
      .catch((e) => { entry.status = 'error'; entry.error = e.message; })
      .finally(() => { if (currentApp === app && batch.includes(entry)) { renderBatch(); pumpUploads(app); } });
  }
  if (currentApp === app) { renderBatch(); renderReadiness(app); }
}

function renderBatch() {
  const list = $('batchList');
  const has = batch.length > 0;
  list.classList.toggle('hide', !has);
  $('sourceDrop').classList.toggle('hide', has);
  $('sourceActions').classList.toggle('hide', !has);
  if (!has) { $('uploadStatus').textContent = ''; return; }
  list.replaceChildren(...batch.map((entry) => {
    const tile = el('div', `batch-tile ${entry.status}`);
    const img = el('img'); img.src = entry.url; img.alt = entry.file.name; img.loading = 'lazy';
    const remove = el('button', 'batch-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${entry.file.name}`);
    remove.disabled = entry.status === 'uploading' || !!runningJob;
    remove.onclick = () => { URL.revokeObjectURL(entry.url); batch = batch.filter((item) => item !== entry); renderBatch(); renderReadiness(currentApp); };
    tile.title = entry.error || entry.file.name;
    tile.append(img, remove);
    if (entry.status !== 'ready') tile.append(el('span', 'batch-state', entry.status === 'error' ? 'Failed' : entry.status === 'uploading' ? 'Uploading' : 'Waiting'));
    return tile;
  }));
  const ready = batch.filter((entry) => entry.status === 'ready').length;
  const failed = batch.filter((entry) => entry.status === 'error').length;
  $('sourceName').textContent = `${batch.length} ${batch.length === 1 ? 'image' : 'images'}`;
  $('uploadStatus').textContent = ready + failed < batch.length ? `Uploading… ${ready} of ${batch.length} ready` : failed ? `${ready} ready · ${failed} could not upload (hover a tile for why)` : 'Ready to use';
  $('replaceSource').textContent = 'Add more'; $('removeSource').textContent = 'Clear all';
  $('replaceSource').disabled = $('removeSource').disabled = !!runningJob;
}

async function uploadTemporary(blob, name) {
  const { id } = await api('/api/media', { folder: '', name, size: blob.size, temporary: true });
  const piece = 4 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += piece) {
    const part = blob.slice(at, at + piece);
    const response = await fetch(`/api/media/chunk?id=${encodeURIComponent(id)}&offset=${at}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: part });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || 'Could not upload the prepared image.');
  }
  return (await api('/api/media/done', { id })).input.id;
}

async function expansionInput(file, ratio) {
  const [rw, rh] = String(ratio || '16:9').split(':').map(Number);
  if (!(rw > 0 && rh > 0)) throw new Error('Choose a new shape.');
  const bitmap = await createImageBitmap(file);
  try {
    const wanted = rw / rh;
    let width = bitmap.width, height = bitmap.height;
    if (width / height < wanted) width = Math.ceil(height * wanted);
    else height = Math.ceil(width / wanted);
    if (Math.abs(width / height - bitmap.width / bitmap.height) < .002) return inputId;
    const scale = Math.min(1, 3200 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, Math.round((width - bitmap.width) * scale / 2), Math.round((height - bitmap.height) * scale / 2), Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob || blob.size > 32 * 1024 * 1024) throw new Error('The expanded canvas is too large. Try a smaller source image.');
    return await uploadTemporary(blob, 'expanded-canvas.png');
  } finally { bitmap.close(); }
}

function wireTrim() {
  const update = () => updateTrim();
  $('trimStart').oninput = update; $('trimEnd').oninput = update;
  $('useStart').onclick = () => { $('trimStart').value = $('sourcePreview').querySelector('video')?.currentTime.toFixed(1) || '0'; updateTrim(); };
  $('useEnd').onclick = () => { $('trimEnd').value = $('sourcePreview').querySelector('video')?.currentTime.toFixed(1) || '0'; updateTrim(); };
}
function updateTrim() {
  if (!$('clipLength')) return;
  const start = Number($('trimStart').value); const end = Number($('trimEnd').value);
  $('clipLength').textContent = end > start ? `Selected: ${clock(end - start)}` : 'Choose a range';
}

function valuesFor(app) {
  const data = new FormData($('appForm'));
  const values = Object.fromEntries(data.entries());
  if (app.id === 'retouch-portrait') values.changes = data.getAll('changes');
  if (app.id === 'vectorize') values.prompt = String(values.prompt || '').trim();
  return values;
}

function validate(app, values) {
  if (isBatch(app) && !batch.some((entry) => entry.status === 'ready')) throw new Error('Add at least one image first.');
  if (app.input === 'image' || app.input === 'video') { if (!inputId) throw new Error(`Add ${app.input === 'video' ? 'a video' : 'an image'} first.`); }
  if (app.id === 'retouch-portrait' && !values.changes.length) throw new Error('Choose at least one portrait change.');
  if (app.id === 'change-hair' && !String(values.color || '').trim() && !String(values.style || '').trim()) throw new Error('Choose a hair color, style, or both.');
  if (['image-editor','remove-object','video-generator','vectorize'].includes(app.id) && !String(values.prompt || '').trim()) throw new Error('Write a short description first.');
  if (app.id === 'video-trim') {
    const start = Number(values.start), end = Number(values.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || (sourceDuration && end > sourceDuration + .1)) throw new Error('Choose a start and end time inside the clip.');
  }
}

function cutoutGrid(items) {
  const grid = el('div', 'cutout-grid');
  grid.append(...items.map((item) => {
    const name = item.prompt?.replace(/^Remove background · /, '') || item.file;
    const link = el('a', 'cutout'); link.href = mediaUrl(item, true); link.download = item.file; link.title = `Download ${name}`;
    const img = el('img'); img.src = mediaUrl(item); img.alt = `${name} without its background`; img.loading = 'lazy';
    link.append(img); return link;
  }));
  return grid;
}

function renderBatchProgress(job) {
  const done = job.progress?.done || 0, total = job.progress?.total || 0;
  const loading = job.phase === 'preparing' && !done;
  $('resultStatus').textContent = total ? `${done} of ${total}` : 'Working';
  const wrap = el('div', 'batch-progress');
  const head = el('div', 'batch-head');
  const text = el('div');
  text.append(el('strong', '', job.phase === 'queued' ? 'Waiting for a free slot…' : loading ? 'Loading the background remover…' : `Removing backgrounds · ${done} of ${total}`));
  text.append(el('p', '', loading ? 'The very first run downloads the model, which can take a few minutes. You can leave this page and come back.' : 'Each cutout is saved to the gallery as it finishes.'));
  const stop = el('button', '', 'Stop'); stop.type = 'button'; stop.onclick = stopJob;
  head.append(text, stop);
  const bar = el('div', 'batch-bar'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(total)); bar.setAttribute('aria-valuenow', String(done));
  const fill = el('span'); fill.style.width = `${total ? Math.round(100 * done / total) : 0}%`; bar.append(fill);
  wrap.append(head, bar);
  if (job.items?.length) wrap.append(cutoutGrid(job.items));
  $('resultStage').replaceChildren(wrap);
}

async function stopJob() {
  await api('/api/cancel', { id: runningJob }); sessionStorage.removeItem(`justimagine:app-job:${currentApp.id}`); runningJob = ''; renderPlaceholder('Job stopped. Your setup is still here if you want to try again.'); renderReadiness(currentApp);
  if (isBatch(currentApp)) renderBatch();
}

function showBatchResult(job) {
  const items = job.items || (job.item ? [job.item] : []);
  const failures = job.failures || [];
  $('resultStatus').textContent = `${items.length} saved to gallery`;
  const wrap = el('div', 'batch-progress');
  if (failures.length) {
    const note = el('div', 'batch-failures');
    note.append(el('strong', '', `${failures.length} ${failures.length === 1 ? 'image was' : 'images were'} skipped`));
    const list = el('ul'); list.append(...failures.slice(0, 8).map((f) => el('li', '', `${f.name}: ${f.error}`)));
    if (failures.length > 8) list.append(el('li', '', `…and ${failures.length - 8} more`));
    note.append(list); wrap.append(note);
  }
  wrap.append(cutoutGrid(items));
  $('resultStage').replaceChildren(wrap);
  const actions = $('resultActions'); actions.replaceChildren(); actions.classList.remove('hide');
  if (items.length > 1) { const zip = el('a', 'primary', `Download all (${items.length})`); zip.href = `/api/apps/remove-background/zip?job=${encodeURIComponent(job.id)}`; zip.download = 'background-removed.zip'; actions.append(zip); }
  else if (items[0]) { const one = el('a', 'primary', 'Download'); one.href = mediaUrl(items[0], true); one.download = items[0].file; actions.append(one); }
  const gallery = el('a', '', 'Open in gallery'); gallery.href = `/?folder=${encodeURIComponent(items[0]?.folder || folderOf(currentApp))}`;
  const again = el('button', '', 'Start a new batch'); again.type = 'button'; again.onclick = () => { clearSource(); renderPlaceholder(); renderReadiness(currentApp); $('appForm').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  actions.append(gallery, again);
}

function renderProgress(job) {
  if (isBatch(currentApp)) return renderBatchProgress(job);
  $('resultStatus').textContent = 'Working';
  $('resultStage').innerHTML = '<div class="progress-wrap"><div class="spinner" aria-hidden="true"></div><strong>Making your result</strong><p id="jobPhase"></p><button type="button" id="stopJob">Stop this job</button></div>';
  $('jobPhase').textContent = job.phase === 'queued' ? 'Waiting for a free slot…' : job.phase === 'processing' ? 'Processing the file…' : job.phase === 'drawing' ? 'Drawing the vector…' : 'The model is working. You can leave this page and come back.';
  $('stopJob').onclick = stopJob;
}

function showResult(item, fromRecent = false) {
  if (!item) return;
  const stage = $('resultStage'); stage.replaceChildren();
  $('resultStatus').textContent = 'Saved to gallery';
  const url = mediaUrl(item);
  const vector = item.file.toLowerCase().endsWith('.svg');
  if (item.kind === 'video') {
    const video = el('video', 'result-media'); video.controls = true; video.preload = 'metadata'; video.src = url; stage.append(video);
  } else if (!fromRecent && sourceUrl && !vector && currentApp?.input === 'image') {
    const wrap = el('div', 'compare'); wrap.style.setProperty('--split', '50%');
    const after = el('img'); after.src = url; after.alt = 'Result';
    const before = el('img', 'before'); before.src = sourceUrl; before.alt = 'Original';
    const range = el('input'); range.type = 'range'; range.min = 0; range.max = 100; range.value = 50; range.setAttribute('aria-label', 'Compare before and after');
    range.oninput = () => wrap.style.setProperty('--split', `${range.value}%`);
    wrap.append(after, before, el('div','divider'), el('div','handle','↔'), el('span','compare-label left','Before'), el('span','compare-label right','After'), range); stage.append(wrap);
  } else {
    const img = el('img', 'result-media'); img.src = url; img.alt = item.prompt || 'Result'; stage.append(img);
  }
  const actions = $('resultActions'); actions.replaceChildren(); actions.classList.remove('hide');
  const download = el('a', 'primary', vector ? 'Download SVG' : 'Download'); download.href = mediaUrl(item, true); download.download = item.file;
  const gallery = el('a', '', 'Open in gallery'); gallery.href = `/?folder=${encodeURIComponent(item.folder || '')}`;
  const again = el('button', '', 'Make another'); again.type = 'button'; again.onclick = () => { $('appForm').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('appFields').querySelector('textarea,input,select')?.focus({ preventScroll: true }); };
  actions.append(download, gallery, again);
}

async function pollJob(id, token) {
  renderProgress({ phase: 'queued' });
  while (token === pollToken && currentApp && runningJob === id) {
    try {
      const data = await api(`/api/jobs?ids=${encodeURIComponent(id)}&wait=${isBatch(currentApp) ? 2 : 5}`);
      if (token !== pollToken) return;
      const job = data.results?.[0];
      if (!job || data.missing?.length) throw new Error('That job is no longer available. Check the gallery for its result.');
      if (job.status === 'done') { sessionStorage.removeItem(`justimagine:app-job:${currentApp.id}`); runningJob = ''; if (isBatch(currentApp)) { showBatchResult(job); renderBatch(); } else showResult(job.item); loadRecent(currentApp); renderReadiness(currentApp); return; }
      if (job.status === 'error') throw new Error(job.error || 'The job failed.');
      if (job.status === 'cancelled') { sessionStorage.removeItem(`justimagine:app-job:${currentApp.id}`); runningJob = ''; if (job.items?.length) showBatchResult(job); else renderPlaceholder('Job stopped. Your setup is still here.'); renderReadiness(currentApp); return; }
      renderProgress(job);
    } catch (e) {
      if (token !== pollToken) return;
      sessionStorage.removeItem(`justimagine:app-job:${currentApp.id}`); runningJob = '';
      $('resultStatus').textContent = 'Could not finish';
      renderPlaceholder(e.message); $('resultStatus').textContent = 'Could not finish'; renderReadiness(currentApp); return;
    }
  }
}

async function loadRecent(app) {
  try {
    const data = await api(`/api/items?folder=${encodeURIComponent(folderOf(app))}&limit=8`);
    if (currentApp !== app) return;
    $('recent').classList.toggle('hide', !data.items?.length);
    $('recentList').replaceChildren(...(data.items || []).map((item) => {
      const button = el('button', 'recent-item'); button.type = 'button'; button.title = item.prompt || item.file;
      if (item.kind === 'video') { const vid = el('video'); vid.src = mediaUrl(item); vid.preload = 'metadata'; button.append(vid); }
      else { const img = el('img'); img.src = mediaUrl(item); img.alt = item.prompt || item.file; img.loading = 'lazy'; button.append(img); }
      button.onclick = () => showResult(item, true);
      return button;
    }));
  } catch { $('recent').classList.add('hide'); }
}

async function boot() {
  try { [catalog, state] = await Promise.all([api('/api/apps'), api('/api/state')]); }
  catch (e) { $('appGrid').replaceChildren(el('div', 'empty-search', `Could not load Apps: ${e.message}`)); return; }
  renderFilters(); renderCatalog();
  $('appSearch').oninput = renderCatalog;
  $('backApps').onclick = () => showCatalog();
  $('sourceFile').onchange = (e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (isBatch(currentApp)) addBatchFiles(files); else if (files[0]) uploadFile(files[0]); };
  $('chooseSource').onclick = () => $('sourceFile').click();
  $('replaceSource').onclick = () => $('sourceFile').click();
  $('removeSource').onclick = () => { const app = currentApp; if (runningJob && isBatch(app)) return; clearSource(); if (app?.engine === 'video') renderModels(app); if (app) renderReadiness(app); };
  $('sourceDrop').onclick = (e) => { if (e.target.closest('button,.source-preview')) return; $('sourceFile').click(); };
  $('sourceDrop').ondragover = (e) => { e.preventDefault(); $('sourceDrop').classList.add('dragging'); };
  $('sourceDrop').ondragleave = () => $('sourceDrop').classList.remove('dragging');
  $('sourceDrop').ondrop = (e) => { e.preventDefault(); $('sourceDrop').classList.remove('dragging'); const files = [...(e.dataTransfer.files || [])]; if (isBatch(currentApp)) addBatchFiles(files); else if (files[0]) uploadFile(files[0]); };
  // A batch keeps taking images after the first ones: drop more onto its list.
  $('batchList').ondragover = (e) => { if (isBatch(currentApp)) { e.preventDefault(); $('batchList').classList.add('dragging'); } };
  $('batchList').ondragleave = () => $('batchList').classList.remove('dragging');
  $('batchList').ondrop = (e) => { e.preventDefault(); $('batchList').classList.remove('dragging'); if (isBatch(currentApp)) addBatchFiles([...(e.dataTransfer.files || [])]); };
  document.onpaste = (e) => { if (!currentApp || currentApp.input === 'video' || currentApp.input === 'none' || ['TEXTAREA','INPUT'].includes(document.activeElement?.tagName)) return; const images = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/')); if (!images.length) return; e.preventDefault(); if (isBatch(currentApp)) addBatchFiles(images); else uploadFile(images[0]); };
  $('appForm').onsubmit = async (e) => {
    e.preventDefault(); if (!currentApp || uploading || runningJob) return;
    $('formError').textContent = '';
    const app = currentApp; const values = valuesFor(app); const file = currentFile;
    try {
      validate(app, values);
      $('runApp').disabled = true; $('runApp').textContent = 'Starting…';
      const preparedInput = app.id === 'expand-image' ? await expansionInput(currentFile, values.ratio) : inputId;
      if (currentApp !== app || currentFile !== file) return;
      const request = isBatch(app)
        ? { app: app.id, values, inputs: batch.filter((entry) => entry.status === 'ready').map((entry) => entry.id) }
        : { app: app.id, values, input: preparedInput || undefined, ...selectedModel() };
      const response = await api('/api/apps/run', request);
      if (currentApp !== app) { if (response.jobs?.[0]) sessionStorage.setItem(`justimagine:app-job:${app.id}`, response.jobs[0]); return; }
      runningJob = response.jobs?.[0];
      if (!runningJob) throw new Error('The app did not return a job.');
      sessionStorage.setItem(`justimagine:app-job:${app.id}`, runningJob);
      pollJob(runningJob, ++pollToken);
      $('resultStage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (cause) { error(cause.message); }
    finally { if (currentApp === app) { $('runApp').disabled = !appReady(app) || !!runningJob; $('runApp').textContent = runLabel(app); if (isBatch(app)) renderBatch(); } }
  };
  // The theme is Just Superhuman's (shell.js), shared with every app.
  const isDark = () => window.SH ? SH.isDark() : document.documentElement.dataset.theme === 'dark';
  const paintTheme = () => {
    $('themeBtn').setAttribute('aria-pressed', String(isDark()));
    $('themeBtn').setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  };
  $('themeBtn').onclick = () => {
    const dark = !isDark();
    if (window.SH) SH.setTheme(dark ? 'dark' : 'light'); else document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    paintTheme();
  };
  paintTheme();
  document.addEventListener('sh:theme', paintTheme);
  const route = location.pathname.match(/^\/apps\/([a-z0-9-]+)$/)?.[1];
  if (route && APP_BY_ID[route] && listed(APP_BY_ID[route])) openApp(route, false);
  else showCatalog(false);
  window.onpopstate = () => { const id = location.pathname.match(/^\/apps\/([a-z0-9-]+)$/)?.[1]; if (id && APP_BY_ID[id] && listed(APP_BY_ID[id])) openApp(id, false); else showCatalog(false); };
}

boot();
