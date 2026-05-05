import { buildCompositorLayers } from "../shared/compositor-layers";
import type {
  CompositorLayer,
  CompositorLayerSource,
  RenderSegmentProgress,
  RenderSegmentRequest,
  RenderSegmentResult,
  RuntimeCompositorLayer,
} from "../shared/types";
import { encodeSequencePreviewSegment } from "./sequence-preview-encoder";
import type {
  CompositorCanvas,
  CompositorRenderingContext2D,
} from "./canvas-compositor";

export const HEADLESS_RENDERER_CHANNELS = {
  renderSegment: "composer:render-segment",
  cancelRender: "composer:cancel-render",
  segmentProgress: "composer:segment-progress",
} as const;

export interface HeadlessRendererBridge {
  onRenderSegment: (
    handler: (request: RenderSegmentRequest) => Promise<RenderSegmentResult>,
  ) => void;
  onCancelRender: (handler: () => void) => void;
  sendProgress: (progress: RenderSegmentProgress) => void;
}

export interface HeadlessRendererEnvironment {
  canvas: CompositorCanvas;
  ctx: CompositorRenderingContext2D;
}

function toLocalAssetUrl(source: CompositorLayerSource): string {
  return source.sourceUrl ?? `local-asset://${encodeURIComponent(source.sourcePath)}`;
}

function createImageSource(source: CompositorLayerSource): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "sync";
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`Failed to load image source: ${source.sourcePath}`));
    image.src = toLocalAssetUrl(source);
  });
}

function createVideoSource(source: CompositorLayerSource): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () =>
      reject(new Error(`Failed to load video source: ${source.sourcePath}`));
    video.src = toLocalAssetUrl(source);
  });
}

async function loadMediaElements(
  sources: CompositorLayerSource[],
): Promise<Map<string, HTMLImageElement | HTMLVideoElement>> {
  const entries = await Promise.all(
    sources.map(async (source) => [
      source.clipId,
      source.kind === "image"
        ? await createImageSource(source)
        : await createVideoSource(source),
    ] as const),
  );

  return new Map(entries);
}

async function seekVideoElements(
  layers: CompositorLayer[],
  elementsByClipId: Map<string, HTMLImageElement | HTMLVideoElement>,
): Promise<void> {
  const pending = layers.flatMap((layer) => {
    const element = elementsByClipId.get(layer.clipId);
    if (!(element instanceof HTMLVideoElement)) {
      return [];
    }

    const targetTime = Math.max(0, layer.sourceTime);
    if (
      Number.isFinite(element.currentTime) &&
      Math.abs(element.currentTime - targetTime) < 1 / 120
    ) {
      return [];
    }

    return [
      new Promise<void>((resolve) => {
        const handleSeeked = () => {
          element.removeEventListener("seeked", handleSeeked);
          resolve();
        };

        element.addEventListener("seeked", handleSeeked, { once: true });
        element.currentTime = targetTime;
      }),
    ];
  });

  await Promise.all(pending);
}

function buildLayerMap(
  sources: CompositorLayerSource[] | undefined,
): Map<string, CompositorLayerSource> {
  return new Map((sources ?? []).map((source) => [source.clipId, source]));
}

function buildLayersForTime(
  request: RenderSegmentRequest,
  time: number,
): CompositorLayer[] {
  if (request.layers) {
    return request.layers;
  }

  if (
    !request.tracks ||
    !request.clips ||
    !request.sources ||
    request.projectWidth == null ||
    request.projectHeight == null
  ) {
    throw new Error(
      "RenderSegmentRequest must provide either layers or tracks/clips/sources/project dimensions.",
    );
  }

  return buildCompositorLayers(
    request.tracks,
    request.clips,
    time,
    {
      width: request.outputWidth,
      height: request.outputHeight,
    },
    {
      sourcesByClipId: buildLayerMap(request.sources),
      projectDims: {
        width: request.projectWidth,
        height: request.projectHeight,
      },
    },
  );
}

function hydrateLayers(
  layers: CompositorLayer[],
  elementsByClipId: Map<string, HTMLImageElement | HTMLVideoElement>,
): RuntimeCompositorLayer[] {
  return layers.flatMap((layer) => {
    const source = elementsByClipId.get(layer.clipId);
    if (!source) {
      return [];
    }

    return [
      {
        ...layer,
        source,
      },
    ];
  });
}

export function registerHeadlessRendererIpcHandlers(
  bridge: HeadlessRendererBridge,
  environment: HeadlessRendererEnvironment,
): void {
  let abortController: AbortController | null = null;

  bridge.onCancelRender(() => {
    abortController?.abort();
  });

  bridge.onRenderSegment(async (request) => {
    abortController?.abort();
    abortController = new AbortController();

    const layerSources = request.sources ?? request.layers?.map((layer) => layer.source) ?? [];
    const elementsByClipId = await loadMediaElements(layerSources);

    return encodeSequencePreviewSegment({
      request,
      canvas: environment.canvas,
      ctx: environment.ctx,
      signal: abortController.signal,
      onProgress: (progress) => bridge.sendProgress(progress),
      resolveLayersAtTime: async (time) => {
        const layers = buildLayersForTime(request, time);
        await seekVideoElements(layers, elementsByClipId);
        return hydrateLayers(layers, elementsByClipId);
      },
    });
  });
}
