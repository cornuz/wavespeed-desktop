/**
 * Clips repository — CRUD operations on the `clips` table within a project DB.
 */
import { v4 as uuid } from "uuid";
import { getProjectDatabase, persistProjectDatabase } from "./connection";
import {
  applyLegacyFilterInputsToAdjustmentPatch,
  createDefaultClipAdjustments,
  getClipAdjustmentFilterValues,
  mergeClipAdjustments,
  normalizeClipAdjustments,
} from "../../../src/composer/shared/clipAdjustments";
import type {
  Clip,
  ClipAdjustmentsPatch,
  SourceType,
} from "../../../src/composer/types/project";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseStoredAdjustments(value: unknown): Clip["adjustments"] {
  if (typeof value !== "string" || value.length === 0) {
    return createDefaultClipAdjustments();
  }

  try {
    return normalizeClipAdjustments(
      JSON.parse(value) as Partial<Clip["adjustments"]>,
    );
  } catch {
    return createDefaultClipAdjustments();
  }
}

function ensureClipFlipColumns(projectId: string): void {
  const db = getProjectDatabase(projectId);
  if (!db) {
    throw new Error(`Project ${projectId} is not open`);
  }

  const info = db.exec(`PRAGMA table_info(clips)`);
  const columns = new Set(
    (info[0]?.values ?? []).map((row) => row[1] as string),
  );
  let didAlter = false;

  if (!columns.has("flip_horizontal")) {
    db.run(
      `ALTER TABLE clips ADD COLUMN flip_horizontal INTEGER NOT NULL DEFAULT 0`,
    );
    didAlter = true;
  }
  if (!columns.has("flip_vertical")) {
    db.run(
      `ALTER TABLE clips ADD COLUMN flip_vertical INTEGER NOT NULL DEFAULT 0`,
    );
    didAlter = true;
  }
  if (!columns.has("lut_proxy_path")) {
    db.run(`ALTER TABLE clips ADD COLUMN lut_proxy_path TEXT`);
    didAlter = true;
  }
  if (!columns.has("derived_media_id")) {
    db.run(
      `ALTER TABLE clips ADD COLUMN derived_media_id TEXT REFERENCES derived_media(id)`,
    );
    didAlter = true;
  }
  if (!columns.has("volume")) {
    db.run(`ALTER TABLE clips ADD COLUMN volume REAL NOT NULL DEFAULT 1`);
    didAlter = true;
  }

  if (didAlter) {
    persistProjectDatabase(projectId);
  }
}

function rowToClip(row: unknown[]): Clip {
  const adjustments = parseStoredAdjustments(row[20]);
  const filterValues = getClipAdjustmentFilterValues(adjustments);
  return {
    id: row[0] as string,
    trackId: row[1] as string,
    sourceType: row[2] as SourceType,
    sourcePath: (row[3] as string | null) ?? null,
    sourceAssetId: (row[4] as string | null) ?? null,
    startTime: row[5] as number,
    duration: row[6] as number,
    trimStart: row[7] as number,
    trimEnd: (row[8] as number | null) ?? null,
    speed: row[9] as number,
    transformOffsetX: row[10] as number,
    transformOffsetY: row[11] as number,
    transformScale: row[12] as number,
    flipHorizontal: Boolean(row[13]),
    flipVertical: Boolean(row[14]),
    rotationZ: (row[15] as number | null) ?? 0,
    opacity: (row[16] as number | null) ?? 1,
    volume: (row[17] as number | null) ?? 1,
    fadeInDuration: (row[18] as number | null) ?? 0,
    fadeOutDuration: (row[19] as number | null) ?? 0,
    brightness: filterValues.brightness,
    contrast: filterValues.contrast,
    saturation: filterValues.saturation,
    adjustments,
    derivedMediaId: (row[21] as string | null) ?? null,
    lutProxyPath: (row[22] as string | null) ?? null,
    createdAt: row[23] as string,
  };
}

const SELECT_COLUMNS = `
  id, track_id, source_type, source_path, source_asset_id,
  start_time, duration, trim_start, trim_end, speed,
  transform_offset_x, transform_offset_y, transform_scale,
  flip_horizontal, flip_vertical, rotation_z, opacity, volume,
  fade_in_duration, fade_out_duration, adjustments_json, derived_media_id, lut_proxy_path, created_at
`;

// ─── Queries ──────────────────────────────────────────────────────────────────

export function listClips(projectId: string): Clip[] {
  ensureClipFlipColumns(projectId);
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const result = db.exec(
    `SELECT ${SELECT_COLUMNS} FROM clips ORDER BY start_time ASC`,
  );
  return (result[0]?.values ?? []).map(rowToClip);
}

export function listClipsByTrack(projectId: string, trackId: string): Clip[] {
  ensureClipFlipColumns(projectId);
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const result = db.exec(
    `SELECT ${SELECT_COLUMNS} FROM clips WHERE track_id = ? ORDER BY start_time ASC`,
    [trackId],
  );
  return (result[0]?.values ?? []).map(rowToClip);
}

export function createClip(
  projectId: string,
  input: {
    id?: string;
    trackId: string;
    sourceType: SourceType;
    sourcePath: string | null;
    sourceAssetId: string | null;
    startTime: number;
    duration: number;
    trimStart?: number;
    trimEnd?: number | null;
    speed?: number;
    transformOffsetX?: number;
    transformOffsetY?: number;
    transformScale?: number;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
    rotationZ?: number;
    opacity?: number;
    volume?: number;
    brightness?: number;
    contrast?: number;
    saturation?: number;
    derivedMediaId?: string | null;
    lutProxyPath?: string | null;
    adjustments?: ClipAdjustmentsPatch;
    fadeInDuration?: number;
    fadeOutDuration?: number;
    createdAt?: string;
  },
): Clip {
  ensureClipFlipColumns(projectId);
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const id = input.id ?? uuid();
  const now = input.createdAt ?? new Date().toISOString();
  const trimStart = input.trimStart ?? 0;
  const trimEnd = input.trimEnd ?? null;
  const speed = input.speed ?? 1.0;
  const transformOffsetX = input.transformOffsetX ?? 0;
  const transformOffsetY = input.transformOffsetY ?? 0;
  const transformScale = input.transformScale ?? 1;
  const flipHorizontal = input.flipHorizontal ?? false;
  const flipVertical = input.flipVertical ?? false;
  const rotationZ = input.rotationZ ?? 0;
  const opacity = input.opacity ?? 1;
  const volume = input.volume ?? 1;
  const derivedMediaId = input.derivedMediaId ?? null;
  const lutProxyPath = input.lutProxyPath ?? null;
  const fadeInDuration = input.fadeInDuration ?? 0;
  const fadeOutDuration = input.fadeOutDuration ?? 0;
  const adjustments = mergeClipAdjustments(
    createDefaultClipAdjustments(),
    applyLegacyFilterInputsToAdjustmentPatch({
      brightness: input.brightness,
      contrast: input.contrast,
      saturation: input.saturation,
      adjustments: input.adjustments,
    }),
  );
  const filterValues = getClipAdjustmentFilterValues(adjustments);

  db.run(
    `INSERT INTO clips
        (id, track_id, source_type, source_path, source_asset_id,
          start_time, duration, trim_start, trim_end, speed,
          transform_offset_x, transform_offset_y, transform_scale,
          flip_horizontal, flip_vertical, rotation_z, opacity, volume, fade_in_duration, fade_out_duration, adjustments_json, derived_media_id, lut_proxy_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.trackId,
      input.sourceType,
      input.sourcePath,
      input.sourceAssetId,
      input.startTime,
      input.duration,
      trimStart,
      trimEnd,
      speed,
      transformOffsetX,
      transformOffsetY,
      transformScale,
      Number(flipHorizontal),
      Number(flipVertical),
      rotationZ,
      opacity,
      volume,
      fadeInDuration,
      fadeOutDuration,
      JSON.stringify(adjustments),
      derivedMediaId,
      lutProxyPath,
      now,
    ],
  );
  persistProjectDatabase(projectId);

  return {
    id,
    trackId: input.trackId,
    sourceType: input.sourceType,
    sourcePath: input.sourcePath,
    sourceAssetId: input.sourceAssetId,
    startTime: input.startTime,
    duration: input.duration,
    trimStart,
    trimEnd,
    speed,
    transformOffsetX,
    transformOffsetY,
    transformScale,
    flipHorizontal,
    flipVertical,
    rotationZ,
    opacity,
    volume,
    brightness: filterValues.brightness,
    contrast: filterValues.contrast,
    saturation: filterValues.saturation,
    fadeInDuration,
    fadeOutDuration,
    adjustments,
    derivedMediaId,
    lutProxyPath,
    createdAt: now,
  };
}

export function updateClip(
  projectId: string,
  clipId: string,
  patch: Partial<
    Pick<
      Clip,
      | "startTime"
      | "duration"
      | "trimStart"
      | "trimEnd"
      | "speed"
      | "trackId"
      | "transformOffsetX"
      | "transformOffsetY"
      | "transformScale"
      | "flipHorizontal"
      | "flipVertical"
      | "rotationZ"
      | "opacity"
      | "volume"
      | "brightness"
      | "contrast"
      | "saturation"
      | "derivedMediaId"
      | "lutProxyPath"
      | "fadeInDuration"
      | "fadeOutDuration"
    >
  > & {
    adjustments?: ClipAdjustmentsPatch;
  },
): Clip {
  ensureClipFlipColumns(projectId);
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.startTime !== undefined) {
    fields.push("start_time = ?");
    values.push(patch.startTime);
  }
  if (patch.duration !== undefined) {
    fields.push("duration = ?");
    values.push(patch.duration);
  }
  if (patch.trimStart !== undefined) {
    fields.push("trim_start = ?");
    values.push(patch.trimStart);
  }
  if ("trimEnd" in patch) {
    fields.push("trim_end = ?");
    values.push(patch.trimEnd ?? null);
  }
  if (patch.speed !== undefined) {
    fields.push("speed = ?");
    values.push(patch.speed);
  }
  if (patch.trackId !== undefined) {
    fields.push("track_id = ?");
    values.push(patch.trackId);
  }
  if (patch.transformOffsetX !== undefined) {
    fields.push("transform_offset_x = ?");
    values.push(patch.transformOffsetX);
  }
  if (patch.transformOffsetY !== undefined) {
    fields.push("transform_offset_y = ?");
    values.push(patch.transformOffsetY);
  }
  if (patch.transformScale !== undefined) {
    fields.push("transform_scale = ?");
    values.push(patch.transformScale);
  }
  if (patch.flipHorizontal !== undefined) {
    fields.push("flip_horizontal = ?");
    values.push(Number(patch.flipHorizontal));
  }
  if (patch.flipVertical !== undefined) {
    fields.push("flip_vertical = ?");
    values.push(Number(patch.flipVertical));
  }
  if (patch.rotationZ !== undefined) {
    fields.push("rotation_z = ?");
    values.push(patch.rotationZ);
  }
  if (patch.opacity !== undefined) {
    fields.push("opacity = ?");
    values.push(patch.opacity);
  }
  if (patch.volume !== undefined) {
    fields.push("volume = ?");
    values.push(patch.volume);
  }
  if ("derivedMediaId" in patch) {
    fields.push("derived_media_id = ?");
    values.push(patch.derivedMediaId ?? null);
  }
  if ("lutProxyPath" in patch) {
    fields.push("lut_proxy_path = ?");
    values.push(patch.lutProxyPath ?? null);
  }
  if (patch.fadeInDuration !== undefined) {
    fields.push("fade_in_duration = ?");
    values.push(patch.fadeInDuration);
  }
  if (patch.fadeOutDuration !== undefined) {
    fields.push("fade_out_duration = ?");
    values.push(patch.fadeOutDuration);
  }
  if (
    patch.adjustments !== undefined ||
    patch.brightness !== undefined ||
    patch.contrast !== undefined ||
    patch.saturation !== undefined
  ) {
    const current = getClipById(projectId, clipId);
    const adjustmentsPatch: ClipAdjustmentsPatch | undefined =
      applyLegacyFilterInputsToAdjustmentPatch({
        brightness: patch.brightness,
        contrast: patch.contrast,
        saturation: patch.saturation,
        adjustments: patch.adjustments,
      });
    fields.push("adjustments_json = ?");
    values.push(
      JSON.stringify(
        mergeClipAdjustments(current.adjustments, adjustmentsPatch),
      ),
    );
  }

  if (fields.length > 0) {
    values.push(clipId);
    db.run(`UPDATE clips SET ${fields.join(", ")} WHERE id = ?`, values);
    persistProjectDatabase(projectId);
  }

  return getClipById(projectId, clipId);
}

export function deleteClip(projectId: string, clipId: string): void {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  db.run(`DELETE FROM clips WHERE id = ?`, [clipId]);
  persistProjectDatabase(projectId);
}

export function getClipById(projectId: string, clipId: string): Clip {
  ensureClipFlipColumns(projectId);
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const result = db.exec(
    `SELECT ${SELECT_COLUMNS} FROM clips WHERE id = ? LIMIT 1`,
    [clipId],
  );
  const row = result[0]?.values?.[0];
  if (!row) throw new Error(`Clip ${clipId} not found`);
  return rowToClip(row);
}
