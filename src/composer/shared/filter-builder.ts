import { getClipAdjustmentFilterValues } from "./clipAdjustments";
import type { ClipAdjustments } from "../types/project";

const FILTER_EPSILON = 0.0001;

function formatFilterNumber(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

export function buildCssFilter(
  adjustments: Partial<ClipAdjustments> | null | undefined,
): string {
  const filterValues = getClipAdjustmentFilterValues(adjustments);
  const filters = [
    Math.abs(filterValues.brightness - 1) > FILTER_EPSILON
      ? `brightness(${formatFilterNumber(filterValues.brightness)})`
      : null,
    Math.abs(filterValues.contrast - 1) > FILTER_EPSILON
      ? `contrast(${formatFilterNumber(filterValues.contrast)})`
      : null,
    Math.abs(filterValues.saturation - 1) > FILTER_EPSILON
      ? `saturate(${formatFilterNumber(filterValues.saturation)})`
      : null,
    Math.abs(filterValues.hueDegrees) > 0.1
      ? `hue-rotate(${formatFilterNumber(filterValues.hueDegrees)}deg)`
      : null,
    filterValues.blurPx > FILTER_EPSILON
      ? `blur(${formatFilterNumber(filterValues.blurPx)}px)`
      : null,
  ].filter((value): value is string => value != null);

  return filters.length > 0 ? filters.join(" ") : "none";
}
