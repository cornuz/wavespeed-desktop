import type { Clip } from "@/composer/types/project";

export const MIN_CLIP_DURATION = 0.25;

export function getFrameDuration(fps: number): number {
  return 1 / fps;
}

export function snapTimeToFrame(value: number, fps: number): number {
  return Number((Math.round(Math.max(0, value) * fps) / fps).toFixed(6));
}

export function formatTimelineTime(value: number): string {
  const totalSeconds = Math.max(0, value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor((totalSeconds % 1) * 100);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${milliseconds
    .toString()
    .padStart(2, "0")}`;
}

export function getClipEnd(clip: Clip): number {
  return clip.startTime + clip.duration;
}

export function getTrimEnd(clip: Clip): number {
  return clip.trimEnd ?? 0;
}

export function getSnapThreshold(fps: number): number {
  return 10 / fps;
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

    const previousClip = [...otherClips]
      .reverse()
      .find((clip) => getClipEnd(clip) <= desiredStart + threshold);

    if (previousClip && Math.abs(nextStart - getClipEnd(previousClip)) <= threshold) {
      nextStart = getClipEnd(previousClip);
      continue;
    }

    nextStart =
      desiredStart >= overlappingClip.startTime
        ? getClipEnd(overlappingClip)
        : Math.max(0, overlappingClip.startTime - duration);
  }

  return snapTimeToFrame(nextStart, fps);
}
