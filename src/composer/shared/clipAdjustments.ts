import type {
  ClipAdjustments,
  ClipAdjustmentsPatch,
  ClipBlendMode,
} from "../types/project";

const SUPPORTED_BLEND_MODES: readonly ClipBlendMode[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function roundFilterValue(value: number): number {
  return Number(value.toFixed(6));
}

function normalizeBlendMode(value: unknown): ClipBlendMode {
  return typeof value === "string" &&
    SUPPORTED_BLEND_MODES.includes(value as ClipBlendMode)
    ? (value as ClipBlendMode)
    : "normal";
}

function normalizeNumericRecord<T extends Record<string, number>>(
  defaults: T,
  value: Partial<T> | undefined,
  min: number,
  max: number,
): T {
  const normalized = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const nextValue = value?.[key];
    normalized[key] =
      typeof nextValue === "number"
        ? clamp(nextValue, min, max)
        : defaults[key];
  }
  return normalized;
}

export function createDefaultClipAdjustments(): ClipAdjustments {
  return {
    blendMode: "normal",
    lutAssetId: null,
    colorCorrection: {
      temperature: 0,
      tint: 0,
      hue: 0,
      saturation: 0,
    },
    lightnessCorrection: {
      exposure: 0,
      gain: 0,
      gamma: 0,
      offset: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
    },
    effects: {
      blur: 0,
      sharpen: 0,
      noise: 0,
      vignette: 0,
    },
  };
}

export function normalizeClipAdjustments(
  value: Partial<ClipAdjustments> | null | undefined,
): ClipAdjustments {
  const defaults = createDefaultClipAdjustments();
  return {
    blendMode: normalizeBlendMode(value?.blendMode),
    lutAssetId:
      typeof value?.lutAssetId === "string" && value.lutAssetId.length > 0
        ? value.lutAssetId
        : null,
    colorCorrection: {
      temperature: clamp(
        value?.colorCorrection?.temperature ?? defaults.colorCorrection.temperature,
        -100,
        100,
      ),
      tint: clamp(value?.colorCorrection?.tint ?? defaults.colorCorrection.tint, -100, 100),
      hue: clamp(value?.colorCorrection?.hue ?? defaults.colorCorrection.hue, -180, 180),
      saturation: clamp(
        value?.colorCorrection?.saturation ?? defaults.colorCorrection.saturation,
        -100,
        100,
      ),
    },
    lightnessCorrection: normalizeNumericRecord(
      defaults.lightnessCorrection,
      value?.lightnessCorrection,
      -100,
      100,
    ),
    effects: {
      blur: clamp(value?.effects?.blur ?? defaults.effects.blur, 0, 50),
      sharpen: clamp(
        value?.effects?.sharpen ?? defaults.effects.sharpen,
        0,
        200,
      ),
      noise: clamp(value?.effects?.noise ?? defaults.effects.noise, 0, 100),
      vignette: clamp(
        value?.effects?.vignette ?? defaults.effects.vignette,
        0,
        100,
      ),
    },
  };
}

function toApproximateFilterMultiplier(value: number): number {
  return Math.max(0, 1 + value / 100);
}

function sumApproximateFilterInputs(...values: number[]): number {
  return values.reduce(
    (total, value) => total + (Number.isFinite(value) ? value : 0),
    0,
  );
}

export interface ClipAdjustmentFilterValues {
  brightness: number;
  contrast: number;
  saturation: number;
  hueDegrees: number;
  blurPx: number;
}

export function getClipAdjustmentFilterValues(
  adjustments: Partial<ClipAdjustments> | null | undefined,
): ClipAdjustmentFilterValues {
  const normalized = normalizeClipAdjustments(adjustments);
  const brightnessLikeCorrection = sumApproximateFilterInputs(
    normalized.lightnessCorrection.exposure,
    normalized.lightnessCorrection.gain,
    normalized.lightnessCorrection.offset,
  );
  const contrastLikeCorrection = sumApproximateFilterInputs(
    normalized.lightnessCorrection.contrast,
    normalized.lightnessCorrection.gamma,
  );

  return {
    brightness: roundFilterValue(
      toApproximateFilterMultiplier(brightnessLikeCorrection),
    ),
    contrast: roundFilterValue(
      toApproximateFilterMultiplier(contrastLikeCorrection),
    ),
    saturation: roundFilterValue(
      toApproximateFilterMultiplier(normalized.colorCorrection.saturation),
    ),
    hueDegrees: roundFilterValue(normalized.colorCorrection.hue),
    blurPx: roundFilterValue(clamp(normalized.effects.blur, 0, 50)),
  };
}

export function applyLegacyFilterInputsToAdjustmentPatch(input: {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  adjustments?: ClipAdjustmentsPatch;
}): ClipAdjustmentsPatch | undefined {
  const hasLegacyOverrides =
    input.brightness !== undefined ||
    input.contrast !== undefined ||
    input.saturation !== undefined;

  if (!hasLegacyOverrides) {
    return input.adjustments;
  }

  return {
    ...(input.adjustments ?? {}),
    ...(input.brightness !== undefined || input.contrast !== undefined
      ? {
          lightnessCorrection: {
            ...(input.adjustments?.lightnessCorrection ?? {}),
            ...(input.brightness !== undefined
              ? { exposure: (input.brightness - 1) * 100 }
              : {}),
            ...(input.contrast !== undefined
              ? { contrast: (input.contrast - 1) * 100 }
              : {}),
          },
        }
      : {}),
    ...(input.saturation !== undefined
      ? {
          colorCorrection: {
            ...(input.adjustments?.colorCorrection ?? {}),
            saturation: (input.saturation - 1) * 100,
          },
        }
      : {}),
  };
}

export function mergeClipAdjustments(
  current: ClipAdjustments,
  patch: ClipAdjustmentsPatch | undefined,
): ClipAdjustments {
  if (!patch) {
    return normalizeClipAdjustments(current);
  }

  return normalizeClipAdjustments({
    ...current,
    ...patch,
    colorCorrection: {
      ...current.colorCorrection,
      ...patch.colorCorrection,
    },
    lightnessCorrection: {
      ...current.lightnessCorrection,
      ...patch.lightnessCorrection,
    },
    effects: {
      ...current.effects,
      ...patch.effects,
    },
  });
}
