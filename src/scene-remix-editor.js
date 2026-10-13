// Local motion-guide preparation. The browser decodes, tracks, composites,
// trims, and encodes; no frames or audio are sent to an inference service here.
import { loadDepthEstimator, paintDepthMap } from './scene-remix-depth.js';
import { compositePersonDepth } from './scene-remix-layers.js';
const FPS = 24;
let mediabunny;
let vision;
const media = () => (mediabunny ||= import('./vendor/mediabunny.js'));
const tasks = () => (vision ||= import('./vendor/mediapipe/vision_bundle.mjs'));
const WASM = '/assets/vendor/mediapipe/wasm';
const FACE_MODEL = '/assets/vendor/mediapipe/models/face_landmarker.task';
const PERSON_MODEL = '/assets/vendor/mediapipe/models/selfie_segmenter.tflite';

export const canPrepareScene = () => typeof VideoEncoder === 'function' && typeof AudioEncoder === 'function' && !!navigator.gpu && window.isSecureContext;

function outputSize(width, height, aspectRatio) {
  const [a, b] = aspectRatio.split(':').map(Number);
  const ratio = a / b;
  const max = Math.min(960, Math.max(width, height));
  const outWidth = ratio >= 1 ? max : Math.round(max * ratio);
  const outHeight = ratio >= 1 ? Math.round(max / ratio) : max;
  return { width: Math.max(2, Math.round(outWidth / 2) * 2), height: Math.max(2, Math.round(outHeight / 2) * 2) };
}

function cover(ctx, source, width, height) {
  const sw = source.width || source.videoWidth, sh = source.height || source.videoHeight;
  const scale = Math.max(width / sw, height / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

function mesh(ctx, points, connections, width, height) {
  ctx.save();
  ctx.strokeStyle = 'rgba(22, 232, 246, .9)';
  ctx.lineWidth = Math.max(1, width / 560);
  for (const line of connections) {
    const a = points[line.start], b = points[line.end];
    if (!a || !b) continue;
    ctx.beginPath(); ctx.moveTo(a.x * width, a.y * height); ctx.lineTo(b.x * width, b.y * height); ctx.stroke();
  }
  ctx.restore();
}

async function sourceAudio(MB, track, start, seconds, signal) {
  const sink = new MB.AudioBufferSink(track);
  const pieces = [];
  let rate = 0, channels = 0;
  for await (const piece of sink.buffers(start, start + seconds)) {
    if (signal?.aborted) throw new Error('Preparation stopped.');
    rate ||= piece.buffer.sampleRate;
    channels ||= Math.min(piece.buffer.numberOfChannels, 2);
    pieces.push(piece);
  }
  if (!rate || !channels) throw new Error('The selected clip has no decodable audio.');
  const length = Math.round(seconds * rate);
  const arrays = Array.from({ length: channels }, () => new Float32Array(length));
  for (const { buffer, timestamp } of pieces) {
    const from = Math.max(0, Math.round((timestamp - start) * rate));
    const skip = Math.max(0, Math.round((start - timestamp) * rate));
    const count = Math.min(buffer.length - skip, length - from);
    if (count <= 0) continue;
    for (let c = 0; c < channels; c++) arrays[c].set(buffer.getChannelData(c).subarray(skip, skip + count), from);
  }
  return { arrays, rate, channels, length };
}

export async function prepareSceneClip({ file, start, seconds, mode, aspectRatio, expectedFaces = 1, signal, onProgress = () => {}, onSceneFrames = () => {} }) {
  if (!canPrepareScene()) throw new Error('Use Chrome or Edge with WebGPU on a secure page to prepare this clip in your browser.');
  if (!(seconds >= 4 && seconds <= 30 && Number.isInteger(seconds))) throw new Error('Choose a whole number of seconds from 4 to 30.');
  const MB = await media();
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  let face, segmenter;
  try {
    const track = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) throw new Error('This browser cannot decode the video. Try an H.264 MP4.');
    if (!audioTrack || !(await audioTrack.canDecode())) throw new Error('Use a clip with a decodable audio track.');
    const duration = await input.computeDuration([track, audioTrack]);
    if (start < 0 || start + seconds > duration + 0.08) throw new Error('The selected range runs past the end of the clip.');
    const size = outputSize(await track.getDisplayWidth(), await track.getDisplayHeight(), aspectRatio);
    const codec = await MB.getFirstEncodableVideoCodec(['avc'], size);
    if (!codec) throw new Error('This browser cannot encode H.264 MP4 video. Try Chrome or Edge on a computer.');
    let MP, files;
    if (mode === 'face-mesh' || mode === 'combined') {
      onProgress({ phase: 'Loading face tracker', fraction: 0 });
      MP = await tasks();
      files = await MP.FilesetResolver.forVisionTasks(WASM);
      face = await MP.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' }, runningMode: 'VIDEO', numFaces: Math.min(Math.max(expectedFaces, 1), 2)
      });
    }
    const layered = mode !== 'depth-only';
    if (layered) {
      onProgress({ phase: 'Loading person mask', fraction: 0 });
      MP ||= await tasks();
      files ||= await MP.FilesetResolver.forVisionTasks(WASM);
      segmenter = await MP.ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: PERSON_MODEL, delegate: 'CPU' }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false
      });
    }
    onProgress({ phase: 'Loading local depth model', fraction: 0 });
    const estimateDepth = await loadDepthEstimator();
    onProgress({ phase: 'Reading original audio', fraction: 0 });
    const audioData = await sourceAudio(MB, audioTrack, start, seconds, signal);
    const audioCodec = await MB.getFirstEncodableAudioCodec(['aac'], { numberOfChannels: audioData.channels, sampleRate: audioData.rate });
    if (!audioCodec) throw new Error('This browser cannot encode the original audio as AAC.');
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const sample = document.createElement('canvas');
    sample.width = Math.min(480, size.width); sample.height = Math.round(size.height * sample.width / size.width);
    const sampleCtx = sample.getContext('2d');
    const maskCanvas = layered ? document.createElement('canvas') : null;
    if (maskCanvas) { maskCanvas.width = Math.min(384, size.width); maskCanvas.height = Math.round(size.height * maskCanvas.width / size.width); }
    const maskCtx = maskCanvas?.getContext('2d');
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
    const video = new MB.CanvasSource(canvas, { codec, bitrate: MB.QUALITY_HIGH, keyFrameInterval: 2 });
    const audio = new MB.AudioBufferSource({ codec: audioCodec, bitrate: MB.QUALITY_HIGH });
    output.addVideoTrack(video, { frameRate: FPS }); output.addAudioTrack(audio);
    await output.start();
    let heard = 0;
    const hearUntil = async (secondsWanted) => {
      while (heard < Math.min(secondsWanted, seconds) - 1e-6) {
        const count = Math.min(audioData.rate, audioData.length - Math.round(heard * audioData.rate));
        if (count <= 0) break;
        const part = new AudioBuffer({ length: count, numberOfChannels: audioData.channels, sampleRate: audioData.rate });
        for (let c = 0; c < audioData.channels; c++) part.copyToChannel(audioData.arrays[c].subarray(Math.round(heard * audioData.rate), Math.round(heard * audioData.rate) + count), c);
        await audio.add(part);
        heard += count / audioData.rate;
      }
    };
    const sink = new MB.CanvasSink(track, { width: size.width, height: size.height, fit: 'cover', poolSize: 2 });
    const frames = seconds * FPS;
    const times = Array.from({ length: frames }, (_, i) => start + i / FPS);
    const connections = face ? [...(MP.FaceLandmarker.FACE_LANDMARKS_FACE_OVAL || []), ...(MP.FaceLandmarker.FACE_LANDMARKS_LIPS || []),
      ...(MP.FaceLandmarker.FACE_LANDMARKS_LEFT_EYE || []), ...(MP.FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE || []),
      ...(MP.FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW || []), ...(MP.FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW || [])] : [];
    let gaps = 0, maskGaps = 0, maskGapRun = 0, maxMaskGapRun = 0, personMaskGaps = 0, personMaskRun = 0, maxPersonMaskRun = 0, personCoverage = 0;
    let done = 0, poster = '', backgroundColor = '';
    const sceneFrames = [];
    const maskLabels = segmenter?.getLabels?.() || [];
    for await (const frame of sink.canvasesAtTimestamps(times)) {
      if (signal?.aborted) throw new Error('Preparation stopped.');
      if (!frame) throw new Error(`Could not decode frame ${done + 1}. Try another MP4.`);
      cover(ctx, frame.canvas, size.width, size.height);
      if (done === 0 || done === Math.floor(frames / 2)) {
        sampleCtx.drawImage(canvas, 0, 0, sample.width, sample.height);
        sceneFrames.push(sample.toDataURL('image/jpeg', .72));
        if (sceneFrames.length === 2) onSceneFrames([...sceneFrames]);
      }
      if (done === 0) {
        const a = ctx.getImageData(Math.round(size.width * .02), Math.round(size.height * .03), 1, 1).data;
        const b = ctx.getImageData(Math.round(size.width * .98), Math.round(size.height * .03), 1, 1).data;
        if (Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i]))) < 60) {
          backgroundColor = `#${[0, 1, 2].map((i) => Math.round((a[i] + b[i]) / 2).toString(16).padStart(2, '0')).join('')}`;
        }
      }
      let original, result;
      if (segmenter) {
        original = ctx.getImageData(0, 0, size.width, size.height);
        maskCtx.drawImage(canvas, 0, 0, maskCanvas.width, maskCanvas.height);
        result = segmenter.segmentForVideo(maskCanvas, Math.round(done * 1000 / FPS));
      }
      const depth = await estimateDepth(canvas);
      const { contrast, image } = paintDepthMap(ctx, depth, size.width, size.height);
      if (segmenter) {
        const masks = result?.confidenceMasks || [];
        const labeled = maskLabels.findIndex((label) => /person/i.test(label));
        const mask = masks[labeled >= 0 ? labeled : masks.length - 1];
        try {
          const { coverage } = compositePersonDepth(original, image, mask, size.width, size.height);
          personCoverage += coverage;
          if (coverage < .005 || coverage > .9) { personMaskGaps++; personMaskRun++; maxPersonMaskRun = Math.max(maxPersonMaskRun, personMaskRun); }
          else personMaskRun = 0;
          ctx.putImageData(image, 0, 0);
        } finally { masks.forEach((item) => item.close?.()); result?.categoryMask?.close?.(); }
      }
      if (contrast < 20) { maskGaps++; maskGapRun++; maxMaskGapRun = Math.max(maxMaskGapRun, maskGapRun); }
      else maskGapRun = 0;
      if (face) {
        const result = face.detectForVideo(frame.canvas, Math.round(done * 1000 / FPS));
        for (const landmarks of result.faceLandmarks || []) mesh(ctx, landmarks, connections, size.width, size.height);
        if ((result.faceLandmarks?.length || 0) < expectedFaces) gaps++;
      }
      if (done === 0) poster = canvas.toDataURL('image/jpeg', .88);
      await hearUntil((done + 1) / FPS + 0.5);
      await video.add(done / FPS, 1 / FPS);
      done++;
      if (done % 8 === 0 || done === frames) onProgress({ phase: 'Estimating depth', fraction: done / frames });
    }
    if (done !== frames) throw new Error(`Only ${done} of ${frames} frames decoded.`);
    await hearUntil(seconds);
    video.close(); audio.close();
    onProgress({ phase: 'Finishing MP4', fraction: 1 });
    await output.finalize();
    return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), poster, sceneFrames,
      stats: { frames, faceGaps: gaps, maskGaps, maxMaskGapRun, personMaskGaps, maxPersonMaskRun, personCoverage: frames ? personCoverage / frames : 0,
        backgroundColor, width: size.width, height: size.height, seconds } };
  } finally {
    face?.close?.(); segmenter?.close?.(); input.dispose?.();
  }
}
