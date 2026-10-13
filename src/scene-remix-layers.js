// Keep the source setting in color while replacing each detected person with depth.
// The slightly expanded edge keeps the old appearance from leaking around hair.
export function compositePersonDepth(source, depth, mask, width, height) {
  if (!mask?.width || !mask?.height || !mask.getAsFloat32Array) throw new Error('The person mask is missing.');
  const values = mask.getAsFloat32Array();
  const mw = mask.width, mh = mask.height;
  if (values.length !== mw * mh) throw new Error('The person mask has the wrong size.');
  const alpha = new Uint8Array(values.length);
  let subjectPixels = 0;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    let score = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(mh - 1, y + 1); yy++) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(mw - 1, x + 1); xx++) score = Math.max(score, values[yy * mw + xx]);
    }
    const amount = Math.max(0, Math.min(1, (score - .12) * 4));
    alpha[y * mw + x] = Math.round(amount * 255);
    if (amount > .5) subjectPixels++;
  }
  const output = depth.data, original = source.data;
  for (let y = 0; y < height; y++) {
    const my = Math.min(mh - 1, Math.floor(y * mh / height));
    for (let x = 0; x < width; x++) {
      const a = alpha[my * mw + Math.min(mw - 1, Math.floor(x * mw / width))];
      const at = (y * width + x) * 4;
      if (a === 255) continue;
      if (!a) { output[at] = original[at]; output[at + 1] = original[at + 1]; output[at + 2] = original[at + 2]; continue; }
      const b = 255 - a;
      for (let c = 0; c < 3; c++) output[at + c] = Math.round((output[at + c] * a + original[at + c] * b) / 255);
    }
  }
  return { coverage: subjectPixels / values.length };
}
