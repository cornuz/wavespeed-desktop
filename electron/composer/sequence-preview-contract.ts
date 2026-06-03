import type { ParsedCubeLut } from "../../src/composer/shared/luts";

export interface HeadlessRenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HeadlessRenderResolvedLut {
  assetId: string;
  cacheKey: string;
  lut: ParsedCubeLut;
}

export interface HeadlessRenderClip {
  id: string;
  sourcePath: string;
  inputKind: "image" | "media";
  startTime: number;
  duration: number;
  renderedDuration: number;
  trimStart: number;
  speed: number;
  createdAt: string;
  hasVisual: boolean;
  hasAudio: boolean;
  volume: number;
  rect: HeadlessRenderRect | null;
  opacity: number;
  blendMode: GlobalCompositeOperation | null;
  filter: string | null;
  blur: number;
  sharpen: number;
  noise: number;
  requestedLutAssetId: string | null;
  lutApplication: "none" | "cube-image";
  lut: HeadlessRenderResolvedLut | null;
  flipHorizontal: boolean;
  flipVertical: boolean;
  rotation: number;
  fadeInDuration: number;
  fadeOutDuration: number;
  sourceDuration: number | null;
}

export interface RenderSegmentRequest {
  projectId: string;
  requestSignature: string;
  playbackQuality: "full" | "high" | "med" | "low";
  backgroundColor: string;
  segmentId: string;
  segmentIndex: number;
  startTime: number;
  endTime: number;
  outputWidth: number;
  outputHeight: number;
  fps: number;
  clips: HeadlessRenderClip[];
}

export interface RenderSegmentProgress {
  projectId: string;
  requestSignature: string;
  segmentId: string;
  segmentIndex: number;
  frameIndex: number;
  totalFrames: number;
  percent: number;
}

export interface SequencePreviewProgressEvent {
  projectId: string;
  requestSignature: string;
  status: "processing" | "ready" | "error";
  overallPercent: number;
  segmentIndex: number | null;
  totalSegments: number;
  segmentPercent: number | null;
  frameIndex: number | null;
  totalFrames: number | null;
  updatedAt: string;
  errorMessage?: string;
}

export interface CachedSegment {
  id: string;
  index: number;
  startTime: number;
  endTime: number;
  file: string | null;
  dirty: boolean;
}

export interface SegmentManifest {
  requestSignature: string;
  duration: number;
  outputWidth: number;
  outputHeight: number;
  fps: number;
  segments: CachedSegment[];
}
