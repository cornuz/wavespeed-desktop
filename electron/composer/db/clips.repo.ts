/**
 * Clips repository — CRUD operations on the `clips` table within a project DB.
 */
import { v4 as uuid } from "uuid";
import { getProjectDatabase, persistProjectDatabase } from "./connection";
import {
  createDefaultClipAdjustments,
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

function getLegacyBrightness(adjustments: Clip["adjustments"]): number {
  return 1 + adjustments.lightnessCorrection.exposure / 100;
}

function getLegacyContrast(adjustments: Clip["adjustments"]): number {
  return 1 + adjustments.lightnessCorrection.contrast / 100;
}

function getLegacySaturation(adjustments: Clip["adjustments"]): number {
  return 1 + adjustments.colorCorrection.saturation / 100;
}

function rowToClip(row: unknown[]): Clip {
  const adjustments = parseStoredAdjustments(row[17]);
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
    rotationZ: (row[13] as number | null) ?? 0,
    opacity: (row[14] as number | null) ?? 1,
    fadeInDuration: (row[15] as number | null) ?? 0,
    fadeOutDuration: (row[16] as number | null) ?? 0,
    brightness: getLegacyBrightness(adjustments),
    contrast: getLegacyContrast(adjustments),
    saturation: getLegacySaturation(adjustments),
    adjustments,
    createdAt: row[18] as string,
  };
}

const SELECT_COLUMNS = `
  id, track_id, source_type, source_path, source_asset_id,
  start_time, duration, trim_start, trim_end, speed,
  transform_offset_x, transform_offset_y, transform_scale,
  rotation_z, opacity, fade_in_duration, fade_out_duration, adjustments_json, created_at
`;

// ─── Queries ──────────────────────────────────────────────────────────────────

export function listClips(projectId: string): Clip[] {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const result = db.exec(
    `SELECT ${SELECT_COLUMNS} FROM clips ORDER BY start_time ASC`,
  );
  return (result[0]?.values ?? []).map(rowToClip);
}

export function listClipsByTrack(projectId: string, trackId: string): Clip[] {
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
      rotationZ?: number;
      opacity?: number;
      brightness?: number;
      contrast?: number;
      saturation?: number;
      adjustments?: ClipAdjustmentsPatch;
      fadeInDuration?: number;
      fadeOutDuration?: number;
      createdAt?: string;
  },
): Clip {
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
  const rotationZ = input.rotationZ ?? 0;
  const opacity = input.opacity ?? 1;
  const fadeInDuration = input.fadeInDuration ?? 0;
  const fadeOutDuration = input.fadeOutDuration ?? 0;
  const adjustments = mergeClipAdjustments(createDefaultClipAdjustments(), {
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
  });

  db.run(
    `INSERT INTO clips
       (id, track_id, source_type, source_path, source_asset_id,
         start_time, duration, trim_start, trim_end, speed,
         transform_offset_x, transform_offset_y, transform_scale,
         rotation_z, opacity, fade_in_duration, fade_out_duration, adjustments_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      rotationZ,
      opacity,
      fadeInDuration,
      fadeOutDuration,
      JSON.stringify(adjustments),
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
    rotationZ,
    opacity,
    brightness: getLegacyBrightness(adjustments),
    contrast: getLegacyContrast(adjustments),
    saturation: getLegacySaturation(adjustments),
    fadeInDuration,
    fadeOutDuration,
    adjustments,
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
      | "rotationZ"
      | "opacity"
      | "brightness"
      | "contrast"
      | "saturation"
      | "fadeInDuration"
      | "fadeOutDuration"
    >
  > & {
    adjustments?: ClipAdjustmentsPatch;
  },
): Clip {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.startTime !== undefined) { fields.push("start_time = ?"); values.push(patch.startTime); }
  if (patch.duration !== undefined) { fields.push("duration = ?"); values.push(patch.duration); }
  if (patch.trimStart !== undefined) { fields.push("trim_start = ?"); values.push(patch.trimStart); }
  if ("trimEnd" in patch) { fields.push("trim_end = ?"); values.push(patch.trimEnd ?? null); }
  if (patch.speed !== undefined) { fields.push("speed = ?"); values.push(patch.speed); }
  if (patch.trackId !== undefined) { fields.push("track_id = ?"); values.push(patch.trackId); }
  if (patch.transformOffsetX !== undefined) { fields.push("transform_offset_x = ?"); values.push(patch.transformOffsetX); }
  if (patch.transformOffsetY !== undefined) { fields.push("transform_offset_y = ?"); values.push(patch.transformOffsetY); }
  if (patch.transformScale !== undefined) { fields.push("transform_scale = ?"); values.push(patch.transformScale); }
  if (patch.rotationZ !== undefined) { fields.push("rotation_z = ?"); values.push(patch.rotationZ); }
  if (patch.opacity !== undefined) { fields.push("opacity = ?"); values.push(patch.opacity); }
  if (patch.fadeInDuration !== undefined) { fields.push("fade_in_duration = ?"); values.push(patch.fadeInDuration); }
  if (patch.fadeOutDuration !== undefined) { fields.push("fade_out_duration = ?"); values.push(patch.fadeOutDuration); }
  if (
    patch.adjustments !== undefined ||
    patch.brightness !== undefined ||
    patch.contrast !== undefined ||
    patch.saturation !== undefined
  ) {
    const current = getClipById(projectId, clipId);
    const adjustmentsPatch: ClipAdjustmentsPatch = {
      ...(patch.adjustments ?? {}),
      ...(patch.brightness !== undefined || patch.contrast !== undefined
        ? {
            lightnessCorrection: {
              ...(patch.adjustments?.lightnessCorrection ?? {}),
              ...(patch.brightness !== undefined
                ? { exposure: (patch.brightness - 1) * 100 }
                : {}),
              ...(patch.contrast !== undefined
                ? { contrast: (patch.contrast - 1) * 100 }
                : {}),
            },
          }
        : {}),
      ...(patch.saturation !== undefined
        ? {
            colorCorrection: {
              ...(patch.adjustments?.colorCorrection ?? {}),
              saturation: (patch.saturation - 1) * 100,
            },
          }
        : {}),
    };
    fields.push("adjustments_json = ?");
    values.push(
      JSON.stringify(mergeClipAdjustments(current.adjustments, adjustmentsPatch)),
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
