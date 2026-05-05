import type { Clip } from "../types/project";
import type { Segment, SegmentManifest } from "./types";

export type SegmentEditType =
  | "clip-add"
  | "clip-update"
  | "clip-delete"
  | "timeline"
  | "dimensions"
  | "playback-quality"
  | "full";

interface SegmentRange {
  startTime: number;
  endTime: number;
}

function normalizeSegmentIndexes(segments: Segment[]): Segment[] {
  return segments.map((segment, index) => ({
    ...segment,
    index,
  }));
}

function cloneSegment(
  segment: Segment,
  overrides: Partial<Segment>,
): Segment {
  return {
    ...segment,
    ...overrides,
  };
}

function durationOf(range: SegmentRange): number {
  return Math.max(0, range.endTime - range.startTime);
}

export function createInitialManifest(
  duration: number,
  outputDims: { width: number; height: number },
  fps: number,
  signature: string,
): SegmentManifest {
  return {
    segments: [
      {
        index: 0,
        startTime: 0,
        endTime: Math.max(0, duration),
        file: null,
        dirty: true,
        fileStartTime: null,
        fileEndTime: null,
      },
    ],
    outputWidth: outputDims.width,
    outputHeight: outputDims.height,
    fps,
    requestSignature: signature,
  };
}

export function computeDirtyRange(
  editType: SegmentEditType,
  affectedClip: Pick<Clip, "startTime" | "duration"> | null,
): [number, number] {
  if (editType === "full" || editType === "timeline" || editType === "dimensions") {
    return [0, Number.POSITIVE_INFINITY];
  }

  if (editType === "playback-quality" || !affectedClip) {
    return [0, Number.POSITIVE_INFINITY];
  }

  return [
    Math.max(0, affectedClip.startTime),
    Math.max(affectedClip.startTime, affectedClip.startTime + affectedClip.duration),
  ];
}

export function markDirty(
  manifest: SegmentManifest,
  start: number,
  end: number,
): SegmentManifest {
  const dirtyStart = Math.max(0, start);
  const dirtyEnd = Math.max(dirtyStart, end);
  const nextSegments: Segment[] = [];

  for (const segment of manifest.segments) {
    if (segment.endTime <= dirtyStart || segment.startTime >= dirtyEnd) {
      nextSegments.push({ ...segment });
      continue;
    }

    if (segment.startTime < dirtyStart) {
      nextSegments.push(
        cloneSegment(segment, {
          startTime: segment.startTime,
          endTime: dirtyStart,
        }),
      );
    }

    nextSegments.push(
      cloneSegment(segment, {
        startTime: Math.max(segment.startTime, dirtyStart),
        endTime: Math.min(segment.endTime, dirtyEnd),
        file: null,
        dirty: true,
        fileStartTime: null,
        fileEndTime: null,
      }),
    );

    if (segment.endTime > dirtyEnd) {
      nextSegments.push(
        cloneSegment(segment, {
          startTime: dirtyEnd,
          endTime: segment.endTime,
        }),
      );
    }
  }

  return {
    ...manifest,
    segments: normalizeSegmentIndexes(nextSegments),
  };
}

export function getNextDirtySegment(manifest: SegmentManifest): Segment | null {
  return manifest.segments.find((segment) => segment.dirty) ?? null;
}

export function markRendered(
  manifest: SegmentManifest,
  segmentIndex: number,
  file: string,
): SegmentManifest {
  return {
    ...manifest,
    segments: manifest.segments.map((segment) =>
      segment.index === segmentIndex
        ? {
            ...segment,
            file,
            dirty: false,
            fileStartTime: segment.startTime,
            fileEndTime: segment.endTime,
          }
        : { ...segment },
    ),
  };
}

export function buildConcatList(manifest: SegmentManifest): string[] {
  return manifest.segments
    .filter((segment) => !segment.dirty && segment.file != null)
    .map((segment) => segment.file as string);
}

export function computeOverallProgress(manifest: SegmentManifest): number {
  const totalDuration = manifest.segments.reduce(
    (sum, segment) => sum + durationOf(segment),
    0,
  );
  if (totalDuration <= 0) {
    return 100;
  }

  const renderedDuration = manifest.segments.reduce(
    (sum, segment) =>
      sum +
      (!segment.dirty && segment.file != null ? durationOf(segment) : 0),
    0,
  );

  return Math.min(100, Math.max(0, (renderedDuration / totalDuration) * 100));
}
