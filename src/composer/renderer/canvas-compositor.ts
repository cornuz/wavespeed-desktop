import type { RuntimeCompositorLayer } from "../shared/types";

export type CompositorCanvas = HTMLCanvasElement | OffscreenCanvas;
export type CompositorRenderingContext2D =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

export function computeLayerAlpha(
  layer: Pick<RuntimeCompositorLayer, "opacity" | "fadeIn" | "fadeOut">,
  time: number,
): number {
  let alpha = clamp(layer.opacity, 0, 1);

  if (layer.fadeIn && layer.fadeIn.duration > 0) {
    alpha *= clamp((time - layer.fadeIn.start) / layer.fadeIn.duration, 0, 1);
  }

  if (layer.fadeOut && layer.fadeOut.duration > 0) {
    alpha *= clamp((layer.fadeOut.start + layer.fadeOut.duration - time) / layer.fadeOut.duration, 0, 1);
  }

  return alpha;
}

export function renderFrame(
  ctx: CompositorRenderingContext2D,
  canvas: CompositorCanvas,
  layers: RuntimeCompositorLayer[],
  time: number,
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  for (const layer of layers) {
    ctx.save();
    ctx.globalCompositeOperation = layer.blendMode;
    ctx.globalAlpha = computeLayerAlpha(layer, time);
    ctx.filter = layer.filter;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const cx = layer.rect.x + layer.rect.width / 2;
    const cy = layer.rect.y + layer.rect.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.drawImage(
      layer.source,
      -layer.rect.width / 2,
      -layer.rect.height / 2,
      layer.rect.width,
      layer.rect.height,
    );
    ctx.restore();
  }
}
