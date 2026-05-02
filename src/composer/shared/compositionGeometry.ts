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

export interface ClipTransformLike {
  transformOffsetX: number;
  transformOffsetY: number;
  transformScale: number;
}

export function getProjectScaledRect(
  media: Size,
  frame: Size,
  project: Size,
): Rect {
  const width = media.width * (frame.width / project.width);
  const height = media.height * (frame.height / project.height);
  return {
    x: (frame.width - width) / 2,
    y: (frame.height - height) / 2,
    width,
    height,
  };
}

export function getTransformedRect(
  baseRect: Rect,
  frame: Size,
  transformOffsetX: number,
  transformOffsetY: number,
  transformScale: number,
): Rect {
  const width = baseRect.width * transformScale;
  const height = baseRect.height * transformScale;
  const centerX = baseRect.x + baseRect.width / 2 + transformOffsetX * frame.width;
  const centerY = baseRect.y + baseRect.height / 2 + transformOffsetY * frame.height;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  };
}

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
