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
];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeBlendMode(value: unknown): ClipBlendMode {
  return typeof value === "string" &&
    SUPPORTED_BLEND_MODES.includes(value as ClipBlendMode)
    ? (value as ClipBlendMode)
    : "normal";
}

function normalizeNumericRecord<
  T extends Record<string, number>,
>(
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
      contrast: 0,
      highlights: 0,
      shadows: 0,
    },
    effects: {
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
    colorCorrection: normalizeNumericRecord(
      defaults.colorCorrection,
      value?.colorCorrection,
      -100,
      100,
    ),
    lightnessCorrection: normalizeNumericRecord(
      defaults.lightnessCorrection,
      value?.lightnessCorrection,
      -100,
      100,
    ),
    effects: normalizeNumericRecord(defaults.effects, value?.effects, 0, 100),
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
