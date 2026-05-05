export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UniversalRect {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

export interface ClipTransformLike {
  transformOffsetX: number;
  transformOffsetY: number;
  transformScale: number;
}

/**
 * Computes a clip's position and size in universal coordinates.
 *
 * Universal space:
 *   - Origin (0, 0) = center of the project frame
 *   - +X = right, -X = left
 *   - +Y = up,   -Y = down
 *   - 1 unit = 1 pixel of original media resolution
 *
 * @param mediaSize   Original width/height of the media in pixels
 * @param offsetX     Horizontal offset from center in universal pixels
 * @param offsetY     Vertical offset from center in universal pixels (+Y = up)
 * @param scale       Scale multiplier (1.0 = original size)
 */
export function getUniversalClipRect(
  mediaSize: Size,
  offsetX: number,
  offsetY: number,
  scale: number,
): UniversalRect {
  return {
    centerX: offsetX,
    centerY: offsetY,
    width: mediaSize.width * scale,
    height: mediaSize.height * scale,
  };
}

/**
 * Converts a universal rect to screen-space Rect.
 *
 * Screen space:
 *   - Origin = top-left of the panel/output
 *   - +X = right, +Y = down
 *
 * @param uRect           Rect in universal coordinates
 * @param screenCenterX   Screen X coordinate of the universal origin
 * @param screenCenterY   Screen Y coordinate of the universal origin
 * @param viewScale       Scale factor (screen pixels per universal pixel)
 */
export function universalRectToScreen(
  uRect: UniversalRect,
  screenCenterX: number,
  screenCenterY: number,
  viewScale: number,
): Rect {
  const screenW = uRect.width * viewScale;
  const screenH = uRect.height * viewScale;
  const screenCX = screenCenterX + uRect.centerX * viewScale;
  const screenCY = screenCenterY - uRect.centerY * viewScale; // flip Y
  return {
    x: screenCX - screenW / 2,
    y: screenCY - screenH / 2,
    width: screenW,
    height: screenH,
  };
}

/**
 * Converts a screen point to universal coordinates.
 */
export function screenPointToUniversal(
  sx: number,
  sy: number,
  screenCenterX: number,
  screenCenterY: number,
  viewScale: number,
): { x: number; y: number } {
  return {
    x: (sx - screenCenterX) / viewScale,
    y: -(sy - screenCenterY) / viewScale, // flip Y
  };
}

/**
 * Rotates a point in universal space (y-up, clockwise positive).
 */
export function rotatePointYUpCW(
  point: { x: number; y: number },
  radians: number,
): { x: number; y: number } {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos + point.y * sin,
    y: -point.x * sin + point.y * cos,
  };
}

/**
 * @deprecated Kept for transition. Use getUniversalClipRect instead.
 */
export function getProjectScaledRect(
  media: Size,
  _frame: Size,
  _project: Size,
): Rect {
  return {
    x: -media.width / 2,
    y: -media.height / 2,
    width: media.width,
    height: media.height,
  };
}

/**
 * @deprecated Kept for transition. Use universalRectToScreen instead.
 */
export function getTransformedRect(
  baseRect: Rect,
  _frame: Size,
  transformOffsetX: number,
  transformOffsetY: number,
  transformScale: number,
): Rect {
  const width = baseRect.width * transformScale;
  const height = baseRect.height * transformScale;
  return {
    x: baseRect.x + baseRect.width / 2 + transformOffsetX - width / 2,
    y: baseRect.y + baseRect.height / 2 + transformOffsetY - height / 2,
    width,
    height,
  };
}

/**
 * @deprecated Kept for transition. Use getUniversalClipRect + universalRectToScreen instead.
 */
export function getComposedClipRect(
  media: Size,
  frame: Size,
  project: Size,
  transform: ClipTransformLike,
): Rect {
  return getTransformedRect(
    getProjectScaledRect(media, frame, project),
    frame,
    transform.transformOffsetX,
    transform.transformOffsetY,
    transform.transformScale,
  );
}
