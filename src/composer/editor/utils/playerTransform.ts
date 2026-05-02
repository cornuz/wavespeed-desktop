import {
  getProjectScaledRect as getSharedProjectScaledRect,
  getTransformedRect as getSharedTransformedRect,
  type Rect,
  type Size,
} from "../../shared/compositionGeometry";

export type { Rect, Size } from "../../shared/compositionGeometry";

export interface SnapGuides {
  vertical: number[];
  horizontal: number[];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getContainRect(media: Size, frame: Size): Rect {
  const scale = Math.min(frame.width / media.width, frame.height / media.height);
  const width = media.width * scale;
  const height = media.height * scale;
  return {
    x: (frame.width - width) / 2,
    y: (frame.height - height) / 2,
    width,
    height,
  };
}

export const getProjectScaledRect = getSharedProjectScaledRect;

export const getTransformedRect = getSharedTransformedRect;

export function getCenter(rect: Rect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function snapRectToFrame(
  rect: Rect,
  frame: Size,
  thresholdPx: number,
): { rect: Rect; guides: SnapGuides } {
  const nextRect = { ...rect };
  const guides: SnapGuides = { vertical: [], horizontal: [] };
  const center = getCenter(nextRect);

  if (Math.abs(center.x - frame.width / 2) <= thresholdPx) {
    nextRect.x += frame.width / 2 - center.x;
    guides.vertical.push(frame.width / 2);
  }
  if (Math.abs(center.y - frame.height / 2) <= thresholdPx) {
    nextRect.y += frame.height / 2 - center.y;
    guides.horizontal.push(frame.height / 2);
  }
  if (Math.abs(nextRect.x) <= thresholdPx) {
    nextRect.x = 0;
    guides.vertical.push(0);
  }
  if (Math.abs(nextRect.x + nextRect.width - frame.width) <= thresholdPx) {
    nextRect.x = frame.width - nextRect.width;
    guides.vertical.push(frame.width);
  }
  if (Math.abs(nextRect.y) <= thresholdPx) {
    nextRect.y = 0;
    guides.horizontal.push(0);
  }
  if (Math.abs(nextRect.y + nextRect.height - frame.height) <= thresholdPx) {
    nextRect.y = frame.height - nextRect.height;
    guides.horizontal.push(frame.height);
  }

  return { rect: nextRect, guides };
}
