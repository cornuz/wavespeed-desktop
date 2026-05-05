import {
  getUniversalClipRect,
  universalRectToScreen,
  type Rect,
  type Size,
  type UniversalRect,
} from "../../shared/compositionGeometry";

export type { Rect, Size, UniversalRect } from "../../shared/compositionGeometry";
export { getUniversalClipRect, universalRectToScreen, screenPointToUniversal, rotatePointYUpCW } from "../../shared/compositionGeometry";

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

/**
 * Snaps a universal rect to frame guides.
 * Guides are returned in universal coordinates.
 */
export function snapRectToFrame(
  uRect: UniversalRect,
  projectSize: Size,
  thresholdPx: number,
): { uRect: UniversalRect; guides: SnapGuides } {
  const nextRect = { ...uRect };
  const guides: SnapGuides = { vertical: [], horizontal: [] };

  // Snap center X to frame center (0)
  if (Math.abs(nextRect.centerX) <= thresholdPx) {
    nextRect.centerX = 0;
    guides.vertical.push(0);
  }

  // Snap center Y to frame center (0)
  if (Math.abs(nextRect.centerY) <= thresholdPx) {
    nextRect.centerY = 0;
    guides.horizontal.push(0);
  }

  const halfW = projectSize.width / 2;
  const halfH = projectSize.height / 2;

  // Snap left edge to left frame edge (-W/2)
  const leftEdge = nextRect.centerX - nextRect.width / 2;
  if (Math.abs(leftEdge + halfW) <= thresholdPx) {
    nextRect.centerX = -halfW + nextRect.width / 2;
    guides.vertical.push(-halfW);
  }

  // Snap right edge to right frame edge (+W/2)
  const rightEdge = nextRect.centerX + nextRect.width / 2;
  if (Math.abs(rightEdge - halfW) <= thresholdPx) {
    nextRect.centerX = halfW - nextRect.width / 2;
    guides.vertical.push(halfW);
  }

  // Snap top edge to top frame edge (+H/2)
  const topEdge = nextRect.centerY + nextRect.height / 2;
  if (Math.abs(topEdge - halfH) <= thresholdPx) {
    nextRect.centerY = halfH - nextRect.height / 2;
    guides.horizontal.push(halfH);
  }

  // Snap bottom edge to bottom frame edge (-H/2)
  const bottomEdge = nextRect.centerY - nextRect.height / 2;
  if (Math.abs(bottomEdge + halfH) <= thresholdPx) {
    nextRect.centerY = -halfH + nextRect.height / 2;
    guides.horizontal.push(-halfH);
  }

  return { uRect: nextRect, guides };
}

export function getCenter(rect: Rect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}
