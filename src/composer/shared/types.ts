import type { Rect, Size } from "./compositionGeometry";
import type { Clip, Track } from "../types/project";

export interface CompositorLayerSource {
  clipId: string;
  sourceId: string;
  sourcePath: string;
  sourceUrl?: string;
  kind: "image" | "video";
  mediaSize: Size;
}

export interface CompositorLayerFade {
  start: number;
  duration: number;
}

export interface CompositorLayer {
  clipId: string;
  source: CompositorLayerSource;
  rect: Rect;
  blendMode: GlobalCompositeOperation;
  opacity: number;
  filter: string;
  flipHorizontal: boolean;
  flipVertical: boolean;
  rotation: number;
  sourceTime: number;
  fadeIn: CompositorLayerFade | null;
  fadeOut: CompositorLayerFade | null;
}

export interface RuntimeCompositorLayer
  extends Omit<CompositorLayer, "source"> {
  source: CanvasImageSource;
}

export interface Segment {
  index: number;
  startTime: number;
  endTime: number;
  file: string | null;
  dirty: boolean;
  fileStartTime: number | null;
  fileEndTime: number | null;
}

export interface SegmentManifest {
  segments: Segment[];
  outputWidth: number;
  outputHeight: number;
  fps: number;
  requestSignature: string;
}

export interface RenderSegmentAudioSource {
  id: string;
  sampleRate: number;
  numberOfChannels: number;
  frames: Float32Array[];
}

export interface RenderSegmentRequest {
  projectId: string;
  segmentIndex: number;
  startTime: number;
  endTime: number;
  layers?: CompositorLayer[];
  tracks?: Track[];
  clips?: Clip[];
  sources?: CompositorLayerSource[];
  audioSources?: RenderSegmentAudioSource[];
  outputWidth: number;
  outputHeight: number;
  projectWidth?: number;
  projectHeight?: number;
  fps: number;
  requestSignature: string;
}

export interface RenderSegmentProgress {
  segmentIndex: number;
  frameIndex: number;
  totalFrames: number;
  percent: number;
}

export interface RenderSegmentResult {
  buffer: Uint8Array;
  frameCount: number;
  mimeType: "video/mp4";
}
