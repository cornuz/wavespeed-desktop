import { normalizeClipAdjustments } from "./clipAdjustments";
import type { ClipAdjustments } from "../types/project";

const FILTER_EPSILON = 0.0001;

export function buildCssFilter(
  adjustments: Partial<ClipAdjustments> | null | undefined,
): string {
  const normalized = normalizeClipAdjustments(adjustments);
  const brightness = Math.max(
    0,
    1 + normalized.lightnessCorrection.exposure / 100,
  );
  const contrast = Math.max(
    0,
    1 + normalized.lightnessCorrection.contrast / 100,
  );
  const saturation = Math.max(
    0,
    1 + normalized.colorCorrection.saturation / 100,
  );
  const blur = Math.min(Math.max(normalized.effects.blur, 0), 50);
  const filters = [
    Math.abs(brightness - 1) > FILTER_EPSILON
      ? `brightness(${brightness})`
      : null,
    Math.abs(contrast - 1) > FILTER_EPSILON ? `contrast(${contrast})` : null,
    Math.abs(saturation - 1) > FILTER_EPSILON
      ? `saturate(${saturation})`
      : null,
    Math.abs(normalized.colorCorrection.hue) > 0.1
      ? `hue-rotate(${normalized.colorCorrection.hue * 1.8}deg)`
      : null,
    blur > FILTER_EPSILON ? `blur(${blur}px)` : null,
  ].filter((value): value is string => value != null);

  return filters.length > 0 ? filters.join(" ") : "none";
}
