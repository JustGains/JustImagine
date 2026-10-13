const MAX_FACE_EDGE = 2048;

export const DEFAULT_FACE_GRID = Object.freeze({
  columns: 6,
  rows: 6,
  lineWidth: 2,
  opacity: 100,
  color: '#FFFFFF',
  offsetX: 0,
  offsetY: 0,
  mosaicSize: 4,
  squiggle: false,
  squiggleAmount: 8
});

export function normalizeFaceGridSettings(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const integer = (key, min, max) => {
    const number = Number(input[key]);
    return input[key] == null || !Number.isFinite(number)
      ? DEFAULT_FACE_GRID[key]
      : Math.min(max, Math.max(min, Math.round(number)));
  };
  return {
    columns: integer('columns', 2, 20),
    rows: integer('rows', 2, 20),
    lineWidth: integer('lineWidth', 1, 32),
    opacity: integer('opacity', 0, 100),
    color: typeof input.color === 'string' && /^#[\da-f]{6}$/i.test(input.color) ? input.color.toUpperCase() : DEFAULT_FACE_GRID.color,
    offsetX: integer('offsetX', -100, 100),
    offsetY: integer('offsetY', -100, 100),
    mosaicSize: integer('mosaicSize', 0, 32),
    squiggle: input.squiggle === true,
    squiggleAmount: integer('squiggleAmount', 1, 25)
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function drawSquiggleLine(ctx, fixed, length, cellLength, amplitude, vertical, random) {
  const segments = Math.max(2, Math.ceil(length / (cellLength / 2)));
  const offsets = Array.from({ length: segments + 1 }, (_, index) => index === 0 || index === segments ? 0 : (random() * 2 - 1) * amplitude);
  if (vertical) ctx.moveTo(fixed, 0);
  else ctx.moveTo(0, fixed);
  for (let segment = 0; segment < segments; segment++) {
    for (let sample = 1; sample <= 12; sample++) {
      const fraction = sample / 12;
      const smooth = fraction * fraction * (3 - 2 * fraction);
      const position = length * (segment + fraction) / segments;
      const bend = offsets[segment] * (1 - smooth) + offsets[segment + 1] * smooth;
      if (vertical) ctx.lineTo(fixed + bend, position);
      else ctx.lineTo(position, fixed + bend);
    }
  }
}

export function drawFaceMosaic(ctx, bitmap, width, height, blockSize = DEFAULT_FACE_GRID.mosaicSize) {
  if (blockSize < 2) {
    ctx.drawImage(bitmap, 0, 0, width, height);
    return;
  }
  const blocks = document.createElement('canvas');
  blocks.width = Math.max(1, Math.ceil(width / blockSize));
  blocks.height = Math.max(1, Math.ceil(height / blockSize));
  const blockCtx = blocks.getContext('2d');
  if (!blockCtx) throw new Error('Could not prepare the face mosaic.');
  blockCtx.imageSmoothingEnabled = true;
  blockCtx.imageSmoothingQuality = 'high';
  blockCtx.drawImage(bitmap, 0, 0, blocks.width, blocks.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(blocks, 0, 0, width, height);
  ctx.restore();
}

export function drawFaceGrid(ctx, width, height, settings = DEFAULT_FACE_GRID, seed = 0) {
  const grid = normalizeFaceGridSettings(settings);
  const cellWidth = width / grid.columns;
  const cellHeight = height / grid.rows;
  const shiftX = cellWidth * grid.offsetX / 100;
  const shiftY = cellHeight * grid.offsetY / 100;
  const random = seededRandom(seed);
  ctx.save();
  ctx.strokeStyle = grid.color;
  ctx.lineWidth = grid.lineWidth;
  ctx.globalAlpha = grid.opacity / 100;
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let column = -1; column <= grid.columns + 1; column++) {
    const x = column * cellWidth + shiftX;
    if (x > 0 && x < width) {
      if (grid.squiggle) drawSquiggleLine(ctx, x, height, cellHeight, cellWidth * grid.squiggleAmount / 100, true, random);
      else { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
    }
  }
  for (let row = -1; row <= grid.rows + 1; row++) {
    const y = row * cellHeight + shiftY;
    if (y > 0 && y < height) {
      if (grid.squiggle) drawSquiggleLine(ctx, y, width, cellWidth, cellHeight * grid.squiggleAmount / 100, false, random);
      else { ctx.moveTo(0, y); ctx.lineTo(width, y); }
    }
  }
  ctx.stroke();
  const inset = Math.min(grid.lineWidth / 2, width / 2, height / 2);
  ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2);
  ctx.restore();
}

export async function gridFaceFile(file, settings = DEFAULT_FACE_GRID, seed = 0) {
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('The face image has no pixels.');
    const scale = Math.min(1, MAX_FACE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare the face image.');
    const grid = normalizeFaceGridSettings(settings);
    drawFaceMosaic(ctx, bitmap, canvas.width, canvas.height, grid.mosaicSize);
    drawFaceGrid(ctx, canvas.width, canvas.height, grid, seed);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not save the face grid.');
    if (blob.size > 32 * 1024 * 1024) throw new Error('The gridded face is over 32 MB. Choose a smaller image.');
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-grid.png`, { type: 'image/png' });
  } finally {
    bitmap.close?.();
  }
}
