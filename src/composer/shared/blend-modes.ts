import type { ClipBlendMode } from "../types/project";

const CANVAS_BLEND_MODE_MAP: Record<ClipBlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  "soft-light": "soft-light",
  darken: "darken",
  lighten: "lighten",
};

export function getCanvasBlendMode(
  mode: ClipBlendMode,
): GlobalCompositeOperation {
  return CANVAS_BLEND_MODE_MAP[mode];
}
