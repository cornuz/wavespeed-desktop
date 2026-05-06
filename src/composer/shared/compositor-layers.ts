import { getCanvasBlendMode } from "./blend-modes";
import { getUniversalClipRect, universalRectToScreen, type Size } from "./compositionGeometry";
import { buildCssFilter } from "./filter-builder";
import type { CompositorLayer, CompositorLayerSource } from "./types";
import type { Clip, Track } from "../types/project";

export interface BuildCompositorLayersOptions {
  sourcesByClipId?:
    | ReadonlyMap<string, CompositorLayerSource>
    | Record<string, CompositorLayerSource>;
  projectDims?: Size;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

export function clampOpacity(value: number): number {
  return clamp(value, 0, 1);
}

export function getClipLocalTime(
  playhead: number,
  clipStart: number,
  trimStart: number,
  speed = 1,
): number {
  return Math.max(0, (playhead - clipStart) * speed + trimStart);
}

function getSourceForClip(
  clipId: string,
  sourcesByClipId:
    | ReadonlyMap<string, CompositorLayerSource>
    | Record<string, CompositorLayerSource>
    | undefined,
): CompositorLayerSource | null {
  if (!sourcesByClipId) {
    return null;
  }

  if (sourcesByClipId instanceof Map) {
    return sourcesByClipId.get(clipId) ?? null;
  }

  return sourcesByClipId[clipId] ?? null;
}

function getActiveVisualClipsAtTime(
  clips: Clip[],
  tracks: Track[],
  time: number,
): Clip[] {
  const sortedVisibleVideoTrackIds = tracks
    .filter((track) => track.type === "video" && track.visible)
    .sort((left, right) => right.order - left.order)
    .map((track) => track.id);

  return sortedVisibleVideoTrackIds.flatMap((trackId) =>
    clips.filter(
      (clip) =>
        clip.trackId === trackId &&
        time >= clip.startTime &&
        time < clip.startTime + clip.duration,
    ),
  );
}

export function buildCompositorLayers(
  tracks: Track[],
  clips: Clip[],
  time: number,
  outputDims: Size,
  options: BuildCompositorLayersOptions = {},
): CompositorLayer[] {
  const viewScale = options.projectDims
    ? outputDims.width / options.projectDims.width
    : 1.0;

  return getActiveVisualClipsAtTime(clips, tracks, time)
    .map((clip) => {
      const source = getSourceForClip(clip.id, options.sourcesByClipId);
      if (!source) {
        return null;
      }

      const fadeInDuration = Math.min(Math.max(clip.fadeInDuration, 0), clip.duration);
      const fadeOutDuration = Math.min(Math.max(clip.fadeOutDuration, 0), clip.duration);

      return {
        clipId: clip.id,
        source,
        rect: universalRectToScreen(
          getUniversalClipRect(
            source.mediaSize,
            clip.transformOffsetX,
            clip.transformOffsetY,
            clip.transformScale,
          ),
          outputDims.width / 2,
          outputDims.height / 2,
          viewScale,
        ),
        blendMode: getCanvasBlendMode(clip.adjustments.blendMode),
        opacity: clampOpacity(clip.opacity),
        filter: buildCssFilter(clip.adjustments),
        flipHorizontal: clip.flipHorizontal,
        flipVertical: clip.flipVertical,
        rotation: clip.rotationZ,
        sourceTime: getClipLocalTime(
          time,
          clip.startTime,
          clip.trimStart,
          clip.speed,
        ),
        fadeIn:
          fadeInDuration > 0
            ? {
                start: clip.startTime,
                duration: fadeInDuration,
              }
            : null,
        fadeOut:
          fadeOutDuration > 0
            ? {
                start: clip.startTime + clip.duration - fadeOutDuration,
                duration: fadeOutDuration,
              }
            : null,
      } satisfies CompositorLayer;
    })
    .filter((layer): layer is CompositorLayer => layer != null);
}
