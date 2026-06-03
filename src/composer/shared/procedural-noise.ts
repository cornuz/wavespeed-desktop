const NOISE_MIN = 0;
const NOISE_MAX = 100;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function hashUint32(value: number): number {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function normalizeNoiseAmount(value: number): number {
  return clamp(value, NOISE_MIN, NOISE_MAX);
}

export function getNoiseSeed(source: string): number {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function getNoiseByte(
  seed: number,
  frameIndex: number,
  x: number,
  y: number,
): number {
  const frameSeed = hashUint32(
    seed ^ Math.imul((Math.max(0, Math.round(frameIndex)) + 1) >>> 0, 0x9e3779b1),
  );
  const mixed =
    frameSeed ^
    Math.imul((x + 1) >>> 0, 374761393) ^
    Math.imul((y + 1) >>> 0, 668265263);
  return hashUint32(mixed) & 255;
}

export function paintNoiseCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  seed: number,
  frameIndex: number,
): void {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const imageData = context.createImageData(canvas.width, canvas.height);
  const { data } = imageData;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4;
      const gray = getNoiseByte(seed, frameIndex, x, y);
      data[index] = gray;
      data[index + 1] = gray;
      data[index + 2] = gray;
      data[index + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
}
