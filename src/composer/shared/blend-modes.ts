import type { ClipBlendMode } from "../types/project";

const CANVAS_BLEND_MODE_MAP: Record<ClipBlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  "soft-light": "soft-light",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

export function getCanvasBlendMode(
  mode: ClipBlendMode,
): GlobalCompositeOperation {
  return CANVAS_BLEND_MODE_MAP[mode];
}
