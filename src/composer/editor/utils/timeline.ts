import type { Clip } from "@/composer/types/project";

export const MIN_CLIP_DURATION = 0.25;
export const TIMELINE_STEP_SECONDS = 0.1;

export function getFrameDuration(_fps: number): number {
  return TIMELINE_STEP_SECONDS;
}

export function snapTimeToFrame(value: number, _fps: number): number {
  return Number(
    (Math.round(Math.max(0, value) / TIMELINE_STEP_SECONDS) * TIMELINE_STEP_SECONDS).toFixed(6),
  );
}

export function formatTimelineTime(value: number): string {
  const roundedTenths = Math.max(0, Math.round(value * 10));
  const minutes = Math.floor(roundedTenths / 600);
  const seconds = Math.floor((roundedTenths % 600) / 10);
  const tenths = roundedTenths % 10;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
}

export function getClipEnd(clip: Clip): number {
  return clip.startTime + clip.duration;
}

export function getTrimEnd(clip: Clip): number {
  return clip.trimEnd ?? 0;
}

export function getSnapThreshold(_fps: number): number {
  return TIMELINE_STEP_SECONDS;
}

export function resolveTrackStart(
  desiredStart: number,
  duration: number,
  otherClips: Clip[],
  fps: number,
): number {
  const threshold = getSnapThreshold(fps);
  let nextStart = Math.max(0, desiredStart);

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const overlappingClip = otherClips.find(
      (clip) => nextStart < getClipEnd(clip) && nextStart + duration > clip.startTime,
    );
    if (!overlappingClip) {
      break;
    }

    const leftCandidate = Math.max(0, overlappingClip.startTime - duration);
    const rightCandidate = getClipEnd(overlappingClip);
    nextStart =
      Math.abs(nextStart - leftCandidate) <= Math.abs(nextStart - rightCandidate)
        ? leftCandidate
        : rightCandidate;
  }

  if (Math.abs(nextStart) <= threshold) {
    return 0;
  }

  for (const clip of otherClips) {
    const previousEdge = getClipEnd(clip);
    const nextEdge = clip.startTime - duration;
    if (Math.abs(nextStart - previousEdge) <= threshold) {
      return snapTimeToFrame(previousEdge, fps);
    }
    if (nextEdge >= 0 && Math.abs(nextStart - nextEdge) <= threshold) {
      return snapTimeToFrame(nextEdge, fps);
    }
  }

  return snapTimeToFrame(nextStart, fps);
}

