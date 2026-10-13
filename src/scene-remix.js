import { canPrepareScene, prepareSceneClip } from './scene-remix-editor.js';
import { demoGuideKey, loadDemoGuide, saveDemoDescription, saveDemoGuide } from './scene-remix-cache.js';
import { DEFAULT_FACE_GRID, gridFaceFile, normalizeFaceGridSettings } from './scene-remix-face-grid.js';

const $ = (id) => document.getElementById(id);
const api = async (url, body) => {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
};
const mediaUrl = (item, download = false) => `/media/${encodeURIComponent(item.file)}?f=${encodeURIComponent(item.folder || '')}${download ? '&dl=1' : ''}`;
const errorText = (id, message) => { $(id).textContent = message || ''; $(id).classList.toggle('hide', !message); };
function remixErrorMessage(message) {
  if (/supply_unavailable/.test(message)) return 'OpenLux has no Seedance 2.5 capacity right now. Try another connected model or retry later.';
  if (/input video .*may contain real person/i.test(message)) return 'The model flagged the source clip as possible real-person footage. Prepare a guide that fully covers the people, then try again.';
  if (/InputAudioSensitiveContentDetected/.test(message)) return 'The model found audio in the video reference. Download and host the silent reference, then try again.';
  if (/InputImageSensitiveContentDetected/.test(message)) return 'The video model rejected a portrait. Try a fictional demo face or another image.';
  if (/input image[\s\S]*copyright restrictions/i.test(message)) return 'The model flagged the portrait images under its copyright checks. Full depth changes only the video guide. Try fictional portraits.';
  if (/input video[\s\S]*copyright restrictions/i.test(message)) return 'The model flagged the video reference under its copyright checks. Try a different clip.';
  if (/copyright restrictions/i.test(message)) return 'The model flagged this request under its copyright checks. Try different portraits or a different clip.';
  return message;
}
let catalog, source, character, character2, sourceUrl, characterUrl, character2Url, characterRawUrl, character2RawUrl, prepared, preparedUrl, preparedInput, characterInput, character2Input, aspectRatio = '16:9';
let sourceSeconds = 0, busy = false, running = false, demoLoading = false, draftItem = null, abort = null;
let storage = null, hostedUrl = '', hostedUntil = 0;
let demoVersion = '', sceneEpoch = 0, sceneEdited = false, autoSceneValue = '';
let faceGridSettings = { ...DEFAULT_FACE_GRID }, faceGridRenderTimer = null;
const FACE_GRID_STORAGE_KEY = 'justimagine:scene-remix:face-grid';
const FACE_GRID_FIELDS = ['columns', 'rows', 'lineWidth', 'opacity', 'offsetX', 'offsetY', 'mosaicSize', 'squiggleAmount'];
const randomFaceSeed = () => globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 2 ** 32);
const faceGridSeeds = { left: randomFaceSeed(), right: randomFaceSeed() };
const FACE_PRESETS = [
  { id: 'studio-left', name: 'Studio face 1', kind: 'Fictional', file: 'left-face-illustrated.png', type: 'image/png' },
  { id: 'studio-right', name: 'Studio face 2', kind: 'Fictional', file: 'right-face-illustrated.png', type: 'image/png' },
  { id: 'elon-musk', name: 'Elon Musk', kind: 'Photo', file: 'elon-musk.jpg', type: 'image/jpeg' },
  { id: 'will-smith', name: 'Will Smith', kind: 'Photo', file: 'will-smith.jpg', type: 'image/jpeg' }
];
const selectedFaces = { left: null, right: null };
const faceLoadId = { left: 0, right: 0 };
const faceRenderId = { left: 0, right: 0 };
const maxClipSeconds = () => catalog?.sceneRemix?.maxSeconds || 30;
const realPhotoSelected = () => ['elon-musk', 'will-smith'].some((id) => Object.values(selectedFaces).includes(id));

function updateFacePicker() {
  $('facePicker').querySelectorAll('button[data-face-id]').forEach((button) => {
    const selected = selectedFaces[button.dataset.faceSide] === button.dataset.faceId;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-label', `Use ${button.dataset.faceName} for ${button.dataset.faceSide} person${selected ? ', selected' : ''}`);
    button.disabled = !catalog || busy || running || demoLoading;
  });
  $('faceWarning').classList.toggle('hide', !realPhotoSelected());
}

function renderFacePicker() {
  const grid = $('facePicker');
  for (const preset of FACE_PRESETS) {
    const card = document.createElement('div'); card.className = 'face-preset';
    const photo = document.createElement('img'); photo.src = `/assets/demo/${preset.file}`; photo.alt = preset.name; photo.loading = 'lazy';
    const copy = document.createElement('div'); copy.className = 'face-preset-copy';
    const name = document.createElement('strong'); name.textContent = preset.name;
    const kind = document.createElement('span'); kind.textContent = preset.kind;
    copy.append(name, kind);
    const actions = document.createElement('div'); actions.className = 'face-preset-actions';
    for (const side of ['left', 'right']) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.faceId = preset.id; button.dataset.faceName = preset.name; button.dataset.faceSide = side;
      button.textContent = `Use for ${side}`;
      button.onclick = () => selectFacePreset(preset, side);
      actions.append(button);
    }
    card.append(photo, copy, actions); grid.append(card);
  }
  updateFacePicker();
}

async function selectFacePreset(preset, side) {
  if (busy || running || demoLoading) return;
  if (selectedFaces[side] === preset.id && (side === 'left' ? characterInput : character2Input)) return;
  const request = ++faceLoadId[side];
  $('faceStatus').textContent = `Adding ${preset.name}…`;
  try {
    const response = await fetch(`/assets/demo/${preset.file}`);
    if (!response.ok) throw new Error(`Could not load ${preset.name}.`);
    const file = new File([await response.blob()], `${preset.name}.${preset.type === 'image/png' ? 'png' : 'jpg'}`, { type: preset.type });
    if (request !== faceLoadId[side]) return;
    const added = await receiveCharacter(file, side === 'right', preset.id);
    if (request === faceLoadId[side]) $('faceStatus').textContent = added ? `${preset.name} added to the ${side} person.` : '';
  } catch (error) {
    if (request === faceLoadId[side]) $('faceStatus').textContent = error.message;
  }
}

function receiveUploadedCharacter(file, second = false) {
  faceLoadId[second ? 'right' : 'left']++;
  $('faceStatus').textContent = '';
  return receiveCharacter(file, second);
}

function resetSceneDescription(keepManual = false) {
  sceneEpoch++;
  const manual = keepManual && sceneEdited;
  if (!manual) $('sceneDescription').value = '';
  autoSceneValue = '';
  sceneEdited = manual;
  $('sceneStatus').textContent = manual ? 'Your description is saved.' : "We'll describe the background from the clip while preparing it.";
}

function useSceneDescription(description) {
  if (!description || sceneEdited || $('sceneDescription').value.trim()) return;
  autoSceneValue = description;
  $('sceneDescription').value = description;
  $('sceneStatus').textContent = 'Drafted from the clip. You can edit it.';
}

function describeScene(frames, cacheKey, epoch) {
  if (!frames?.length || sceneEdited || $('sceneDescription').value.trim()) return;
  $('sceneStatus').textContent = 'Describing the background…';
  api('/api/enhance', { kind: 'scene-background', frames }).then(({ description }) => {
    if (cacheKey) void saveDemoDescription(cacheKey, description);
    if (epoch === sceneEpoch) useSceneDescription(description);
  }).catch(() => {
    if (epoch === sceneEpoch && !sceneEdited) $('sceneStatus').textContent = 'Could not describe this clip. Add a few words about the setting.';
  });
}

function step(number) { for (let i = 1; i <= 4; i++) $(`step${i}`).classList.toggle('on', i === number); }
function clipRange() {
  const start = Number($('start').value), seconds = Number($('length').value);
  if (!source || !Number.isFinite(start) || start < 0 || !Number.isInteger(seconds) || seconds < 4 || seconds > maxClipSeconds() || start + seconds > sourceSeconds + .08) throw new Error(`Choose 4–${maxClipSeconds()} seconds inside the video.`);
  return { start, seconds };
}
function selectedMode() { return document.querySelector('input[name=mode]:checked')?.value || 'person-mask'; }
function chosenModel(id) { return catalog.sceneRemix?.models?.find((model) => model.id === $(id).value); }
const OPENLUX_SEEDANCE_25 = 'doubao-seedance-2-5-260628';
function canFinishDraft(model) {
  return model?.draftFinishReady === true && model.api === 'openlux' && model.id === OPENLUX_SEEDANCE_25
    && draftItem?.api === 'openlux' && draftItem.model === model.id && draftItem.draft && !!draftItem.generationId;
}
function goodLink() { try { const url = new URL($('publicUrl').value.trim()); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }
function guideReliable() {
  if (!prepared?.stats) return false;
  const stats = prepared.stats, mode = selectedMode();
  const faces = mode === 'face-mesh' || mode === 'combined';
  return (!faces || stats.faceGaps / stats.frames <= .05)
    && stats.maskGaps / stats.frames <= .02 && stats.maxMaskGapRun <= 2
    && (mode === 'depth-only' || (stats.personMaskGaps / stats.frames <= .02 && stats.maxPersonMaskRun <= 2));
}
function readyToGenerate() {
  const imagesReady = !!characterInput && (!character2 || !!character2Input);
  const draftModelReady = !!chosenModel('draftModel')?.editReady;
  $('makeDraft').disabled = busy || running || !catalog.sceneRemix?.ready || !preparedInput || !imagesReady || !goodLink() || !$('reviewed').checked || !draftModelReady;
  $('makeFinal').disabled = busy || running || !draftItem || !preparedInput || !imagesReady || (!canFinishDraft(chosenModel('finalModel')) && !goodLink()) || !$('reviewed').checked || !chosenModel('finalModel')?.editReady;
  $('generationHint').textContent = busy ? 'Preparing the clip…' : running ? 'Generation is in progress…'
    : !catalog.sceneRemix?.ready ? 'Connect an available Seedance model to generate.'
      : !preparedInput ? 'Prepare the clip first.'
        : !imagesReady ? 'Wait for the face images to finish uploading.'
          : !goodLink() ? 'Add a direct HTTPS link to the silent model reference.'
            : !$('reviewed').checked ? 'Check the box after reviewing the guide.'
              : !draftModelReady ? 'Choose an available draft model.' : 'Ready to generate.';
  $('faceGridFields').disabled = busy || running || demoLoading;
  updateFacePicker();
}
function clearResults() {
  draftItem = null; $('draftResult').replaceChildren(); $('finalResult').replaceChildren(); $('finalArea').classList.add('hide'); $('resultsPanel').classList.add('hide');
  $('resultStatus').textContent = 'No generation yet';
  if (catalog) resolutionOptions('final');
}
function clearPrepared() {
  if (preparedUrl) URL.revokeObjectURL(preparedUrl);
  preparedUrl = ''; prepared = null; preparedInput = ''; hostedUrl = ''; hostedUntil = 0;
  $('reviewStage').replaceChildren();
  const empty = document.createElement('div'); empty.className = 'empty'; empty.innerHTML = '<b>Preview appears here</b><p>Add a clip and character, then prepare the motion guide.</p>';
  $('reviewStage').append(empty);
  $('metrics').replaceChildren(); $('metrics').classList.add('hide'); $('preparedActions').classList.add('hide'); $('generationOptions').classList.add('hide');
  $('publicUrl').value = ''; $('reviewed').checked = false; $('reviewStatus').textContent = 'Waiting for source';
  $('linkHint').textContent = 'Set up S3 above for automatic hosting. Or host the silent reference yourself and paste its direct HTTPS link here.';
  $('downloadSilent').removeAttribute('href');
  $('reviewNote').textContent = 'Watch the full guide and check the movement before generating.';
  $('reviewNote').classList.remove('warn');
  clearResults(); readyToGenerate();
}

async function refreshStorage() {
  storage = await api('/api/apps/scene-remix/storage');
  $('storageToggle').classList.toggle('hide', !storage.canEdit);
  $('storageLabel').textContent = storage.configured ? `S3 hosting · ${storage.bucket}` : catalog.sceneRemix?.canShare ? 'Automatic hosting connected' : 'Automatic hosting is off';
  $('storageHint').textContent = storage.configured ? 'A private link is made for each silent model reference.' : catalog.sceneRemix?.canShare ? 'JustImagine will host the silent reference.' : 'Add S3 settings once, or use a direct HTTPS link.';
  $('s3Endpoint').value = storage.endpoint || '';
  $('s3Region').value = storage.region || 'auto';
  $('s3Bucket').value = storage.bucket || '';
  $('s3Prefix').value = storage.prefix || 'justimagine/remix';
  $('s3KeyId').value = '';
  $('s3Secret').value = '';
  $('s3KeyId').placeholder = storage.accessKeyPreview ? `Saved (${storage.accessKeyPreview}); leave blank to keep` : 'Access key ID';
  $('s3Secret').placeholder = storage.secretSaved ? 'Saved; leave blank to keep' : 'Secret access key';
  $('removeS3').classList.toggle('hide', !storage.configured);
}

async function hostPrepared() {
  if (!preparedInput) throw new Error('Prepare the clip first.');
  $('linkHint').textContent = 'Hosting the silent model reference…';
  const shared = await api('/api/apps/scene-remix/share', { source: preparedInput });
  $('publicUrl').value = shared.url;
  hostedUrl = shared.url;
  hostedUntil = shared.expiresIn ? Date.now() + shared.expiresIn * 1000 : 0;
  $('linkHint').textContent = shared.expiresIn ? `Ready. This private link lasts ${Math.round(shared.expiresIn / 3600)} hours and contains no source audio.` : 'Ready. The hosted reference contains no source audio.';
  readyToGenerate();
}

async function saveStorage() {
  const button = $('saveS3'); button.disabled = true; button.textContent = 'Testing…';
  $('storageMessage').classList.remove('error'); $('storageMessage').textContent = '';
  try {
    const values = { endpoint: $('s3Endpoint').value, region: $('s3Region').value, bucket: $('s3Bucket').value, prefix: $('s3Prefix').value };
    if ($('s3KeyId').value.trim()) values.accessKeyId = $('s3KeyId').value.trim();
    if ($('s3Secret').value.trim()) values.secretAccessKey = $('s3Secret').value.trim();
    await api('/api/apps/scene-remix/storage', values);
    catalog.sceneRemix = (await api('/api/apps')).sceneRemix;
    await refreshStorage();
    $('storageMessage').textContent = 'S3 is ready. Future clips will host automatically.';
    if (preparedInput) await hostPrepared();
    readyToGenerate();
  } catch (error) { $('storageMessage').textContent = error.message; $('storageMessage').classList.add('error'); }
  finally { button.disabled = false; button.textContent = 'Test and save'; }
}

async function removeStorage() {
  $('removeS3').disabled = true; $('storageMessage').textContent = '';
  try {
    await api('/api/apps/scene-remix/storage/remove', {});
    if ($('publicUrl').value === hostedUrl) $('publicUrl').value = '';
    hostedUrl = ''; hostedUntil = 0;
    catalog.sceneRemix = (await api('/api/apps')).sceneRemix;
    await refreshStorage();
    $('storageMessage').textContent = 'S3 settings removed.';
    readyToGenerate();
  } catch (error) { $('storageMessage').textContent = error.message; $('storageMessage').classList.add('error'); }
  finally { $('removeS3').disabled = false; }
}
function modelOptions() {
  const seconds = Number($('length').value) || 4;
  const models = (catalog.sceneRemix?.models || []).filter((model) => model.editReady && model.durations?.includes(seconds));
  const setList = (id, preferred) => {
    const select = $(id), before = select.value; select.replaceChildren();
    for (const model of models) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.name || model.id; select.append(option); }
    if (models.some((model) => model.id === before)) select.value = before;
    else select.value = models.find((model) => model.id === preferred)?.id || models[0]?.id || '';
  };
  const preferred = models.some((model) => model.id === OPENLUX_SEEDANCE_25) ? OPENLUX_SEEDANCE_25 : '';
  setList('draftModel', preferred || 'bytedance/seedance-2.0-mini');
  setList('finalModel', preferred || 'bytedance/seedance-2.0');
  resolutionOptions('draft'); resolutionOptions('final'); readyToGenerate();
}
function resolutionOptions(stage) {
  const model = chosenModel(stage === 'draft' ? 'draftModel' : 'finalModel');
  const select = $(stage === 'draft' ? 'draftResolution' : 'finalResolution');
  const previous = select.value; select.replaceChildren();
  const sameDraft = stage === 'final' && canFinishDraft(model);
  for (const resolution of (model?.resolutions || []).filter((value) =>
    sameDraft ? value === '1080p' : stage === 'draft' && model?.id === OPENLUX_SEEDANCE_25 ? value === '480p' : ['480p','720p','1080p'].includes(value))) {
    const option = document.createElement('option'); option.value = resolution; option.textContent = resolution; select.append(option);
  }
  const wanted = stage === 'draft' ? '480p' : model?.resolutions?.includes('1080p') ? '1080p' : '720p';
  select.value = [...select.options].some((option) => option.value === previous) ? previous : wanted;
  const note = $(stage === 'draft' ? 'draftModelNote' : 'finalModelNote');
  note.classList.remove('hide');
  note.textContent = stage === 'draft'
    ? model?.id === OPENLUX_SEEDANCE_25 ? 'Review the 480p draft. OpenLux currently makes a new take for the final.' : 'This preview is a separate video generation.'
    : sameDraft ? 'This finishes the same take you approved. OpenLux reuses the draft inputs.'
      : draftItem?.draftFallback ? 'OpenLux could not run draft mode. Final will make a new take from this guide.'
        : draftItem?.draft && model?.id === OPENLUX_SEEDANCE_25 ? 'OpenLux cannot upgrade this draft yet. Final makes a new 1080p take from the guide.'
        : 'This makes a new take from the prepared guide.';
  if (stage === 'final') $('makeFinal').textContent = sameDraft ? 'Finish this draft' : 'Generate final';
}
function renderRange() {
  if (!source) return;
  if (prepared) clearPrepared();
  const start = Number($('start').value) || 0, seconds = Number($('length').value) || 4;
  $('clipHint').textContent = start + seconds <= sourceSeconds + .08 ? `Selected ${seconds} seconds, from ${start.toFixed(1)} to ${(start + seconds).toFixed(1)}.` : 'This range runs past the end of the clip.';
  readyToPrepare();
}
function readyToPrepare() {
  const invalidRange = (() => { try { clipRange(); return false; } catch { return true; } })();
  $('prepare').disabled = busy || !source || !character || !canPrepareScene() || invalidRange;
  $('prepareHint').textContent = !source ? 'Add or load a source clip to continue.'
    : !character ? 'Add at least one face.'
      : invalidRange ? `Choose 4–${maxClipSeconds()} seconds inside the clip.`
        : !canPrepareScene() ? 'Use Chrome or Edge with WebGPU to prepare the clip.' : 'Ready to prepare.';
}
function fileDrop(zone, picker, receive) {
  $(zone).onclick = (event) => { if (!event.target.closest('button')) $(picker).click(); };
  $(zone).ondragover = (event) => { event.preventDefault(); $(zone).classList.add('drag'); };
  $(zone).ondragleave = () => $(zone).classList.remove('drag');
  $(zone).ondrop = (event) => { event.preventDefault(); $(zone).classList.remove('drag'); if (event.dataTransfer.files?.[0]) receive(event.dataTransfer.files[0]); };
  $(picker).onchange = (event) => { if (event.target.files?.[0]) receive(event.target.files[0]); };
}
async function uploadTemporary(blob, name) {
  const { id } = await api('/api/media', { folder: '', name, size: blob.size, temporary: true });
  for (let at = 0; at < blob.size; at += 4 * 1024 * 1024) {
    const part = blob.slice(at, at + 4 * 1024 * 1024);
    const response = await fetch(`/api/media/chunk?id=${encodeURIComponent(id)}&offset=${at}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: part });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Upload stopped. Try again.');
  }
  return (await api('/api/media/done', { id })).input.id;
}
function receiveSource(file) {
  if (!/\.(mp4|webm|mov)$/i.test(file.name) && !/^video\//.test(file.type)) { errorText('draftError', 'Choose an MP4, WebM, or MOV video.'); return; }
  demoVersion = ''; resetSceneDescription();
  source = file; sourceSeconds = 0; if (sourceUrl) URL.revokeObjectURL(sourceUrl); sourceUrl = URL.createObjectURL(file);
  $('sourceName').textContent = file.name; $('sourceDrop').classList.add('has-file'); $('sourceLoaded').classList.remove('hide');
  $('sourcePreview').onloadedmetadata = () => {
    sourceSeconds = $('sourcePreview').duration;
    if (!Number.isFinite(sourceSeconds) || sourceSeconds < 4) { errorText('draftError', 'Use a clip at least four seconds long.'); return; }
    $('length').replaceChildren();
    for (let n = 4; n <= Math.min(maxClipSeconds(), Math.floor(sourceSeconds + .02)); n++) { const option = document.createElement('option'); option.value = n; option.textContent = `${n} seconds`; $('length').append(option); }
    $('length').value = String(Math.min(8, Math.floor(sourceSeconds + .02)));
    const shape = $('sourcePreview').videoWidth / $('sourcePreview').videoHeight;
    const ratios = ['16:9','9:16','1:1','4:3','3:4','21:9'];
    aspectRatio = ratios.reduce((best, ratio) => { const [a,b] = ratio.split(':').map(Number); const [c,d] = best.split(':').map(Number); return Math.abs(Math.log(shape / (a/b))) < Math.abs(Math.log(shape / (c/d))) ? ratio : best; }, '16:9');
    $('start').value = '0'; modelOptions(); renderRange();
  };
  $('sourcePreview').src = sourceUrl;
  clearPrepared(); step(1); readyToPrepare(); errorText('draftError', '');
}
async function renderCharacterFace(second = false) {
  const side = second ? 'right' : 'left';
  const prefix = second ? 'character2' : 'character';
  const file = second ? character2 : character;
  if (!file) return false;
  const request = ++faceRenderId[side];
  if (second) character2Input = ''; else characterInput = '';
  $(`${prefix}Status`).textContent = 'Preparing face…';
  $(`${prefix}PreviewButton`).disabled = true;
  $(`${prefix}Preview`).src = second ? character2RawUrl : characterRawUrl;
  readyToGenerate();
  try {
    const gridded = await gridFaceFile(file, faceGridSettings, faceGridSeeds[side]);
    if (request !== faceRenderId[side]) return false;
    const url = URL.createObjectURL(gridded);
    if (second) { if (character2Url) URL.revokeObjectURL(character2Url); character2Url = url; }
    else { if (characterUrl) URL.revokeObjectURL(characterUrl); characterUrl = url; }
    $(`${prefix}Preview`).src = url;
    $(`${prefix}PreviewButton`).disabled = false;
    const dialog = $('facePreviewDialog');
    if (dialog.open && dialog.dataset.side === side) $('facePreviewImage').src = url;
    $(`${prefix}Status`).textContent = 'Uploading face with grid…';
    const id = await uploadTemporary(gridded, gridded.name);
    if (request !== faceRenderId[side]) return false;
    if (second) character2Input = id; else characterInput = id;
    $(`${prefix}Status`).textContent = 'Face ready with grid and mosaic.';
    readyToGenerate();
    return true;
  } catch (error) {
    if (request === faceRenderId[side]) {
      $(`${prefix}Status`).textContent = error.message;
      errorText('draftError', `Could not add the ${side} face: ${error.message}`);
    }
    return false;
  }
}

async function receiveCharacter(file, second = false, presetId = null) {
  if (!/^(image\/(png|jpeg|webp))$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) { errorText('draftError', 'Choose a PNG, JPEG, or WebP image.'); return; }
  if (file.size > 32 * 1024 * 1024) { errorText('draftError', 'Use an image under 32 MB.'); return; }
  selectedFaces[second ? 'right' : 'left'] = presetId;
  faceGridSeeds[second ? 'right' : 'left'] = randomFaceSeed();
  updateFacePicker();
  const prefix = second ? 'character2' : 'character';
  const reuseGuide = !!prepared && selectedMode() === 'person-mask';
  if (second && selectedMode() === 'face-mesh') document.querySelector('input[name=mode][value=person-mask]').checked = true;
  if (second) { character2 = file; character2Input = ''; if (character2RawUrl) URL.revokeObjectURL(character2RawUrl); character2RawUrl = URL.createObjectURL(file); }
  else { character = file; characterInput = ''; if (characterRawUrl) URL.revokeObjectURL(characterRawUrl); characterRawUrl = URL.createObjectURL(file); }
  $(`${prefix}Preview`).src = second ? character2RawUrl : characterRawUrl;
  $(`${prefix}Name`).textContent = file.name; $(`${prefix}Drop`).classList.add('has-file'); $(`${prefix}Loaded`).classList.remove('hide');
  if (reuseGuide) clearResults(); else clearPrepared();
  readyToPrepare(); readyToGenerate(); errorText('draftError', '');
  return renderCharacterFace(second);
}

function previewCharacterFace(second = false) {
  const prefix = second ? 'character2' : 'character';
  const dialog = $('facePreviewDialog');
  dialog.dataset.side = second ? 'right' : 'left';
  $('facePreviewTitle').textContent = second ? 'Right face' : 'Left face';
  $('facePreviewImage').src = $(`${prefix}Preview`).src;
  $('facePreviewImage').alt = `${second ? 'Right' : 'Left'} face with alignment grid`;
  updateFacePreviewCaption();
  dialog.showModal();
}

function updateFacePreviewCaption() {
  const grid = faceGridSettings;
  $('facePreviewCaption').textContent = `Face prepared for the model · ${grid.columns}×${grid.rows} grid · ${grid.lineWidth} px lines · ${grid.mosaicSize ? `${grid.mosaicSize} px mosaic` : 'mosaic off'}${grid.squiggle ? ` · ${grid.squiggleAmount}% squiggle` : ''}`;
}

function renderFaceGridSettings() {
  const grid = faceGridSettings;
  for (const key of FACE_GRID_FIELDS) {
    const id = `faceGrid${key[0].toUpperCase()}${key.slice(1)}`;
    $(id).value = String(grid[key]);
    $(`${id}Range`).value = String(grid[key]);
  }
  $('faceGridColorPicker').value = grid.color;
  $('faceGridColorHex').value = grid.color;
  $('faceGridSquiggle').checked = grid.squiggle;
  $('faceGridSquiggleControls').classList.toggle('hide', !grid.squiggle);
  document.querySelectorAll('[data-grid-color]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.gridColor === grid.color)));
  const colorName = { '#FFFFFF': 'white', '#000000': 'black', '#FF0000': 'red', '#00FF00': 'green', '#0000FF': 'blue', '#FFFF00': 'yellow' }[grid.color] || grid.color;
  $('faceGridSummary').textContent = `${grid.columns} × ${grid.rows} · ${grid.lineWidth} px · ${colorName} · mosaic ${grid.mosaicSize} px${grid.squiggle ? ` · squiggle ${grid.squiggleAmount}%` : ''}`;
  if ($('facePreviewDialog').open) updateFacePreviewCaption();
}

function flushFaceGridRender() {
  if (!faceGridRenderTimer) return;
  clearTimeout(faceGridRenderTimer);
  faceGridRenderTimer = null;
  void Promise.all([renderCharacterFace(), renderCharacterFace(true)]);
}

function refreshFaceGrid() {
  faceRenderId.left++;
  faceRenderId.right++;
  characterInput = '';
  character2Input = '';
  for (const [prefix, file] of [['character', character], ['character2', character2]]) {
    if (!file) continue;
    $(`${prefix}PreviewButton`).disabled = true;
    $(`${prefix}Status`).textContent = 'Updating face…';
  }
  clearResults();
  readyToGenerate();
  clearTimeout(faceGridRenderTimer);
  faceGridRenderTimer = character || character2 ? setTimeout(flushFaceGridRender, 180) : null;
}

function changeFaceGridSettings(patch) {
  if (busy || running || demoLoading) return;
  const next = normalizeFaceGridSettings({ ...faceGridSettings, ...patch });
  if (FACE_GRID_FIELDS.every((key) => next[key] === faceGridSettings[key]) && next.color === faceGridSettings.color && next.squiggle === faceGridSettings.squiggle) return;
  faceGridSettings = next;
  renderFaceGridSettings();
  try { localStorage.setItem(FACE_GRID_STORAGE_KEY, JSON.stringify(next)); $('faceGridSaveStatus').textContent = 'Saved in this browser'; }
  catch { $('faceGridSaveStatus').textContent = 'Browser storage unavailable'; }
  refreshFaceGrid();
}

function initFaceGridSettings() {
  try {
    const saved = localStorage.getItem(FACE_GRID_STORAGE_KEY);
    if (saved) faceGridSettings = normalizeFaceGridSettings(JSON.parse(saved));
  } catch { $('faceGridSaveStatus').textContent = 'Browser storage unavailable'; }
  renderFaceGridSettings();
  for (const key of FACE_GRID_FIELDS) {
    const id = `faceGrid${key[0].toUpperCase()}${key.slice(1)}`;
    $(`${id}Range`).oninput = () => changeFaceGridSettings({ [key]: $(`${id}Range`).value });
    $(`${id}Range`).onchange = flushFaceGridRender;
    $(id).onchange = () => changeFaceGridSettings({ [key]: $(id).value });
  }
  document.querySelectorAll('[data-grid-color]').forEach((button) => { button.onclick = () => changeFaceGridSettings({ color: button.dataset.gridColor }); });
  $('faceGridSquiggle').onchange = () => changeFaceGridSettings({ squiggle: $('faceGridSquiggle').checked });
  $('faceGridShuffle').onclick = () => {
    if (busy || running || demoLoading || !faceGridSettings.squiggle) return;
    faceGridSeeds.left = randomFaceSeed();
    faceGridSeeds.right = randomFaceSeed();
    refreshFaceGrid();
  };
  $('faceGridColorPicker').oninput = () => changeFaceGridSettings({ color: $('faceGridColorPicker').value });
  $('faceGridColorPicker').onchange = flushFaceGridRender;
  $('faceGridColorHex').onchange = () => {
    const color = $('faceGridColorHex').value.trim();
    if (/^#[\da-f]{6}$/i.test(color)) changeFaceGridSettings({ color });
    else $('faceGridColorHex').value = faceGridSettings.color;
  };
  $('faceGridReset').onclick = () => {
    changeFaceGridSettings(DEFAULT_FACE_GRID);
    try { localStorage.removeItem(FACE_GRID_STORAGE_KEY); $('faceGridSaveStatus').textContent = 'Default grid restored'; }
    catch { $('faceGridSaveStatus').textContent = 'Browser storage unavailable'; }
    flushFaceGridRender();
  };
}
async function loadDemo(kind = 'orange') {
  const button = $(kind === 'fictional' ? 'loadFictional' : 'loadDemo');
  const buttonLabel = button.textContent;
  $('loadDemo').disabled = true; $('loadFictional').disabled = true;
  demoLoading = true; faceLoadId.left++; faceLoadId.right++; readyToGenerate();
  button.textContent = 'Loading…'; errorText('demoError', '');
  try {
    const demo = await api('/api/apps/scene-remix/demo', { clip: kind });
    const file = async (url, name, type) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load ${name}.`);
      const blob = await response.blob();
      return new File([blob], name, { type: blob.type || type });
    };
    const [video, left, right] = await Promise.all([
      file(demo.video, `${kind === 'fictional' ? 'fictional' : 'orange'}-studio-demo.mp4`, 'video/mp4'),
      file(demo.faces[0], 'Studio face 1.png', 'image/png'),
      file(demo.faces[1], 'Studio face 2.png', 'image/png')
    ]);
    document.querySelector('input[name=mode][value=person-mask]').checked = true;
    receiveSource(video);
    demoVersion = `${kind}-${demo.version}`;
    const [leftReady, rightReady] = await Promise.all([receiveCharacter(left, false, 'studio-left'), receiveCharacter(right, true, 'studio-right')]);
    if (!leftReady || !rightReady) throw new Error('Could not add the sample faces.');
    if (!sourceSeconds) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The demo video did not load.')), 10_000);
      $('sourcePreview').addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    $('prepStatus').textContent = 'Demo loaded. A saved guide will be reused if available.';
    readyToPrepare();
  } catch (error) { errorText('demoError', error.message); }
  finally { $('loadDemo').disabled = false; $('loadFictional').disabled = false; button.textContent = buttonLabel; demoLoading = false; readyToGenerate(); }
}
async function prepare() {
  if (busy) return;
  try {
    const { start, seconds } = clipRange();
    busy = true; readyToPrepare(); clearPrepared(); step(2);
    $('prepProgress').classList.remove('hide'); $('prepBar').style.width = '0%'; $('prepare').textContent = 'Preparing…'; $('prepStatus').classList.remove('error');
    abort = new AbortController();
    const epoch = ++sceneEpoch;
    const cacheKey = demoGuideKey({ version: demoVersion, start, seconds, mode: selectedMode(), aspectRatio, expectedFaces: character2 ? 2 : 1 });
    prepared = await loadDemoGuide(cacheKey);
    if (prepared) {
      $('prepStatus').textContent = 'Using saved demo guide…';
      useSceneDescription(prepared.description);
      if (!prepared.description) describeScene(prepared.sceneFrames, cacheKey, epoch);
    } else {
      prepared = await prepareSceneClip({ file: source, start, seconds, mode: selectedMode(), aspectRatio, expectedFaces: character2 ? 2 : 1, signal: abort.signal,
        onSceneFrames: (frames) => describeScene(frames, cacheKey, epoch),
        onProgress: ({ phase, fraction }) => { $('prepStatus').textContent = `${phase}${fraction ? ` · ${Math.round(fraction * 100)}%` : ''}`; $('prepBar').style.width = `${Math.round(fraction * 100)}%`; } });
      if (cacheKey) void saveDemoGuide(cacheKey, { ...prepared, description: autoSceneValue }).then(() => {
        if (autoSceneValue) return saveDemoDescription(cacheKey, autoSceneValue);
      });
    }
    preparedUrl = URL.createObjectURL(prepared.blob);
    const video = document.createElement('video'); video.src = preparedUrl; video.poster = prepared.poster; video.controls = true; video.playsInline = true;
    $('reviewStage').replaceChildren(video); $('reviewStatus').textContent = 'Ready to review';
    const stats = prepared.stats; $('metrics').replaceChildren();
    for (const label of [`${stats.seconds}s`, `${stats.width} × ${stats.height}`, `${stats.frames} frames`, ...(stats.backgroundColor ? [`Backdrop ${stats.backgroundColor}`] : []), ...(selectedMode() === 'face-mesh' ? [`${stats.faceGaps} face gaps`] : []), ...(stats.personMaskGaps ? [`${stats.personMaskGaps} missed person frames`] : []), ...(stats.maskGaps ? [`${stats.maskGaps} weak depth frames`] : [])]) {
      const chip = document.createElement('span'); chip.textContent = label; $('metrics').append(chip);
    }
    $('metrics').classList.remove('hide'); $('preparedActions').classList.remove('hide'); $('generationOptions').classList.remove('hide');
    $('downloadPrepared').href = preparedUrl;
    const reliable = guideReliable();
    $('reviewNote').classList.toggle('warn', !reliable);
    $('reviewNote').textContent = !reliable
      ? 'The guide lost useful detail in this section. Try a shorter or clearer shot, then prepare it again.'
      : 'Watch the full clip. Check that the movement stays clear before you approve it.';
    $('prepStatus').textContent = 'Saving prepared clip to JustImagine…';
    preparedInput = await uploadTemporary(prepared.blob, 'video-remix-prepared.mp4');
    $('downloadSilent').href = `/api/apps/scene-remix/reference?source=${encodeURIComponent(preparedInput)}`;
    let hostingError = '';
    if (catalog.sceneRemix?.canShare) {
      $('prepStatus').textContent = 'Hosting silent model reference…';
      try { await hostPrepared(); }
      catch (error) { hostingError = error.message; $('linkHint').textContent = `Automatic hosting failed: ${hostingError} Download the silent reference and use your own HTTPS link, or check S3 settings.`; }
    }
    $('prepStatus').textContent = hostingError ? 'Prepared. The guide is ready, but hosting needs attention.' : 'Prepared. Watch the full clip before generating.';
    step(3); readyToGenerate(); $('reviewStage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) { $('prepStatus').textContent = error.message; $('prepStatus').classList.add('error'); }
  finally { busy = false; abort = null; $('prepProgress').classList.add('hide'); $('prepare').textContent = 'Prepare clip'; readyToPrepare(); readyToGenerate(); }
}
function resultCard(item, label) {
  const card = document.createElement('div'); card.className = 'result-card';
  const video = document.createElement('video'); video.src = mediaUrl(item); video.controls = true; video.playsInline = true;
  const footer = document.createElement('footer'); const title = document.createElement('strong'); title.textContent = item.originalAudio ? `${label} · original audio restored` : `${label} · model output`;
  const link = document.createElement('a'); link.href = mediaUrl(item, true); link.download = item.file; link.textContent = 'Download video';
  footer.append(title, link); card.append(video, footer);
  if (item.restoreError) { const warning = document.createElement('p'); warning.className = 'error-box'; warning.textContent = `The original audio could not be restored: ${item.restoreError}. The model output is saved so you can still download it.`; card.append(warning); }
  return card;
}
async function pollJob(id, stage) {
  $('resultsPanel').classList.remove('hide');
  const target = $(stage === 'draft' ? 'draftResult' : 'finalResult');
  target.replaceChildren();
  const note = document.createElement('div'); note.className = 'banner'; note.textContent = 'The model is working. Its result will be saved in the gallery.'; target.append(note);
  while (true) {
    const data = await api(`/api/jobs?ids=${encodeURIComponent(id)}&wait=5`);
    const job = data.results?.[0];
    if (!job || data.missing?.length) {
      sessionStorage.removeItem(`justimagine:scene-remix:${stage}`);
      target.replaceChildren();
      $('resultStatus').textContent = 'Job unavailable';
      throw new Error('The job is no longer in memory. Check the gallery for its result.');
    }
    if (job.status === 'done') {
      sessionStorage.removeItem(`justimagine:scene-remix:${stage}`);
      target.replaceChildren(resultCard(job.item, stage === 'draft' ? job.item.draftFallback ? 'Preview' : 'Draft' : 'Final'));
      $('resultStatus').textContent = job.item.originalAudio ? (stage === 'draft' ? 'Draft ready' : 'Final ready') : 'Video saved; audio needs attention';
      if (stage === 'draft') { draftItem = job.item; $('finalArea').classList.remove('hide'); resolutionOptions('final'); }
      readyToGenerate(); return;
    }
    if (job.status === 'error' || job.status === 'cancelled') {
      sessionStorage.removeItem(`justimagine:scene-remix:${stage}`);
      target.replaceChildren();
      $('resultStatus').textContent = 'Could not finish';
      const error = new Error(job.error || 'Generation stopped.');
      error.providerTaskId = job.providerTaskId;
      throw error;
    }
    note.textContent = job.phase === 'restoring original audio' ? 'Restoring the original soundtrack…' : job.phase === 'queued' ? 'Waiting for a free model slot…' : 'Generating video… The result will be saved in the gallery.';
  }
}
async function generate(stage) {
  if (busy || running) return;
  running = true; readyToGenerate();
  errorText('draftError', '');
  try {
    if (!preparedInput || !characterInput) throw new Error('Prepare the clip and add a character first.');
    if (!$('reviewed').checked) throw new Error('Watch and approve the prepared clip first.');
    const model = chosenModel(stage === 'draft' ? 'draftModel' : 'finalModel');
    if (!model) throw new Error('Choose a connected Seedance model.');
    const finishDraft = stage === 'final' && canFinishDraft(model);
    if (!finishDraft) {
      if (hostedUrl && $('publicUrl').value.trim() === hostedUrl && hostedUntil && hostedUntil - Date.now() < 15 * 60_000) await hostPrepared();
      if (!goodLink()) throw new Error('Host the silent model reference with S3 or paste its direct public HTTPS link.');
    }
    step(4); $('resultsPanel').classList.remove('hide'); readyToGenerate();
    $(stage === 'draft' ? 'makeDraft' : 'makeFinal').textContent = 'Starting…';
    const queued = await api('/api/apps/scene-remix', { source: preparedInput, character: characterInput, character2: character2 ? character2Input : undefined, faceGrid: true, reviewed: true,
      videoRef: finishDraft ? undefined : $('publicUrl').value.trim(), draftTaskId: finishDraft ? draftItem.generationId : undefined,
      draft: stage === 'draft' && model.id === OPENLUX_SEEDANCE_25,
      mode: selectedMode(), scene: $('sceneDescription').value, backgroundColor: prepared.stats.backgroundColor, instruction: $('instruction').value,
      model: model.id, resolution: $(stage === 'draft' ? 'draftResolution' : 'finalResolution').value, aspectRatio });
    const id = queued.jobs?.[0]; if (!id) throw new Error('The video job did not start.');
    sessionStorage.setItem(`justimagine:scene-remix:${stage}`, id);
    $(stage === 'draft' ? 'makeDraft' : 'makeFinal').textContent = stage === 'draft' ? 'Generating draft…' : 'Generating final…';
    try {
      await pollJob(id, stage);
    } catch (error) {
      if (!error.providerTaskId || !/could not be checked|video could not be downloaded|fetch failed/i.test(error.message)) throw error;
      $('resultStatus').textContent = 'Reconnecting to OpenLux task';
      const resumed = await api('/api/apps/scene-remix', { source: preparedInput, reviewed: true, model: model.id,
        resumeTaskId: error.providerTaskId, resolution: $(stage === 'draft' ? 'draftResolution' : 'finalResolution').value,
        aspectRatio, mode: selectedMode() });
      const resumedId = resumed.jobs?.[0]; if (!resumedId) throw new Error('Could not resume the OpenLux task.');
      sessionStorage.setItem(`justimagine:scene-remix:${stage}`, resumedId);
      await pollJob(resumedId, stage);
    }
  } catch (error) {
    errorText('draftError', remixErrorMessage(error.message));
    $('resultStatus').textContent = 'Could not finish';
  }
  finally { running = false; $('makeDraft').textContent = 'Generate draft'; resolutionOptions('final'); readyToGenerate(); }
}
async function boot() {
  initFaceGridSettings();
  renderFacePicker();
  try { catalog = await api('/api/apps'); }
  catch (error) { errorText('draftError', `Could not load the app: ${error.message}`); return; }
  updateFacePicker();
  try { await refreshStorage(); }
  catch (error) { $('storageLabel').textContent = 'Hosting status unavailable'; $('storageHint').textContent = error.message; }
  if (!catalog.sceneRemix?.ready) errorText('draftError', 'Generation needs a connected Seedance model and FFmpeg. You can still prepare a guide in this browser.');
  $('sourceRangeLabel').textContent = `4–${maxClipSeconds()} seconds for the selected part`;
  if (!canPrepareScene()) $('prepStatus').textContent = 'Use Chrome or Edge with WebGPU on a secure page to prepare a clip.';
  fileDrop('sourceDrop', 'sourceFile', receiveSource); fileDrop('characterDrop', 'characterFile', receiveUploadedCharacter);
  fileDrop('character2Drop', 'character2File', (file) => receiveUploadedCharacter(file, true));
  $('loadDemo').onclick = () => loadDemo('orange');
  $('loadFictional').onclick = () => loadDemo('fictional');
  $('chooseSource').onclick = () => $('sourceFile').click(); $('replaceSource').onclick = () => $('sourceFile').click();
  $('chooseCharacter').onclick = () => $('characterFile').click(); $('replaceCharacter').onclick = () => $('characterFile').click();
  $('chooseCharacter2').onclick = () => $('character2File').click(); $('replaceCharacter2').onclick = () => $('character2File').click();
  $('characterPreviewButton').onclick = () => previewCharacterFace();
  $('character2PreviewButton').onclick = () => previewCharacterFace(true);
  $('facePreviewClose').onclick = () => $('facePreviewDialog').close();
  $('removeCharacter2').onclick = () => { const reuseGuide = !!prepared && selectedMode() === 'person-mask'; faceLoadId.right++; faceRenderId.right++; selectedFaces.right = null; character2 = null; character2Input = ''; if (character2Url) URL.revokeObjectURL(character2Url); if (character2RawUrl) URL.revokeObjectURL(character2RawUrl); character2Url = ''; character2RawUrl = ''; $('character2File').value = ''; $('character2Drop').classList.remove('has-file'); $('character2Loaded').classList.add('hide'); $('character2PreviewButton').disabled = true; $('character2Status').textContent = ''; if (reuseGuide) clearResults(); else clearPrepared(); updateFacePicker(); readyToPrepare(); readyToGenerate(); };
  $('start').oninput = () => { resetSceneDescription(true); renderRange(); };
  $('length').onchange = () => { resetSceneDescription(true); renderRange(); modelOptions(); clearPrepared(); };
  $('setStart').onclick = () => { $('start').value = $('sourcePreview').currentTime.toFixed(1); resetSceneDescription(true); renderRange(); };
  $('setEnd').onclick = () => { const start = Number($('start').value) || 0; const seconds = Math.round($('sourcePreview').currentTime - start); if (seconds >= 4 && seconds <= maxClipSeconds()) $('length').value = String(seconds); resetSceneDescription(true); renderRange(); modelOptions(); };
  document.querySelectorAll('input[name=mode]').forEach((input) => { input.onchange = () => { if (prepared) clearPrepared(); }; });
  $('sceneDescription').oninput = () => { sceneEdited = true; $('sceneStatus').textContent = 'Your description is saved.'; };
  $('prepare').onclick = prepare; $('prepareAgain').onclick = prepare;
  $('storageToggle').onclick = () => $('storageForm').classList.toggle('hide');
  $('closeS3').onclick = () => $('storageForm').classList.add('hide');
  $('saveS3').onclick = saveStorage; $('removeS3').onclick = removeStorage;
  $('reviewed').onchange = readyToGenerate; $('publicUrl').oninput = readyToGenerate;
  $('draftModel').onchange = () => { resolutionOptions('draft'); readyToGenerate(); };
  $('finalModel').onchange = () => { resolutionOptions('final'); readyToGenerate(); };
  $('makeDraft').onclick = () => generate('draft'); $('makeFinal').onclick = () => generate('final');
  modelOptions(); readyToPrepare();
  for (const stage of ['draft','final']) {
    const id = sessionStorage.getItem(`justimagine:scene-remix:${stage}`);
    if (id) pollJob(id, stage).catch((error) => errorText('draftError', remixErrorMessage(error.message)));
  }
}

boot();
