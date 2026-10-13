// The model and runtime are served by JustImagine. Frames stay in this browser.
let estimatorPromise;

export function loadDepthEstimator() {
  if (!navigator.gpu) throw new Error('Depth preparation needs WebGPU. Open this page in a current Chrome or Edge browser.');
  estimatorPromise ||= (async () => {
    const { pipeline, env, RawImage } = await import('/assets/vendor/depth/depth-transformers.js');
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = '/assets/vendor/depth/';
    env.backends.onnx.wasm.wasmPaths = '/assets/vendor/depth/wasm/';
    const model = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', { device: 'webgpu', dtype: 'q4f16' });
    return async (canvas) => (await model(RawImage.fromCanvas(canvas))).depth;
  })().catch((error) => { estimatorPromise = null; throw error; });
  return estimatorPromise;
}

export function paintDepthMap(ctx, depth, width, height) {
  if (!depth?.data?.length) throw new Error('Depth estimation did not return an image.');
  const image = ctx.createImageData(width, height);
  const histogram = new Uint32Array(256);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = Math.min(depth.width - 1, Math.floor(x * depth.width / width));
    const py = Math.min(depth.height - 1, Math.floor(y * depth.height / height));
    const value = depth.data[(py * depth.width + px) * depth.channels];
    const at = (y * width + x) * 4;
    image.data[at] = value;
    image.data[at + 1] = value;
    image.data[at + 2] = value;
    image.data[at + 3] = 255;
    histogram[value]++;
  }
  ctx.putImageData(image, 0, 0);
  const percentile = (fraction) => {
    let total = 0;
    for (let i = 0; i < 256; i++) { total += histogram[i]; if (total >= width * height * fraction) return i; }
    return 255;
  };
  return { contrast: percentile(.9) - percentile(.1), image };
}
