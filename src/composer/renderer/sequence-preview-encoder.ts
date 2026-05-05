import { renderFrame, type CompositorCanvas, type CompositorRenderingContext2D } from "./canvas-compositor";
import type {
  RenderSegmentProgress,
  RenderSegmentRequest,
  RenderSegmentResult,
  RuntimeCompositorLayer,
} from "../shared/types";

interface MediabunnyModule {
  Output?: new (options: Record<string, unknown>) => {
    addVideoTrack?: (track: unknown) => unknown;
    addAudioTrack?: (track: unknown) => unknown;
    start?: () => Promise<void> | void;
    finalize?: () => Promise<void> | void;
    target?: { buffer?: Uint8Array | ArrayBuffer };
  };
  Mp4OutputFormat?: new () => unknown;
  BufferTarget?: new () => { buffer?: Uint8Array | ArrayBuffer };
  CanvasSource?: new (
    canvas: CompositorCanvas,
    options: Record<string, unknown>,
  ) => {
    add?: (time: number, duration: number) => Promise<void> | void;
    addFrame?: (time: number, duration: number) => Promise<void> | void;
    append?: (time: number, duration: number) => Promise<void> | void;
  };
  AudioSource?: new (options: Record<string, unknown>) => {
    add?: (...args: unknown[]) => Promise<void> | void;
  };
  QUALITY_MEDIUM?: unknown;
}

export interface EncodeSequencePreviewSegmentOptions {
  request: RenderSegmentRequest;
  canvas: CompositorCanvas;
  ctx: CompositorRenderingContext2D;
  resolveLayersAtTime: (time: number) => Promise<RuntimeCompositorLayer[]>;
  onProgress?: (progress: RenderSegmentProgress) => void;
  signal?: AbortSignal;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The render was cancelled.", "AbortError");
  }
}

async function loadMediabunny(): Promise<MediabunnyModule> {
  const moduleName = "mediabunny";
  return (await import(/* @vite-ignore */ moduleName)) as MediabunnyModule;
}

function normalizeUint8Array(
  value: Uint8Array | ArrayBuffer | undefined,
): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return new Uint8Array();
}

async function appendCanvasFrame(
  canvasSource: {
    add?: (time: number, duration: number) => Promise<void> | void;
    addFrame?: (time: number, duration: number) => Promise<void> | void;
    append?: (time: number, duration: number) => Promise<void> | void;
  },
  time: number,
  duration: number,
): Promise<void> {
  if (canvasSource.add) {
    await canvasSource.add(time, duration);
    return;
  }

  if (canvasSource.addFrame) {
    await canvasSource.addFrame(time, duration);
    return;
  }

  if (canvasSource.append) {
    await canvasSource.append(time, duration);
    return;
  }

  throw new Error("Unsupported Mediabunny CanvasSource frame API.");
}

export async function encodeSequencePreviewSegment({
  request,
  canvas,
  ctx,
  resolveLayersAtTime,
  onProgress,
  signal,
}: EncodeSequencePreviewSegmentOptions): Promise<RenderSegmentResult> {
  const mediabunny = await loadMediabunny();
  const {
    Output,
    Mp4OutputFormat,
    BufferTarget,
    CanvasSource,
    QUALITY_MEDIUM,
  } = mediabunny;

  if (!Output || !Mp4OutputFormat || !BufferTarget || !CanvasSource) {
    throw new Error(
      "Mediabunny is missing Output/Mp4OutputFormat/BufferTarget/CanvasSource exports.",
    );
  }

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat(),
    target,
  });
  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    bitrate: QUALITY_MEDIUM,
    width: request.outputWidth,
    height: request.outputHeight,
    frameRate: request.fps,
  });

  output.addVideoTrack?.(videoSource);
  await output.start?.();

  const totalFrames = Math.max(
    1,
    Math.ceil((request.endTime - request.startTime) * request.fps),
  );

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    assertNotAborted(signal);
    const frameTime = request.startTime + frameIndex / request.fps;
    const layers = await resolveLayersAtTime(frameTime);

    renderFrame(ctx, canvas, layers, frameTime);
    await appendCanvasFrame(videoSource, frameTime, 1 / request.fps);

    onProgress?.({
      segmentIndex: request.segmentIndex,
      frameIndex: frameIndex + 1,
      totalFrames,
      percent: ((frameIndex + 1) / totalFrames) * 100,
    });
  }

  await output.finalize?.();

  return {
    buffer: normalizeUint8Array(output.target?.buffer ?? target.buffer),
    frameCount: totalFrames,
    mimeType: "video/mp4",
  };
}
