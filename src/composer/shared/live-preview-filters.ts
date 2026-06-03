import { normalizeClipAdjustments } from "./clipAdjustments";
import { buildCssFilter } from "./filter-builder";
import type { ClipAdjustments } from "../types/project";

const SHARPEN_EPSILON = 0.0001;

function formatKernelValue(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function buildSharpenKernelMatrix(sharpen: number): string {
  const strength = Math.min(2, Math.max(0, sharpen / 100));
  const edge = formatKernelValue(-strength);
  const center = formatKernelValue(1 + strength * 4);

  return `0 ${edge} 0 ${edge} ${center} ${edge} 0 ${edge} 0`;
}

export interface LivePreviewSharpenFilterDefinition {
  filterId: string;
  kernelMatrix: string;
}

export interface LivePreviewFilterSpec {
  filter: string | undefined;
  sharpenFilter: LivePreviewSharpenFilterDefinition | undefined;
}

export function buildLivePreviewFilterSpec(
  adjustments: Partial<ClipAdjustments> | null | undefined,
  sharpenFilterId?: string,
): LivePreviewFilterSpec {
  const cssFilter = buildCssFilter(adjustments);
  const normalized = normalizeClipAdjustments(adjustments);
  const sharpenFilter =
    sharpenFilterId && normalized.effects.sharpen > SHARPEN_EPSILON
      ? {
          filterId: sharpenFilterId,
          kernelMatrix: buildSharpenKernelMatrix(normalized.effects.sharpen),
        }
      : undefined;

  const filters = [
    sharpenFilter ? `url(#${sharpenFilter.filterId})` : null,
    cssFilter !== "none" ? cssFilter : null,
  ].filter((value): value is string => value != null);

  return {
    filter: filters.length > 0 ? filters.join(" ") : undefined,
    sharpenFilter,
  };
}
